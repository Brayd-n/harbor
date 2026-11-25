//! Code mode tools. The server asks; this side decides (via the local policy) and runs.

use crate::policy::{self, Policy};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::VecDeque;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const OUTPUT_CAP: usize = 30_000; // bytes kept from shell output: first and last 15 KB
const READ_MAX_BYTES: u64 = 2 * 1024 * 1024;
const DEFAULT_LINES: usize = 2000;
const MAX_MATCHES: usize = 300;

#[derive(Deserialize, Clone)]
pub struct ToolRequest {
    pub tool: String,
    pub input: Value,
    pub root: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Check {
    /// "auto" runs now, "ask" needs a click, "deny" never runs.
    pub decision: &'static str,
    pub reason: Option<String>,
    /// What the approval card shows: the exact command or file, the folder it runs in, the shell.
    pub cwd: String,
    pub shell: String,
    pub detail: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolResult {
    pub output: String,
    pub is_error: bool,
    pub decision: &'static str,
    pub exit_code: Option<i32>,
    pub duration_ms: u64,
}

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or("")
}

pub fn shell_name() -> &'static str {
    if cfg!(windows) { "pwsh" } else { "bash" }
}

/// Decides what a request needs. Run again inside `run`, so a stale or forged "approved" from the
/// UI can never turn a deny into a run.
pub fn check(policy: &Policy, req: &ToolRequest) -> Check {
    let mut c = Check { decision: "deny", reason: None, cwd: req.root.clone(), shell: shell_name().into(), detail: String::new() };
    let Some(root) = policy.workspace(&req.root) else {
        c.reason = Some("This folder isn't one you opened on this device.".into());
        return c;
    };
    c.cwd = dunce::simplified(&root).display().to_string();
    let path_of = |k: &str| policy::resolve(&root, s(&req.input, k));
    match req.tool.as_str() {
        "read_file" => match path_of("path") {
            Ok(p) => {
                c.detail = rel(&root, &p);
                c.decision = "auto";
            }
            Err(e) => c.reason = Some(e),
        },
        "glob" | "grep" => {
            c.detail = s(&req.input, "pattern").into();
            c.decision = "auto";
        }
        "edit_file" | "write_file" => match path_of("path") {
            Ok(p) => {
                c.detail = if req.tool == "edit_file" {
                    format!("{}\n--- old\n{}\n+++ new\n{}", rel(&root, &p), s(&req.input, "old_string"), s(&req.input, "new_string"))
                } else {
                    format!("{}\n{}", rel(&root, &p), s(&req.input, "content"))
                };
                c.decision = "ask";
            }
            Err(e) => c.reason = Some(e),
        },
        "shell" => {
            let cmd = s(&req.input, "command");
            c.detail = cmd.into();
            if let Some(why) = policy.command_denied(cmd) {
                c.reason = Some(format!("Blocked: {why}"));
            } else if policy.allow_commands.iter().any(|a| a == cmd) {
                c.decision = "auto";
            } else {
                c.decision = "ask";
            }
        }
        other => c.reason = Some(format!("Unknown tool {other}")),
    }
    c
}

pub fn run(policy: &Policy, req: &ToolRequest, approved: bool) -> ToolResult {
    let start = Instant::now();
    let c = check(policy, req);
    let decision = match (c.decision, approved) {
        ("auto", _) => "auto",
        ("ask", true) => "approved",
        ("ask", false) => "denied",
        _ => "policy_blocked",
    };
    let done = |output: String, is_error: bool, exit_code: Option<i32>| ToolResult {
        output,
        is_error,
        decision,
        exit_code,
        duration_ms: start.elapsed().as_millis() as u64,
    };
    match decision {
        "denied" => return done("The user declined this.".into(), true, None),
        "policy_blocked" => return done(c.reason.unwrap_or_else(|| "Blocked by the device policy.".into()), true, None),
        _ => {}
    }
    let root = policy.workspace(&req.root).expect("checked above");
    let i = &req.input;
    let r = match req.tool.as_str() {
        "read_file" => read_file(&root, s(i, "path"), i.get("offset").and_then(Value::as_u64), i.get("limit").and_then(Value::as_u64)),
        "edit_file" => edit_file(&root, s(i, "path"), s(i, "old_string"), s(i, "new_string"), i.get("replace_all").and_then(Value::as_bool).unwrap_or(false)),
        "write_file" => write_file(&root, s(i, "path"), s(i, "content")),
        "glob" => glob(&root, s(i, "pattern")),
        "grep" => grep(&root, s(i, "pattern"), i.get("glob").and_then(Value::as_str), i.get("ignore_case").and_then(Value::as_bool).unwrap_or(false)),
        "shell" => {
            let secs = i.get("timeout_s").and_then(Value::as_u64).unwrap_or(120).clamp(1, 600);
            let (out, code) = shell(&root, s(i, "command"), Duration::from_secs(secs));
            return done(out, code != Some(0), code);
        }
        _ => Err("unknown tool".into()),
    };
    match r {
        Ok(out) => done(out, false, None),
        Err(e) => done(e, true, None),
    }
}

