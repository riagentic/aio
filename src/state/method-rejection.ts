// A method that throws is either saying NO on purpose or has a bug.
//
// `throw new Error("not an email address")` is the documented way for a method
// to refuse (docs/state/transactional-methods.md: `throw new Error(
// "insufficient")`): the state stays untouched and the caller's `await`
// rejects with that error, which the UI shows. aio used to print every such
// refusal as a red ERROR box — `[REDUCE_ERROR] … fix: check action payload
// shape and inspect state at crash` — each time a user mistyped an email.
// Advice for a crash, on correct code: a warning that cries wolf, which teaches
// people to ignore the next one (a field report). Found by
// tests/correct-code-is-silent.test.ts crawling the contacts example.
//
// So the REPORT distinguishes the two. What is NOT changed: the caller still
// rejects with the same error, the app's `onError` hook still receives it,
// and the log still records it — only the console level and the wording
// differ (observe-only). Anything that looks like a bug keeps the loud box.

/** A write the REDUCE refused (a `validate` hook, a disabled cell), thrown
 *  under `refusalsReject`. The wire answers that call ACTION_REFUSED
 *  (action-ack.ts); an in-process caller — every harness, and an app with the
 *  flag on — was answered REDUCE_ERROR for the same refusal, so a branch on
 *  `errorCode(e) === "ACTION_REFUSED"` passed in the browser and not in its
 *  test. The class carries the classification to whoever wraps the throw. */
export class RefusedWrite extends Error {}

/** The cell whose code threw inside ANOTHER cell's action — a `listensTo`
 *  handler. Its throw still fails the whole action, but it is that cell's
 *  error: charged to the action's prefix, the circuit breaker disabled the
 *  innocent source and left the broken listener running. */
const _thrower = new WeakMap<object, string>();

/** Record that `cell` threw `e` while reducing a foreign action. */
export function markThrower(e: unknown, cell: string): void {
  if (e !== null && typeof e === "object") _thrower.set(e, cell);
}

/** The cell `markThrower` recorded for `e`, if any. */
export function throwerOf(e: unknown): string | undefined {
  return e !== null && typeof e === "object" ? _thrower.get(e) : undefined;
}

/** The code an in-process caller gets for what a reduce threw. */
export function reduceThrowCode(e: unknown): "ACTION_REFUSED" | "REDUCE_ERROR" {
  return e instanceof RefusedWrite ? "ACTION_REFUSED" : "REDUCE_ERROR";
}

/** Refusals whose `code` was added after the fact (1.0.23): the code is for
 *  `errorCode(e)` only and must not change how the refusal is classified. */
const _additiveCode = new WeakSet<object>();

/** Give a refusal a stable `code` WITHOUT changing its classification: below,
 *  any other `code` reads as "aio's own error, a bug", and these refusals were
 *  classified by their class and message before they had one (a harness's
 *  `alert()` refusal thrown inside a method was, and stays, deliberate). */
export function withRefusalCode<E extends Error>(e: E, code: string): E {
  _additiveCode.add(e);
  return Object.assign(e, { code });
}

/** Refusals aio raises on the app's behalf — an `args` rule saying no to a
 *  caller's input. Their `[cell:method]` prefix would otherwise read as aio's
 *  own error, and a mistyped form value printed the crash box. */
const _framed = new WeakSet<object>();

/** Mark an error aio throws for a deliberate refusal (see `_framed`). */
export function markRefusal<E extends Error>(e: E): E {
  _framed.add(e);
  return e;
}

/** Engine error classes: a method that throws one of these has a bug. */
const BUG_CLASSES = new Set([
  "TypeError",
  "ReferenceError",
  "SyntaxError",
  "RangeError",
  "EvalError",
  "URIError",
  "AggregateError",
  "InternalError",
]);

/** Did the method throw this ON PURPOSE — a refusal, not a crash?
 *
 *  Yes: a plain `Error` (or an app's own subclass) with the method's own
 *  message, or a thrown string. No — a bug, reported loudly as before: an
 *  engine error class, anything carrying a `code` (aio's own errors, Deno and
 *  Node system errors), a message in aio's or Immer's `[tag]` form, and a
 *  write to frozen state (whose engine text is a TypeError anyway). */
export function isDeliberateRejection(e: unknown): boolean {
  if (typeof e === "string") return e.length > 0;
  if (!(e instanceof Error)) return false;
  // The sync method runner WRAPS what the method threw in a plain Error
  // carrying `cell`/`method`, with the original as `cause` — judged as is, a
  // TypeError from a real bug read as a refusal (measured, in this change's
  // own extra check). Judge the whole cause chain: any bug in it is a bug.
  // An aio-raised refusal anywhere in the chain (the sync runner wraps it).
  for (
    let x: unknown = e, depth = 0;
    x instanceof Error && depth < 8;
    x = x.cause, depth++
  ) if (_framed.has(x)) return true;
  for (
    let x: unknown = e, depth = 0;
    x instanceof Error && depth < 8;
    x = x.cause, depth++
  ) {
    if (BUG_CLASSES.has(x.name)) return false;
    if (
      (x as { code?: unknown }).code !== undefined && !_additiveCode.has(x)
    ) return false;
    if (x.message.startsWith("[")) return false;
  }
  return e.message.length > 0;
}

/** The one line a refusal prints (info level).
 *
 *  `committed`: the method is an async, NON-transactional one that had
 *  already written before it threw. Those writes are not rolled back — an
 *  async method commits as it goes — so "no state changed" would be a lie
 *  beside the state that did change. Only a sync method, a `transaction:
 *  true` one, or an async one that threw before writing leaves state as it
 *  was. `"tx"`: a transaction that threw after an `s.$commit()` — the
 *  published part stays, the rest is discarded. */
export function rejectionLine(
  actionType: string,
  e: unknown,
  committed: boolean | "tx" = false,
): string {
  const why = e instanceof Error ? e.message : String(e);
  if (committed === "tx") {
    return `${actionType} rejected: ${why} — the method threw it after an ` +
      `\`s.$commit()\`: what that commit published STAYS committed, and ` +
      `only the writes after it were discarded. The caller's await rejects ` +
      `with it`;
  }
  if (committed) {
    return `${actionType} rejected: ${why} — the method threw it AFTER ` +
      `writing, and those earlier writes STAY committed (an async method ` +
      `commits as it goes; \`transaction: true\` makes it all-or-nothing). ` +
      `The caller's await rejects with it`;
  }
  return `${actionType} rejected: ${why} — the method threw it, so no state ` +
    `changed and the caller's await rejects with it`;
}
