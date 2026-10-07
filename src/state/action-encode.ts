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
// The lossy walk re-uses the string `enc` already produced instead of
// stringifying a second time, and runs in dev AND prod (see `_warnLossy`):
// observe-only, the frame is the same either way. Dev says every distinct
// loss with the fix; prod says each action type once. The REFUSAL is loud in
// both, because there is nothing to preserve about a call that cannot be
// delivered either way.
import { dec, enc } from "../protocol/envelope.ts";
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
  _checked.clear();
}

/** Prod checks an action type's first calls only. The walk parses the frame
 *  again — 1 ms on a 190 KB payload, on the dispatch path of every call — and
 *  a method that sent clean arguments sixteen times is not where the loss is.
 *  Dev checks every call. */
const PROD_CHECKS = 16;
const _checked = new Map<string, number>();

/** Encode an action frame, refusing loudly what the wire cannot carry.
 *
 *  Throws — with the action named — when JSON cannot carry the payload at all.
 *  The caller must NOT queue an action that threw: it can never be delivered,
 *  and a queue holding one is a queue that stops at it on every reconnect. */
export function encodeAction(
  action: { type: string; payload?: unknown },
): string {
  const json = _encode(action);
  _warnLossy(action, json);
  return json;
}

function _encode(action: { type: string; payload?: unknown }): string {
  try {
    return enc("action", action);
  } catch (err) {
    throw new Error(
      `[aio] ${action.type} was dispatched with an argument JSON cannot ` +
        `carry (a BigInt or a circular structure) — nothing was sent and the ` +
        `dispatch did not happen. Pass JSON-safe data across the wire ` +
        `(a number or string for a BigInt, a plain tree for a cycle).`,
      { cause: err },
    );
  }
}

/** What the wire makes of an action's payload. */
export interface ActionWireTrip {
  /** The payload the server decodes from the frame. */
  payload: unknown;
  /** Every value that arrives changed; paths start at the action type
   *  (`dialog:open.args[1].when`). Empty when the trip was exact — unless
   *  `truncated`. */
  lossy: LossyConversion[];
  /** The walk stopped early (wire-value.ts's MAX_NODES): `lossy` is partial. */
  truncated: boolean;
}

/** Who acts on a loss: `testUI` (fails the test), the dev console warning,
 *  the production console warning. */
export type WireLossReader = "harness" | "dev" | "prod";

/** THE table of what each reader does with each kind of loss — one decider,
 *  so the harness can never be stricter (or laxer) than the warnings by
 *  accident.
 *
 *  `omitted` is `{ text, due: undefined }` arriving as `{ text }`: an optional
 *  field left unset, which is ordinary code — the server reads `due` as
 *  `undefined` either way. The harness delivers the decoded payload (key
 *  absent, as production does) and does NOT fail; dev keeps the line it has
 *  printed since the walk existed; prod says nothing. Everything else — a
 *  `Date` that becomes a string, an `undefined` ARGUMENT or array slot that
 *  becomes `null` (a default parameter does not apply to `null`) — is a value
 *  the caller did not pass. */
const WIRE_LOSS: Record<
  "omitted" | "changed",
  Record<WireLossReader, boolean>
> = {
  omitted: { harness: false, dev: true, prod: false },
  changed: { harness: true, dev: true, prod: true },
};

/** Does this reader act on this loss? Reads {@linkcode WIRE_LOSS}. */
export function wireLossCounts(
  l: LossyConversion,
  reader: WireLossReader,
): boolean {
  return WIRE_LOSS[
    l.from === "undefined" && l.to === "absent" ? "omitted" : "changed"
  ][reader];
}

/** THE decider for "what does the server receive for this call, and what was
 *  lost on the way": the production encode, the production decode, and the
 *  one lossy walk. The warning below reads it, and so does `testUI`
 *  (testing/ui-test.ts), which hands the method `payload` and fails the test
 *  on the losses `wireLossCounts(l, "harness")` — so the harness's verdict and the transport's cannot drift
 *  (tests/wire-harness-differential.test.tsx compares them over a real
 *  socket). Throws like {@linkcode encodeAction} for a BigInt or a cycle. */
export function actionWireTrip(
  action: { type: string; payload?: unknown },
  json: string = _encode(action),
): ActionWireTrip {
  const payload = (dec(json)?.d as { payload?: unknown } | undefined)?.payload;
  const lossy: LossyConversion[] = [];
  const budget: LossyBudget = { n: 0 };
  if (action.payload !== undefined) {
    findLossy(action.payload, payload, action.type, lossy, budget);
  }
  return { payload, lossy, truncated: budget.truncated === true };
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
  _warnLossy({ type: what, payload }, `{"v":2,"t":"action","d":${json}}`);
}

/** Compare the payload with what the wire will actually deliver, and say so.
 *
 *  In dev AND prod. It was dev-only, on the argument that prod "pays nothing"
 *  — and what prod paid instead was a server storing something other than
 *  what the caller passed with no line anywhere (a field report: the only
 *  trace was a dev-console warning, and the packaged app said nothing).
 *  Observe-only either way; the frame is identical. Prod says it ONCE per
 *  action type, briefly, and stops checking that type: `log.warn` is the
 *  page's console, which the console forwarder carries to `client.log`. */
function _warnLossy(
  action: { type: string; payload?: unknown },
  json: string,
): void {
  if (action.payload === undefined) return;
  const dev = isDevMode();
  if (!dev) {
    const n = _checked.get(action.type) ?? 0;
    if (n >= PROD_CHECKS || _warned.has(action.type)) return;
    _checked.set(action.type, n + 1);
  }
  const reader = dev ? "dev" : "prod";
  const lossy = actionWireTrip(action, json).lossy.filter((l) =>
    wireLossCounts(l, reader)
  );
  if (lossy.length === 0) return;
  const key = dev
    ? `${action.type}|${lossy.map((l) => l.path + l.from).join(",")}`
    : action.type;
  if (_warned.has(key)) return;
  if (_warned.size >= WARN_MAX) _warned.clear();
  _warned.add(key);
  log.warn(
    "wire",
    `${action.type} was dispatched with arguments JSON cannot carry ` +
      `intact — the server receives DIFFERENT values than the caller ` +
      `passed:\n${formatLossy(lossy)}` +
      (dev
        ? `\nPass JSON-safe data across the wire ` +
          `(ISO strings for dates, arrays for Map/Set, plain objects for ` +
          `class instances).`
        : ""),
  );
}
