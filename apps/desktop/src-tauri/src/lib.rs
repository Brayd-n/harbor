mod policy;
mod tools;

use policy::Policy;
use serde::Serialize;
use std::process::Command;
use tauri_plugin_dialog::DialogExt;

const KEYCHAIN_SERVICE: &str = "harbor";

// The refresh token lives in the OS keychain (Secret Service on Linux, Credential Manager on
// Windows), one entry per server.
fn entry(server: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, server).map_err(|e| e.to_string())
}

#[tauri::command]
fn token_get(server: String) -> Result<Option<String>, String> {
    match entry(&server)?.get_password() {
        Ok(t) => Ok(Some(t)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn token_set(server: String, token: String) -> Result<(), String> {
    entry(&server)?.set_password(&token).map_err(|e| e.to_string())
}

#[tauri::command]
fn token_clear(server: String) -> Result<(), String> {
    match entry(&server)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[derive(Serialize)]
struct DeviceInfo {
    os: String,
    os_version: String,
    arch: String,
    hostname: String,
    home_dir: String,
    shell: String,
}

// Shell probe: PowerShell 7 on Windows, bash elsewhere. An empty string means it's missing.
fn shell_version() -> String {
    let out = if cfg!(windows) {
        Command::new("pwsh").args(["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"]).output()
    } else {
        Command::new("bash").arg("--version").output()
    };
    let Ok(out) = out else { return String::new() };
    let first = String::from_utf8_lossy(&out.stdout).lines().next().unwrap_or("").trim().to_string();
    if cfg!(windows) {
        format!("PowerShell {first} (pwsh)")
    } else {
        // "GNU bash, version 5.2.21(1)-release (x86_64-pc-linux-gnu)" -> "bash 5.2.21"
        let v = first.split("version ").nth(1).unwrap_or("").split('(').next().unwrap_or("");
        format!("bash {v}").trim().to_string()
    }
}

#[tauri::command]
fn device_info() -> DeviceInfo {
    let home = std::env::var(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).unwrap_or_default();
    DeviceInfo {
        os: tauri_plugin_os::platform().to_string(),
        os_version: tauri_plugin_os::version().to_string(),
        arch: tauri_plugin_os::arch().to_string(),
        hostname: tauri_plugin_os::hostname(),
        home_dir: home,
        shell: shell_version(),
    }
}

// The only way to add a workspace: the user picks it in the native folder dialog.
#[tauri::command]
async fn pick_folder(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let Some(picked) = app.dialog().file().blocking_pick_folder() else { return Ok(None) };
    let path = picked.into_path().map_err(|e| e.to_string())?;
    let canon = std::fs::canonicalize(&path).map_err(|e| e.to_string())?;
    policy::check_denied_dirs(&canon)?;
    let mut p = Policy::load();
    if !p.workspaces.iter().any(|w| std::fs::canonicalize(w).ok().as_ref() == Some(&canon)) {
        p.workspaces.push(dunce::simplified(&canon).to_path_buf());
        p.save().map_err(|e| e.to_string())?;
    }
    Ok(Some(dunce::simplified(&canon).display().to_string()))
}

#[tauri::command]
fn policy_get() -> (Policy, String) {
    (Policy::load(), policy::config_dir().join("policy.json").display().to_string())
}

#[tauri::command]
fn tool_check(req: tools::ToolRequest) -> tools::Check {
    tools::check(&Policy::load(), &req)
}

// `approved` only matters for requests that need asking; the policy is checked again here.
#[tauri::command]
async fn tool_run(req: tools::ToolRequest, approved: bool) -> tools::ToolResult {
    tauri::async_runtime::spawn_blocking(move || tools::run(&Policy::load(), &req, approved))
        .await
        .unwrap_or_else(|e| tools::ToolResult { output: e.to_string(), is_error: true, decision: "policy_blocked", exit_code: None, duration_ms: 0 })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![token_get, token_set, token_clear, device_info, pick_folder, policy_get, tool_check, tool_run])
        .run(tauri::generate_context!())
        .expect("error while running Harbor");
}
