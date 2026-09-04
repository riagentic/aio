// action-encode.ts — the ONE door an action goes through on its way to a wire.
//
// Two client queues send actions, for a structural reason (offline-queue.ts's
// header): cell-method dispatch encodes in `browser/browser-air-transport.ts`,
// `useCell().send` / `useAio().send` in `state/state-transport.ts`. Both called
// `enc("action", …)` inline, so both had the two gaps that `serverFn`
// arguments were already given a guard for (`protocol/wire-value.ts`'s
// `serializeArgs`) — the same wire, vetted on one path and not the other:
//
//  • A value JSON cannot carry AT ALL — a BigInt, a cycle — made
//    `JSON.stringify` throw from inside the transport. The app saw
//    `Do not know how to serialize a BigInt`: no method name, no argument
//    path, and a click that did nothing. Worse OFFLINE, where the core queue
//    never encoded at all: the action was accepted, and the flush then threw
//    on it and discarded every action queued behind it.
//  • A value JSON carries but CHANGES — `new Date()` → an ISO string, a `Map`
//    or `Set` → `{}`, `NaN` → `null`, an `undefined` member → no key — went
//    through in silence, so the server stored something other than what the
//    caller passed while the in-process harness (which crosses no wire) kept
//    the original. That is the green-test-broken-prod shape, and the identical
//    value handed to a `serverFn` had warned loudly since alpha76.
//
// The lossy walk is DEV-ONLY and re-uses the string `enc` already produced
// instead of stringifying a second time: category (b) of CLAUDE.md's dev/prod
// rule — dev is STRICTER, prod behaves identically and pays nothing. The
// REFUSAL is loud in both, because there is nothing to preserve about a call
// that cannot be delivered either way.
import { enc } from "../protocol/envelope.ts";
import {
  findLossy,
  formatLossy,
  type LossyBudget,
  type LossyConversion,
} from "../protocol/wire-value.ts";
import { log } from "../diagnostics/logger-api.ts";
import { isDevMode } from "./dev-flag.ts";

/** Warned shapes, so a method called on every keystroke says it once.
 *  Keyed by action type + the paths that changed, so a DIFFERENT loss in the
 *  same method still gets said. */
const _warned = new Set<string>();
/** Ceiling on remembered shapes. Unlike every other warn-dedupe set in the
 *  runtime — which is keyed by a method name, a cell id, a KIND — this one's
 *  key carries the CHANGED PATHS, and a path holds array indices
 *  (`args[0].items[37].at`). A long-lived client editing a long list would
 *  therefore grow it without a bound. At the cap the memory is dropped whole:
 *  saying a warning twice is a papercut, holding a browser tab's memory
 *  hostage to a diagnostic is not. */
const WARN_MAX = 500;

/** @internal Forget every warning already said. Called by `_resetAioRuntime`,
 *  because a "have I said this?" memory that survives a test makes the NEXT
 *  test's diagnostics order-dependent — the exact class runtime-reset.ts
 *  exists for. */
export function _resetActionWarnings(): void {
  _warned.clear();
}

/** Encode an action frame, refusing loudly what the wire cannot carry.
 *
 *  Throws — with the action named — when JSON cannot carry the payload at all.
 *  The caller must NOT queue an action that threw: it can never be delivered,
 *  and a queue holding one is a queue that stops at it on every reconnect. */
export function encodeAction(
  action: { type: string; payload?: unknown },
): string {
  let json: string;
  try {
    json = enc("action", action);
  } catch (err) {
    throw new Error(
      `[aio] ${action.type} was dispatched with an argument JSON cannot ` +
        `carry (a BigInt or a circular structure) — nothing was sent and the ` +
        `dispatch did not happen. Pass JSON-safe data across the wire ` +
        `(a number or string for a BigInt, a plain tree for a cycle).`,
      { cause: err },
    );
  }
  if (isDevMode()) _warnLossy(action, json);
  return json;
}

/** Vet a payload that will cross the wire inside a frame this module does not
 *  build — the CRDT op door, where the op is written to localStorage and sent
 *  as an `op` frame by the sync engine.
 *
 *  Throws, naming the call, when JSON cannot carry it: an op that cannot be
 *  encoded must never enter the op buffer. Buffered, it was a poison pill that
 *  failed the localStorage write with a quota-shaped message ("unsent changes
 *  will NOT survive a reload"), threw again from `enc` on every send, and was
 *  retried on every reconnect for the life of the app.
 *
 *  In dev it also warns about what the wire CHANGES — which matters more here
 *  than on the plain path: the local method already ran with the real value,
 *  so a `Date` that becomes a string means the optimistic view and the
 *  replayed one disagree, and only the second one survives a reload. */
export function vetWirePayload(what: string, payload: unknown): void {
  let json: string;
  try {
    json = JSON.stringify({ payload });
  } catch (err) {
    throw new Error(
      `[aio] ${what} was called with an argument JSON cannot carry (a BigInt ` +
        `or a circular structure) — the change was NOT recorded and nothing ` +
        `was sent. Pass JSON-safe data across the wire.`,
      { cause: err },
    );
  }
  if (isDevMode()) _warnLossy({ type: what, payload }, `{"d":${json}}`);
}

/** Compare the payload with what the wire will actually deliver. */
function _warnLossy(
  action: { type: string; payload?: unknown },
  json: string,
): void {
  if (action.payload === undefined) return;
  let round: unknown;
  try {
    round = (JSON.parse(json) as { d?: { payload?: unknown } }).d?.payload;
  } catch {
    return; // aio-ok: `enc` produced this string a line ago — it parses.
  }
  const lossy: LossyConversion[] = [];
  const budget: LossyBudget = { n: 0 };
  findLossy(action.payload, round, action.type, lossy, budget);
  if (lossy.length === 0) return;
  const key = `${action.type}|${lossy.map((l) => l.path + l.from).join(",")}`;
  if (_warned.has(key)) return;
  if (_warned.size >= WARN_MAX) _warned.clear();
  _warned.add(key);
  log.warn(
    "wire",
    `${action.type} was dispatched with arguments JSON cannot carry ` +
      `intact — the server receives DIFFERENT values than the caller ` +
      `passed:\n${formatLossy(lossy)}\nPass JSON-safe data across the wire ` +
      `(ISO strings for dates, arrays for Map/Set, plain objects for class ` +
      `instances). An in-process test crosses no wire, so it keeps the ` +
      `original value and cannot see this.`,
  );
}
