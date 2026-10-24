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
import { _timingSafeEqual, abuseBucket } from "./server-auth.ts";
import { log } from "../diagnostics/logger-api.ts";
import { cpace, PAKE_PIN_DIGITS } from "./cpace.ts";

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
  /** Minted for `pairing: { pake: true }`: only the CPace exchange may
   *  spend it (see cpace.ts). */
  pake: boolean;
  /** CPace exchanges between message 1 and message 2, by id. Part of THIS
   *  code's state, so consuming or burning the code drops them too. */
  offers: Map<string, PakeOffer>;
}

interface PakeOffer {
  at: number;
  sid: Uint8Array;
  isk: Uint8Array;
  ta: Uint8Array;
  tb: Uint8Array;
}

/** How long a CPace exchange may sit between its two messages (ms). */
export const PAKE_OFFER_TTL_MS = 30_000;
/** Open exchanges kept per code; the oldest gives way (a flood of message 1s
 *  costs no guess, so it must not be able to crowd out the owner's). */
const MAX_OFFERS = 16;

/** The scope used by a caller that names none (unit tests driving the state
 *  machine directly). Every server call site passes its app's key. */
const DEFAULT_SCOPE = "";

/** One PIN per app, keyed by the app's shared key — see the header. */
const _states = new Map<string, PairingState>();

const _expired = (s: PairingState, now: number): boolean =>
  now - s.createdAt > PIN_TTL_MS;

/** Generate a fresh pairing PIN for this app (replaces its current one;
 *  never touches another app's). `scope` is the app's shared key. 6 digits,
 *  or 8 for `pairing: { pake: true }` — the length tells the client to pair
 *  by PAKE and never send the code (cpace.ts `PAKE_PIN_DIGITS`). */
export function generatePin(
  scope: string = DEFAULT_SCOPE,
  opts?: { pake?: boolean },
): string {
  const pake = opts?.pake === true;
  const digits = pake ? PAKE_PIN_DIGITS : 6;
  // Rejection sampling: `% 10^8` of a uint32 would favour the low codes.
  const space = 10 ** digits;
  const limit = Math.floor(2 ** 32 / space) * space;
  let n: number;
  do n = crypto.getRandomValues(new Uint32Array(1))[0]!; while (n >= limit);
  const pin = (n % space).toString().padStart(digits, "0");
  const now = Date.now();
  // Entries are removed when consumed, burned or found expired — but only a
  // READ finds one expired, so sweep here: a closed app's code must not sit in
  // memory for the life of the process.
  for (const [k, s] of _states) if (_expired(s, now)) _states.delete(k);
  _states.set(scope, {
    pin,
    createdAt: now,
    attempts: new Map(),
    wrong: 0,
    pake,
    offers: new Map(),
  });
  return pin;
}

/** This app's current PIN, or null if none is active (never generated /
 *  consumed / expired / burned). */
// aio-ok(dead-wiring): a test seam — only tests/ reach it, the product never does
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
  const s = _live(scope);
  // A PAKE code is never accepted in the clear — that is its whole point.
  if (!s || s.pake || typeof submitted !== "string") return false;
  // Bucketed like every auth budget: an IPv6 /64 is one client.
  const key = abuseBucket(clientKey);
  if ((s.attempts.get(key) ?? 0) >= MAX_ATTEMPTS) return false;

  const ok = _timingSafeEqual(submitted, s.pin);
  if (ok) {
    _states.delete(scope); // one-shot: consume on success so it can't be replayed
    return true;
  }
  _wrongGuess(s, key, scope);
  return false;
}

/** This app's active code state, dropping it when expired. */
function _live(scope: string): PairingState | null {
  const s = _states.get(scope);
  if (!s) return null;
  if (_expired(s, Date.now())) {
    _states.delete(scope);
    return null;
  }
  return s;
}

/** Charge one wrong guess to `key` and to the code's total budget. */
function _wrongGuess(s: PairingState, key: string, scope: string): void {
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
}

