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

// One code, one use (RFC 6238 §5.2).
//
// The ±1-step window means a code stays valid for 90 seconds. Without
// remembering which step was last accepted, a code observed once — shoulder,
// proxy, log, screen share — could be replayed for the rest of that window.
// The login route mitigates it with a one-shot pending token, but `verifyTotp`
// itself is also what guards TOTP enable/disable.
//
// Kept in memory, keyed by secret: the window is 90 seconds, so a process
// restart cannot meaningfully widen it, and this needs no schema migration on
// a store that has never had one. Entries older than two windows are swept.
const REPLAY_WINDOW_MS = 90_000;
const _lastStep = new Map<string, { step: number; at: number }>();
function _sweepSteps(now: number): void {
  if (_lastStep.size < 64) return;
  for (const [k, v] of _lastStep) {
    if (now - v.at > 2 * REPLAY_WINDOW_MS) _lastStep.delete(k);
  }
}

/** Verify a submitted code with a ±1-step window (clock skew tolerance).
 *  Length-checked + constant-shape compare; a 6-digit space brute-force is
 *  handled by the login fail budget, not by timing.
 *
 *  A code is accepted ONCE: a step at or below the last one accepted for this
 *  secret is refused, so re-submitting a still-valid code fails. */
export async function verifyTotp(
  secretB32: string,
  submitted: string,
): Promise<boolean> {
  if (!/^\d{6}$/.test(submitted)) return false;
  const nowMs = Date.now();
  const now = Math.floor(nowMs / 30_000);
  for (const step of [now, now - 1, now + 1]) {
    if ((await totpCode(secretB32, step)) !== submitted) continue;
    const prev = _lastStep.get(secretB32);
    if (prev && step <= prev.step) return false; // replay of a used code
    _sweepSteps(nowMs);
    _lastStep.set(secretB32, { step, at: nowMs });
    return true;
  }
  return false;
}

/** Test isolation — forget which steps have been consumed. @internal */
export function _resetTotpReplay(): void {
  _lastStep.clear();
}