fn rel(root: &Path, p: &Path) -> String {
    p.strip_prefix(root).unwrap_or(p).to_string_lossy().replace('\\', "/")
}

fn read_text(p: &Path) -> Result<String, String> {
    let meta = std::fs::metadata(p).map_err(|e| e.to_string())?;
    if meta.len() > READ_MAX_BYTES {
        return Err(format!("File is {} KB; read it with grep or by line range of a smaller copy.", meta.len() / 1024));
    }
    let bytes = std::fs::read(p).map_err(|e| e.to_string())?;
    if bytes.iter().take(8000).any(|b| *b == 0) {
        return Err("Binary file.".into());
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

fn read_file(root: &Path, path: &str, offset: Option<u64>, limit: Option<u64>) -> Result<String, String> {
    let p = policy::resolve(root, path)?;
    let text = read_text(&p)?;
    let lines: Vec<&str> = text.lines().collect();
    let from = offset.unwrap_or(1).max(1) as usize - 1;
    let n = limit.map(|l| l as usize).unwrap_or(DEFAULT_LINES);
    let to = (from + n).min(lines.len());
    if from >= lines.len() && !lines.is_empty() {
        return Err(format!("The file has {} lines.", lines.len()));
    }
    let body = lines[from.min(lines.len())..to].join("\n");
    if from == 0 && to == lines.len() {
        Ok(body)
    } else {
        Ok(format!("[lines {}-{} of {}]\n{}", from + 1, to, lines.len(), body))
    }
}

fn edit_file(root: &Path, path: &str, old: &str, new: &str, all: bool) -> Result<String, String> {
    let p = policy::resolve(root, path)?;
    let text = read_text(&p)?;
    let n = text.matches(old).count();
    if n == 0 {
        return Err("old_string was not found. Read the file again and copy the text exactly.".into());
    }
    if n > 1 && !all {
        return Err(format!("old_string appears {n} times. Include more surrounding text, or set replace_all."));
    }
    let out = if all { text.replace(old, new) } else { text.replacen(old, new, 1) };
    std::fs::write(&p, out).map_err(|e| e.to_string())?;
    Ok(format!("Edited {} ({} replacement{})", rel(root, &p), n, if n == 1 { "" } else { "s" }))
}

fn write_file(root: &Path, path: &str, content: &str) -> Result<String, String> {
    let p = policy::resolve(root, path)?;
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    // The folders just created are inside the checked path; check the final path once more.
    let p = policy::resolve(root, path)?;
    std::fs::write(&p, content).map_err(|e| e.to_string())?;
    Ok(format!("Wrote {} ({} bytes)", rel(root, &p), content.len()))
}

/// Files under root, honoring .gitignore, skipping .git, never leaving root (symlinks not followed).
fn walk(root: &Path) -> impl Iterator<Item = PathBuf> + '_ {
    ignore::WalkBuilder::new(root)
        .hidden(false)
        .require_git(false)
        .follow_links(false)
        .filter_entry(|e| e.file_name() != ".git")
        .build()
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_some_and(|t| t.is_file()))
        .map(|e| e.into_path())
        .filter(|p| policy::check_denied_dirs(p).is_ok())
}

fn matcher(pattern: &str) -> Result<globset::GlobMatcher, String> {
    globset::GlobBuilder::new(pattern).literal_separator(true).build().map(|g| g.compile_matcher()).map_err(|e| e.to_string())
}

fn glob(root: &Path, pattern: &str) -> Result<String, String> {
    let m = matcher(pattern)?;
    let mut out: Vec<String> = walk(root).map(|p| rel(root, &p)).filter(|r| m.is_match(r)).take(501).collect();
    out.sort();
    if out.len() > 500 {
        out.truncate(500);
        out.push("[more than 500 files; narrow the pattern]".into());
    }
    Ok(if out.is_empty() { "No files match.".into() } else { out.join("\n") })
}

