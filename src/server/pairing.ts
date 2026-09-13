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
//    one wrong-guessing address locks only ITSELF out.
//  - TOTAL budget: the PIN itself is BURNED after MAX_WRONG_TOTAL wrong
//    guesses from all addresses together. The per-key budget alone was a
//    speed bump, not a bound: 320 wrong guesses from 40 loopback addresses and
//    then the right PIN from a 41st still paired — and a rotating source is
//    free (an IPv6 /64, a botnet, a forwarding header behind a proxy). A
//    6-digit PIN only resists guessing if the number of guesses is bounded.
//    The cost is that a guesser can burn the owner's code; the owner mints a
//    new one with `am pair` and the burn is logged loudly, which is a far
//    better failure than handing the app key to whoever guesses fastest.
//  - PER APP: the state is keyed by the app's shared key (the thing a PIN
//    unlocks). It was one module-level slot, and a process can host several
//    apps (library mode, `testApps`): booting app B replaced app A's PIN, so
//    A's printed code was dead and B's code paired A — returning A's key.
//
// LIFETIME: `generatePin` has two callers — the boot banner, and `am pair` via
// the trojan's `pair` route (POST /__aio/trojan/pair). Until that route existed
// a missed 3-minute window meant restarting the app — downtime for every
// connected client — so the comment here, and the 401 from /__aio/pair, both
// said "restart the app". `am pair` is the honest answer now, and both places
// say so; /__aio/pair's 401 (in server.ts) states the window from PIN_TTL_MS
// rather than a typed-out copy, so the two can never disagree.
import { _timingSafeEqual } from "./server-auth.ts";
import { log } from "../diagnostics/logger-api.ts";

/** Wrong-guess budget per client key before that key is refused. */
const MAX_ATTEMPTS = 8;
/** Wrong guesses, from ALL client keys together, that burn the PIN.
 *
 *  20: one PIN then falls to guessing with probability 20 / 1 000 000 = 0.002%,
 *  and every further chance costs the owner an `am pair` — an attacker needs
 *  ~50 000 re-mints for one expected hit. A person typing a code they can see
 *  gets it wrong a handful of times at most, and a single address is cut off
 *  at MAX_ATTEMPTS (8) long before this, so only a guesser using three or more
 *  addresses can ever reach it. */
export const MAX_WRONG_TOTAL = 20;
/** How long a generated PIN stays valid (ms). Exported so the `am pair` reply
 *  states the REAL window instead of a copy that can drift out of sync. */
export const PIN_TTL_MS = 3 * 60_000;

interface PairingState {
  pin: string;
  createdAt: number;
  /** Wrong-guess counts keyed by client key (IP). */
  attempts: Map<string, number>;
  /** Wrong guesses from every key together — see MAX_WRONG_TOTAL. */
  wrong: number;
}

/** The scope used by a caller that names none (unit tests driving the state
 *  machine directly). Every server call site passes its app's key. */
const DEFAULT_SCOPE = "";

/** One PIN per app, keyed by the app's shared key — see the header. */
const _states = new Map<string, PairingState>();

const _expired = (s: PairingState, now: number): boolean =>
  now - s.createdAt > PIN_TTL_MS;

/** Generate a fresh 6-digit pairing PIN for this app (replaces its current
 *  one; never touches another app's). `scope` is the app's shared key. */
export function generatePin(scope: string = DEFAULT_SCOPE): string {
  const n = crypto.getRandomValues(new Uint32Array(1))[0]! % 1_000_000;
  const pin = n.toString().padStart(6, "0");
  const now = Date.now();
  // Entries are removed when consumed, burned or found expired — but only a
  // READ finds one expired, so sweep here: a closed app's code must not sit in
  // memory for the life of the process.
  for (const [k, s] of _states) if (_expired(s, now)) _states.delete(k);
  _states.set(scope, { pin, createdAt: now, attempts: new Map(), wrong: 0 });
  return pin;
}

/** This app's current PIN, or null if none is active (never generated /
 *  consumed / expired / burned). */
export function currentPin(scope: string = DEFAULT_SCOPE): string | null {
  const s = _states.get(scope);
  if (!s) return null;
  if (_expired(s, Date.now())) {
    _states.delete(scope);
    return null;
  }
  return s.pin;
}

/** Verify a submitted PIN for a given client key (usually remote IP) against
 *  THIS app's PIN. Constant-time compare. A correct PIN is CONSUMED (one-shot).
 *  A wrong try decrements that client key's budget and the PIN's total budget;
 *  an exhausted key is refused without locking the PIN for everyone else, and
 *  an exhausted total burns the PIN. Undefined key falls back to a single
 *  shared bucket. */
export function verifyPin(
  submitted: unknown,
  clientKey?: string,
  scope: string = DEFAULT_SCOPE,
): boolean {
  const s = _states.get(scope);
  if (!s || typeof submitted !== "string") return false;
  // Expired → gone.
  if (_expired(s, Date.now())) {
    _states.delete(scope);
    return false;
  }
  const key = clientKey ?? "*";
  if ((s.attempts.get(key) ?? 0) >= MAX_ATTEMPTS) return false;

  const ok = _timingSafeEqual(submitted, s.pin);
  if (ok) {
    _states.delete(scope); // one-shot: consume on success so it can't be replayed
    return true;
  }
  s.attempts.set(key, (s.attempts.get(key) ?? 0) + 1);
  if (++s.wrong >= MAX_WRONG_TOTAL) {
    _states.delete(scope); // burned: the total guess budget is spent
    log.warn(
      "auth",
      `pairing code BURNED after ${s.wrong} wrong guesses from ${s.attempts.size} ` +
        `address(es) — somebody may be guessing it. No code is active now; run ` +
        `\`am pair\` to mint a new one when you are ready to pair a device.`,
    );
  }
  return false;
}

/** Clear pairing state (test hook / lockdown) — one app's, or every app's
 *  when no scope is named. */
export function clearPairing(scope?: string): void {
  if (scope === undefined) _states.clear();
  else _states.delete(scope);
}