/** A plain `{ pin }` body sent to a PAKE app — an old client, sending the
 *  code in the clear, where a relay may have read it. The right code is
 *  BURNED (a relay holding it could otherwise pair by PAKE); a wrong one is a
 *  wrong guess. The caller answers both alike, so the reply is no oracle.
 *  True when the code was burned. */
export function pinSentInClear(
  submitted: unknown,
  clientKey?: string,
  scope: string = DEFAULT_SCOPE,
): boolean {
  const s = _live(scope);
  if (!s || !s.pake || typeof submitted !== "string") return false;
  if (_timingSafeEqual(submitted, s.pin)) {
    _states.delete(scope);
    log.warn(
      "auth",
      "⚠ an old client sent the pairing code in the clear — code burned " +
        "(something between it and the app may have read it); run `am pair` " +
        "again and pair with an updated aio client",
    );
    return true;
  }
  _wrongGuess(s, abuseBucket(clientKey), scope);
  return false;
}

/** CPace message 1 (cpace.ts): answer it with this app's code, on the
 *  certificate fingerprint `fp` the server serves the request with. Costs no
 *  guess — Yb says nothing about the code. null: no PAKE code is active, the
 *  caller's address is out of guesses, or Ya is an abort case. */
export async function pakeOffer(
  sid: Uint8Array,
  ya: Uint8Array,
  fp: Uint8Array,
  clientKey?: string,
  scope: string = DEFAULT_SCOPE,
): Promise<{ id: string; Yb: Uint8Array; ADb: Uint8Array } | null> {
  const s = _live(scope);
  if (!s || !s.pake) return null;
  if ((s.attempts.get(abuseBucket(clientKey)) ?? 0) >= MAX_ATTEMPTS) {
    return null;
  }
  const r = await cpace.respond(s.pin, fp, sid, ya);
  if (!r) return null;
  const now = Date.now();
  for (const [k, o] of s.offers) {
    if (now - o.at > PAKE_OFFER_TTL_MS) s.offers.delete(k);
  }
  while (s.offers.size >= MAX_OFFERS) {
    s.offers.delete(s.offers.keys().next().value!);
  }
  const id = cpace.b64(crypto.getRandomValues(new Uint8Array(16)));
  s.offers.set(id, { at: now, sid, isk: r.isk, ta: r.ta, tb: r.tb });
  return { id, Yb: r.Yb, ADb: r.ADb };
}

/** CPace message 2: the client's confirmation tag. Right → the code is
 *  CONSUMED (one-shot, as `verifyPin`) and the caller gets what it needs to
 *  answer (`tb`, and the key material to seal the profile). Wrong → one wrong
 *  guess, on the same budgets a plain `{ pin }` spends. `null`: no such
 *  exchange (unknown, expired, already answered, or its code is gone) —
 *  nothing was guessed, so nothing is charged. */
export function pakeConfirm(
  id: unknown,
  ta: Uint8Array,
  clientKey?: string,
  scope: string = DEFAULT_SCOPE,
): { ok: true; tb: Uint8Array; isk: Uint8Array; sid: Uint8Array } | {
  ok: false;
  wrong: boolean;
} {
  const s = _live(scope);
  const o = s && typeof id === "string" ? s.offers.get(id) : undefined;
  if (!s || !o || Date.now() - o.at > PAKE_OFFER_TTL_MS) {
    return { ok: false, wrong: false };
  }
  s.offers.delete(id as string); // one answer per exchange, right or wrong
  const key = abuseBucket(clientKey);
  if ((s.attempts.get(key) ?? 0) >= MAX_ATTEMPTS) {
    return { ok: false, wrong: true };
  }
  if (!cpace.same(ta, o.ta)) {
    _wrongGuess(s, key, scope);
    return { ok: false, wrong: true };
  }
  _states.delete(scope);
  return { ok: true, tb: o.tb, isk: o.isk, sid: o.sid };
}

/** Clear pairing state (test hook) — one app's, or every app's
 *  when no scope is named. */
// aio-ok(dead-wiring): a test seam — only tests/ reach it, the product never does
export function clearPairing(scope?: string): void {
  if (scope === undefined) _states.clear();
  else _states.delete(scope);
}