fn grep(root: &Path, pattern: &str, glob_pat: Option<&str>, ignore_case: bool) -> Result<String, String> {
    let re = regex::RegexBuilder::new(pattern).case_insensitive(ignore_case).size_limit(1 << 20).build().map_err(|e| e.to_string())?;
    let filter = glob_pat.map(matcher).transpose()?;
    let mut out = Vec::new();
    for p in walk(root) {
        let r = rel(root, &p);
        if filter.as_ref().is_some_and(|m| !m.is_match(&r)) {
            continue;
        }
        let Ok(text) = read_text(&p) else { continue };
        for (n, line) in text.lines().enumerate() {
            if re.is_match(line) {
                let line: String = line.chars().take(300).collect();
                out.push(format!("{r}:{}: {line}", n + 1));
                if out.len() >= MAX_MATCHES {
                    out.push(format!("[stopped at {MAX_MATCHES} matches; narrow the pattern]"));
                    return Ok(out.join("\n"));
                }
            }
        }
    }
    Ok(if out.is_empty() { "No matches.".into() } else { out.join("\n") })
}

/// Keeps the first and last OUTPUT_CAP/2 bytes of a stream, whatever its size.
#[derive(Default)]
struct HeadTail {
    head: Vec<u8>,
    tail: VecDeque<u8>,
    total: usize,
}

impl HeadTail {
    fn push(&mut self, mut b: &[u8]) {
        self.total += b.len();
        let room = OUTPUT_CAP / 2 - self.head.len();
        let take = room.min(b.len());
        self.head.extend_from_slice(&b[..take]);
        b = &b[take..];
        self.tail.extend(b);
        while self.tail.len() > OUTPUT_CAP / 2 {
            self.tail.pop_front();
        }
    }
    fn text(&self) -> String {
        let mut s = String::from_utf8_lossy(&self.head).into_owned();
        let kept = self.head.len() + self.tail.len();
        if self.total > kept {
            s.push_str(&format!("\n… [{} bytes cut] …\n", self.total - kept));
        }
        s.push_str(&String::from_utf8_lossy(&self.tail.iter().copied().collect::<Vec<_>>()));
        s
    }
}

/// Runs a command in the device shell: `bash -c` on Linux, `pwsh -NoProfile -NonInteractive -Command`
/// on Windows (PowerShell 7 only). Times out by killing the whole process tree.
pub fn shell(root: &Path, cmd: &str, timeout: Duration) -> (String, Option<i32>) {
    let mut c = if cfg!(windows) {
        let mut c = Command::new("pwsh");
        c.args(["-NoProfile", "-NonInteractive", "-Command", cmd]);
        c
    } else {
        let mut c = Command::new("bash");
        c.args(["-c", cmd]);
        c
    };
    c.current_dir(dunce::simplified(root)).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        c.process_group(0); // its own group, so a timeout can kill everything it started
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = match c.spawn() {
        Ok(ch) => ch,
        Err(e) if cfg!(windows) && e.kind() == std::io::ErrorKind::NotFound => {
            return ("PowerShell 7 (pwsh) is not installed. Install it with: winget install Microsoft.PowerShell".into(), None)
        }
        Err(e) => return (format!("Could not start {}: {e}", shell_name()), None),
    };
    let buf = Arc::new(Mutex::new(HeadTail::default()));
    let readers: Vec<_> = [child.stdout.take().map(|o| Box::new(o) as Box<dyn Read + Send>), child.stderr.take().map(|e| Box::new(e) as Box<dyn Read + Send>)]
        .into_iter()
        .flatten()
        .map(|mut r| {
            let buf = buf.clone();
            std::thread::spawn(move || {
                let mut chunk = [0u8; 8192];
                while let Ok(n) = r.read(&mut chunk) {
                    if n == 0 {
                        break;
                    }
                    buf.lock().unwrap().push(&chunk[..n]);
                }
            })
        })
        .collect();

    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(st)) => break Some(st),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(25)),
            _ => break None,
        }
    };
    // Timed out, or done but something it started still holds the pipes: end the whole tree.
    let grace = Instant::now() + Duration::from_secs(2);
    while status.is_some() && readers.iter().any(|r| !r.is_finished()) && Instant::now() < grace {
        std::thread::sleep(Duration::from_millis(25));
    }
    if status.is_none() || readers.iter().any(|r| !r.is_finished()) {
        kill_tree(child.id());
        let _ = child.wait();
    }
    for r in readers {
        let _ = r.join();
    }
    let mut out = buf.lock().unwrap().text();
    match status {
        None => {
            out.push_str(&format!("\n[timed out after {} s; process tree killed]", timeout.as_secs()));
            (out, None)
        }
        Some(st) => {
            if out.trim().is_empty() {
                out = "(no output)".into();
            }
            (out, st.code())
        }
    }
}

