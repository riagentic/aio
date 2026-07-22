// pairing.ts — PIN pairing for keyed --expose apps. The app shows a short
// code on startup; the aio client submits it ONCE to pull the full profile
// (cert to pin + auth key) over the exposed server. No file to transfer —
// the friendly "type this number" flow.
//
// Security model (LAN convenience, hardened):
//  - ONE-SHOT: a correct PIN is consumed on success — it cannot be replayed
//    later in the session (an observed code stops working the moment it pairs).
//  - TTL: the PIN self-expires a few minutes after generation.
//  - PER-KEY budget: wrong guesses are counted per client key (usually IP), so
//    a wrong-guessing attacker locks only THEMSELVES — it can't be used to DoS
//    the legitimate device out of pairing (the old global counter could).
// Regenerate with a restart or `am pair`.
import { _timingSafeEqual } from "./server-auth.ts";

/** Wrong-guess budget per client key before that key is refused. */
const MAX_ATTEMPTS = 8;
/** How long a generated PIN stays valid (ms). */
const PIN_TTL_MS = 3 * 60_000;

interface PairingState {
  pin: string;
  createdAt: number;
  /** Wrong-guess counts keyed by client key (IP). */
  attempts: Map<string, number>;
}

let _state: PairingState | null = null;

/** Generate a fresh 6-digit pairing PIN (replaces any current one). */
export function generatePin(): string {
  const n = crypto.getRandomValues(new Uint32Array(1))[0]! % 1_000_000;
  const pin = n.toString().padStart(6, "0");
  _state = { pin, createdAt: Date.now(), attempts: new Map() };
  return pin;
}

/** The current PIN, or null if none is active (never generated / consumed /
 *  expired / locked). */
export function currentPin(): string | null {
  if (!_state) return null;
  if (Date.now() - _state.createdAt > PIN_TTL_MS) {
    _state = null;
    return null;
  }
  return _state.pin;
}

/** Verify a submitted PIN for a given client key (usually remote IP).
 *  Constant-time compare. A correct PIN is CONSUMED (one-shot). Wrong tries
 *  decrement only that client key's budget; an exhausted key is refused
 *  without locking the PIN for everyone else. Undefined key falls back to a
 *  single shared bucket. */
export function verifyPin(submitted: unknown, clientKey?: string): boolean {
  if (!_state || typeof submitted !== "string") return false;
  // Expired → gone.
  if (Date.now() - _state.createdAt > PIN_TTL_MS) {
    _state = null;
    return false;
  }
  const key = clientKey ?? "*";
  if ((_state.attempts.get(key) ?? 0) >= MAX_ATTEMPTS) return false;

  const ok = _timingSafeEqual(submitted, _state.pin);
  if (ok) {
    _state = null; // one-shot: consume on success so it can't be replayed
    return true;
  }
  _state.attempts.set(key, (_state.attempts.get(key) ?? 0) + 1);
  return false;
}

/** Clear pairing state (test hook / lockdown). */
export function clearPairing(): void {
  _state = null;
}
