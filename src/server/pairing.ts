// pairing.ts — PIN pairing for keyed --expose apps. The app shows a short
// code on startup; the aio client submits it once to pull the full profile
// (cert to pin + auth key) over the exposed server. No file to transfer —
// the friendly "type this number" flow.
//
// Security: a 6-digit PIN is brute-forceable, so it's attempt-limited (a
// handful of wrong tries invalidates it) and session-scoped. On a trusted
// LAN that's the right convenience/safety trade; regenerate with a restart
// or `am pair`.
import { _timingSafeEqual } from "./server-auth.ts";

interface PairingState {
  pin: string;
  attemptsLeft: number;
}

const MAX_ATTEMPTS = 8;
let _state: PairingState | null = null;

/** Generate a fresh 6-digit pairing PIN (replaces any current one). */
export function generatePin(): string {
  const n = crypto.getRandomValues(new Uint32Array(1))[0]! % 1_000_000;
  const pin = n.toString().padStart(6, "0");
  _state = { pin, attemptsLeft: MAX_ATTEMPTS };
  return pin;
}

/** The current PIN, or null if none is active (never generated / locked). */
export function currentPin(): string | null {
  return _state?.pin ?? null;
}

/** Verify a submitted PIN. Constant-time; wrong tries decrement the budget
 *  and invalidate the PIN once exhausted (anti-brute-force). */
export function verifyPin(submitted: unknown): boolean {
  if (!_state || typeof submitted !== "string") return false;
  const ok = _timingSafeEqual(submitted, _state.pin);
  if (!ok) {
    _state.attemptsLeft--;
    if (_state.attemptsLeft <= 0) _state = null; // locked — regenerate to reuse
  }
  return ok;
}

/** Clear pairing state (test hook / lockdown). */
export function clearPairing(): void {
  _state = null;
}