fn kill_tree(pid: u32) {
    if cfg!(windows) {
        let _ = Command::new("taskkill").args(["/T", "/F", "/PID", &pid.to_string()]).output();
    } else {
        let _ = Command::new("kill").args(["-KILL", "--", &format!("-{pid}")]).output();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn setup() -> (tempfile::TempDir, Policy, String) {
        let dir = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        std::fs::write(root.join("a.txt"), "one\ntwo\nthree\ntwo\n").unwrap();
        std::fs::create_dir(root.join("src")).unwrap();
        std::fs::write(root.join("src/main.rs"), "fn main() {}\n").unwrap();
        std::fs::write(root.join(".gitignore"), "target/\n").unwrap();
        std::fs::create_dir(root.join("target")).unwrap();
        std::fs::write(root.join("target/junk.rs"), "fn junk() {}\n").unwrap();
        let p = Policy { workspaces: vec![root.clone()], ..Default::default() };
        (dir, p, root.to_string_lossy().into())
    }
    fn req(tool: &str, root: &str, input: Value) -> ToolRequest {
        ToolRequest { tool: tool.into(), input, root: root.into() }
    }

    #[test]
    fn reads_are_automatic_writes_and_commands_ask() {
        let (_d, p, root) = setup();
        assert_eq!(check(&p, &req("read_file", &root, json!({"path": "a.txt"}))).decision, "auto");
        assert_eq!(check(&p, &req("write_file", &root, json!({"path": "b.txt", "content": "x"}))).decision, "ask");
        assert_eq!(check(&p, &req("shell", &root, json!({"command": "ls"}))).decision, "ask");
        assert_eq!(check(&p, &req("shell", &root, json!({"command": "rm -rf /"}))).decision, "deny");
        assert_eq!(check(&p, &req("read_file", "/", json!({"path": "etc/passwd"}))).decision, "deny", "root must be an opened folder");
        let r = run(&p, &req("write_file", &root, json!({"path": "b.txt", "content": "x"})), false);
        assert_eq!((r.decision, r.is_error), ("denied", true));
        assert!(!Path::new(&root).join("b.txt").exists());
        let r = run(&p, &req("shell", &root, json!({"command": "rm -rf /"})), true);
        assert_eq!(r.decision, "policy_blocked", "approval can't override the deny list");
    }

    #[test]
    fn file_tools_work() {
        let (_d, p, root) = setup();
        let r = run(&p, &req("read_file", &root, json!({"path": "a.txt", "offset": 2, "limit": 2})), false);
        assert_eq!(r.output, "[lines 2-3 of 4]\ntwo\nthree");
        let r = run(&p, &req("edit_file", &root, json!({"path": "a.txt", "old_string": "two", "new_string": "2"})), true);
        assert!(r.is_error && r.output.contains("2 times"));
        let r = run(&p, &req("edit_file", &root, json!({"path": "a.txt", "old_string": "three", "new_string": "3"})), true);
        assert!(!r.is_error, "{}", r.output);
        assert_eq!(std::fs::read_to_string(Path::new(&root).join("a.txt")).unwrap(), "one\ntwo\n3\ntwo\n");
        let r = run(&p, &req("write_file", &root, json!({"path": "new/dir/x.txt", "content": "hi"})), true);
        assert_eq!(r.decision, "approved");
        assert_eq!(std::fs::read_to_string(Path::new(&root).join("new/dir/x.txt")).unwrap(), "hi");
        let g = run(&p, &req("glob", &root, json!({"pattern": "**/*.rs"})), false);
        assert_eq!(g.output, "src/main.rs", "gitignored target/ is skipped");
        let g = run(&p, &req("grep", &root, json!({"pattern": "FN \\w+", "ignore_case": true})), false);
        assert_eq!(g.output, "src/main.rs:1: fn main() {}");
    }

    #[cfg(unix)]
    #[test]
    fn shell_caps_output_and_kills_the_tree_on_timeout() {
        let (_d, _p, root) = setup();
        let (out, code) = shell(Path::new(&root), "pwd; echo err >&2; exit 3", Duration::from_secs(5));
        assert_eq!(code, Some(3));
        assert!(out.contains(&root) && out.contains("err"));
        let (out, _) = shell(Path::new(&root), "head -c 100000 /dev/zero | tr '\\0' a; echo END", Duration::from_secs(5));
        assert!(out.len() < OUTPUT_CAP + 100 && out.contains("bytes cut") && out.trim_end().ends_with("END"));
        let t = Instant::now();
        let (out, code) = shell(Path::new(&root), "sleep 30 & sleep 30", Duration::from_secs(1));
        assert!(code.is_none() && out.contains("timed out") && t.elapsed() < Duration::from_secs(5));
        let t = Instant::now();
        let (_, code) = shell(Path::new(&root), "sleep 30 & echo started", Duration::from_secs(10));
        assert_eq!(code, Some(0));
        assert!(t.elapsed() < Duration::from_secs(5), "a background child holding the pipe doesn't hang the tool");
    }
}
