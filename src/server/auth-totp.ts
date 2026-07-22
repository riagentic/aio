// auth-totp.ts — TOTP two-factor codes (AUTH-3), RFC 6238 / RFC 4226.
// WebCrypto HMAC-SHA-1 (the algorithm every authenticator app speaks),
// 30-second steps, 6 digits, ±1 step verification window. Zero deps.

const B32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 4648 base32 (no padding) — authenticator apps expect this alphabet. */
export function base32Encode(bytes: Uint8Array): string {
  let bits = 0, value = 0, out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Uint8Array {
  const clean = s.toUpperCase().replace(/=+$/, "");
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error("invalid_base32");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

/** Fresh 160-bit TOTP secret, base32 (what enrollment QR codes carry). */
export function generateTotpSecret(): string {
  return base32Encode(crypto.getRandomValues(new Uint8Array(20)));
}

/** otpauth:// enrollment URI — feed to a QR code or paste into the app. */
export function totpUri(
  secretB32: string,
  account: string,
  issuer: string,
): string {
  const enc = encodeURIComponent;
  return `otpauth://totp/${enc(issuer)}:${enc(account)}?secret=${secretB32}` +
    `&issuer=${enc(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

/** The 6-digit code for a secret at a given step (default: now). */
export async function totpCode(
  secretB32: string,
  step = Math.floor(Date.now() / 30_000),
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    base32Decode(secretB32) as BufferSource,
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const msg = new Uint8Array(8);
  new DataView(msg.buffer).setBigUint64(0, BigInt(step));
  const mac = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, msg as BufferSource),
  );
  const offset = mac[mac.length - 1]! & 0x0f;
  const bin = ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) |
    (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return String(bin % 1_000_000).padStart(6, "0");
}

/** Verify a submitted code with a ±1-step window (clock skew tolerance).
 *  Length-checked + constant-shape compare; a 6-digit space brute-force is
 *  handled by the login fail budget, not by timing. */
export async function verifyTotp(
  secretB32: string,
  submitted: string,
): Promise<boolean> {
  if (!/^\d{6}$/.test(submitted)) return false;
  const now = Math.floor(Date.now() / 30_000);
  for (const step of [now, now - 1, now + 1]) {
    if ((await totpCode(secretB32, step)) === submitted) return true;
  }
  return false;
}
