import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

// AES-256-GCM. Output is iv (12) | tag (16) | ciphertext. The AAD string binds a ciphertext to
// where it belongs (user id, provider), so a value copied into another row won't decrypt.
export function seal(key: Buffer, plain: Buffer, aad: string): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv).setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]);
}

export function unseal(key: Buffer, box: Buffer, aad: string): Buffer {
  const d = createDecipheriv('aes-256-gcm', key, box.subarray(0, 12)).setAAD(Buffer.from(aad));
  d.setAuthTag(box.subarray(12, 28));
  return Buffer.concat([d.update(box.subarray(28)), d.final()]);
}

// Envelope encryption: each user gets a random data key, stored wrapped by the master key.
export const newWrappedDataKey = (master: Buffer, userId: string) => seal(master, randomBytes(32), `dk:${userId}`);
export const dataKey = (master: Buffer, userId: string, wrapped: Buffer) => unseal(master, wrapped, `dk:${userId}`);

// --- TOTP (RFC 6238, SHA-1, 6 digits, 30 s) ---

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32(buf: Buffer): string {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function hotp(secret: Buffer, counter: number, digits = 6): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', secret).update(msg).digest();
  const off = h[h.length - 1] & 0xf;
  const n = (h.readUInt32BE(off) & 0x7fffffff) % 10 ** digits;
  return n.toString().padStart(digits, '0');
}

// Returns the matching time step, or null. Accepts one step of clock drift either way and
// rejects any step at or before lastStep, so a code can't be replayed.
export function verifyTotp(secret: Buffer, code: string, lastStep: number, now = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const step = Math.floor(now / 30_000);
  for (const s of [step - 1, step, step + 1]) {
    if (s > lastStep && hotp(secret, s) === code) return s;
  }
  return null;
}
