// action-ack.ts — ONE decider for "did this action actually DO anything?",
// shared by every transport that acks a client call (server-ws.ts, uds.ts).
//
// The ack was taken from the dispatch PROMISE alone, and dispatch resolves
// whether or not anything ran. A cell method that no longer exists, a cell the
// server never booted, a cell disabled by its breaker, a `validate` hook that
// refused the change — all four resolve, so `await todos.rename(id, "x")` in
// the browser returned `ok: true` while the reduce had logged "does NOTHING"
// and changed no state. A stale client after a rename is the everyday version
// of it: the UI reports success forever and the data never moves.
//
// The refusal was already recorded — `recordRejection` keys it to the very
// action object that was refused (see state/rejection-tracker.ts) — but only
// the sync handler ever read it. This is the same read on the ack path.

import { takeRejectionFor } from "../state/rejection-tracker.ts";
import { type AioError, createAioError } from "../diagnostics/error.ts";

/** Why this action was refused, or `null` when it really ran.
 *
 *  Read-and-clear, keyed to the action OBJECT: the caller passes the same
 *  object it handed to `dispatch()`, so two concurrent calls can never take
 *  each other's answer. The cell is the action's own prefix (`cell:method`) —
 *  the cell that owns the method, and the one that records a refusal for it.
 *
 *  Returns an `AioError`, not a bare string. The ack path's job is to tell the
 *  caller apart three failures — refused by the gate, refused by the reduce,
 *  thrown by the app — and a string can only carry the first two as WORDING,
 *  which `docs/basics/semver-policy.md` refuses to freeze. `ACTION_REFUSED` is
 *  the classification; `errorFields()` puts it on the wire; `errorCode(err)`
 *  reads it back on the caller. One shape, one decider, both transports. */
export function _dispatchRefusal(action: unknown): AioError | null {
  if (!action || typeof action !== "object") return null;
  const type = (action as { type?: unknown }).type;
  if (typeof type !== "string") return null;
  const ci = type.indexOf(":");
  if (ci <= 0) return null;
  const cellName = type.slice(0, ci);
  const hit = takeRejectionFor(action, cellName);
  if (!hit) return null;
  return createAioError("ACTION_REFUSED", hit.reason, {
    cellName,
    actionType: type,
  });
}

// ── Short calls ──────────────────────────────────────────────────────────────
//
// A call that supplies fewer arguments than the method DECLARES runs with
// `undefined` in the gaps — a warning, not a refusal (`fn.length` stops at the
// first defaulted parameter, so refusing on the count would break a method
// that fills its own in). The trojan door already told its caller so, in a
// `short` field beside `ok: true`; the WS and UDS doors said nothing, so the
// same frame was "fine" on two doors and "short" on the third (h4 doors.ts).
//
// Computed ONCE, in `dispatchNetwork` (the one place every door passes), and
// keyed to the action object exactly like a refusal, so a concurrent call can
// never read another call's note. Compat: nothing is refused that ran before.

const _shortNotes = new WeakMap<object, string>();

/** The one sentence every door says about a short call. `supplied` is the
 *  positional count the call carried (0 for no `args` array at all). */
export function shortCallSentence(
  type: string,
  required: number,
  supplied: number,
): string {
  const missing = Math.max(0, required - supplied);
  return `${type} declares ${required} argument${
    required === 1 ? "" : "s"
  } and this call passed ${supplied} — the missing one${
    missing === 1 ? " is" : "s are"
  } \`undefined\` inside the method. If it fills its own in, give ` +
    `the parameter a default in the SIGNATURE (\`(s, x = 0)\`), ` +
    `which is what makes its optionality visible — a TypeScript \`?\` ` +
    `alone does not (it is erased; only a default is).`;
}

/** Record that `action` is a short call. @internal */
export function _noteShortCall(action: unknown, sentence: string): void {
  if (action && typeof action === "object") _shortNotes.set(action, sentence);
}

/** The short-call note for `action`, if `dispatchNetwork` recorded one —
 *  read on the ack path so `{cid, ok:true, value, short}` reaches the caller. */
export function _dispatchShort(action: unknown): string | undefined {
  return action && typeof action === "object"
    ? _shortNotes.get(action)
    : undefined;
}

// ── `unsaved`: applied, acked — and NOT durable ─────────────────────────
// A write whose journal line could not be written (a refused append, a
// redacted cell's state) is made durable by a SAVE instead, and every ack
// waits for it (`_durableFor`, below). When that save fails, the call still
// ran — `ok: true` stays true — but the caller is told the write is not on
// disk, in the same `unsaved` field and sentence the trojan reply already
// carries (`PERSIST_REFUSED`). One note per action (or per async call, whose
// ack comes at the method's end), read by every door.
const _unsavedNotes = new WeakMap<object, string>();
const _unsavedCalls = new Map<string, string>();

/** Record that what `action` (or async call `callId`) owes did not land.
 *  @internal */
export function _noteUnsaved(
  action: object | undefined,
  callId: string | undefined,
  sentence: string,
): void {
  if (action) _unsavedNotes.set(action, sentence);
  if (callId !== undefined) {
    if (_unsavedCalls.size >= 1024) {
      _unsavedCalls.delete(_unsavedCalls.keys().next().value!);
    }
    _unsavedCalls.set(callId, sentence);
  }
}

/** The `unsaved` sentence for `action`'s ack, if its stand-in save failed —
 *  keyed by the frame object, or by the async call id it carries.
 *  @decider */
export function _dispatchUnsaved(action: unknown): string | undefined {
  if (!action || typeof action !== "object") return undefined;
  const direct = _unsavedNotes.get(action);
  if (direct !== undefined) return direct;
  const call = (action as { payload?: { _callId?: unknown } }).payload
    ?._callId;
  if (typeof call !== "string") return undefined;
  const v = _unsavedCalls.get(call);
  _unsavedCalls.delete(call);
  return v;
}

// ── What an ack waits for ────────────────────────────────────────────────
// The saves an action's commit OWES (aio.ts `_owe` records them per action,
// per boot) are read here, once, by every door that acks: dispatch, the sync
// handler (`durableFor`), the trojan jump. Moved out of aio.ts's closure so
// the one decider is a function a test can hold still.

/** The verdict of a set of owed saves: `undefined` when every one landed,
 *  else each distinct failure sentence, joined. */
export function _owedVerdict(
  owed: Set<Promise<string | undefined>>,
): Promise<string | undefined> {
  return Promise.all(owed).then((vs) => {
    const failed = [...new Set(vs.filter((v) => v !== undefined))];
    return failed.length === 0 ? undefined : failed.join("; ");
  });
}

/** What must be durable before `action` may be acked, as its verdict —
 *  `undefined` when nothing is owed. Read-and-clear: the entry is taken, so
 *  a second ack of the same frame waits for nothing it already waited for.
 *  @decider */
export function _durableFor(
  owedByAction: WeakMap<object, Set<Promise<string | undefined>>>,
  action: object,
): Promise<string | undefined> | undefined {
  const owed = owedByAction.get(action);
  owedByAction.delete(action);
  return owed === undefined ? undefined : _owedVerdict(owed);
}
