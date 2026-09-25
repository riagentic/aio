// A method that throws is either saying NO on purpose or has a bug.
//
// `throw new Error("not an email address")` is the documented way for a method
// to refuse (docs/state/transactional-methods.md: `throw new Error(
// "insufficient")`): the state stays untouched and the caller's `await`
// rejects with that error, which the UI shows. aio used to print every such
// refusal as a red ERROR box — `[REDUCE_ERROR] … fix: check action payload
// shape and inspect state at crash` — each time a user mistyped an email.
// Advice for a crash, on correct code: a warning that cries wolf, which teaches
// people to ignore the next one (feedback/frustration.md F4). Found by
// tests/correct-code-is-silent.test.ts crawling the contacts example.
//
// So the REPORT distinguishes the two. What is NOT changed: the caller still
// rejects with the same error, the app's `onError` hook still receives it,
// and the log still records it — only the console level and the wording
// differ (observe-only). Anything that looks like a bug keeps the loud box.

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
  for (
    let x: unknown = e, depth = 0;
    x instanceof Error && depth < 8;
    x = x.cause, depth++
  ) {
    if (BUG_CLASSES.has(x.name)) return false;
    if ((x as { code?: unknown }).code !== undefined) return false;
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
 *  was. */
export function rejectionLine(
  actionType: string,
  e: unknown,
  committed = false,
): string {
  const why = e instanceof Error ? e.message : String(e);
  if (committed) {
    return `${actionType} rejected: ${why} — the method threw it AFTER ` +
      `writing, and those earlier writes STAY committed (an async method ` +
      `commits as it goes; \`transaction: true\` makes it all-or-nothing). ` +
      `The caller's await rejects with it`;
  }
  return `${actionType} rejected: ${why} — the method threw it, so no state ` +
    `changed and the caller's await rejects with it`;
}
