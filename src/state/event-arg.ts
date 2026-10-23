/**
 * @module
 * A DOM Event landing in a method parameter — said, by name, once.
 *
 * `<input onInput={form.setTitle}>` hands `setTitle(s, v)` the browser's
 * Event, not the text. Nothing said so: the Event went into the draft and
 * what surfaced was four warnings about symbol keys and frozen accessors,
 * then a TypeError blaming "a write to cell state" (measured).
 *
 * WARNED, never refused — two shapes pass an Event and WORK:
 * `onClick={counter.inc}` (the method declares no parameter, the Event is
 * ignored) and a client cell's `onTitle(s, e) { s.title = e.target.value }`.
 * So it fires only when the Event lands in a parameter the method DECLARES,
 * and it is a hint beside whatever happens next, never a change to it.
 */
import { declaredArgCount } from "./arg-arity.ts";

/** Is `v` a DOM Event (any realm — happy-dom's is not the global `Event`)? */
export function isDomEvent(
  v: unknown,
): v is { type: string; constructor?: { name?: string } } {
  if (typeof v !== "object" || v === null) return false;
  const e = v as Record<string, unknown>;
  return typeof e.type === "string" && "currentTarget" in e &&
    typeof e.preventDefault === "function" &&
    typeof e.stopPropagation === "function";
}

/** `args` with each DOM Event that lands PAST the parameters `fn` declares
 *  replaced by what the wire makes of it anyway — `{ isTrusted }`, the
 *  Event's one own enumerable property, so the frame is byte-identical.
 *
 *  For the browser stub's action creator. `onClick={counter.inc}` and the
 *  kit's `<Input onInput={form.setName}>` (it passes `(value, e)`) hand the
 *  method an Event it never reads; the wire's lossy check then warned, in dev
 *  AND prod, that "the server receives DIFFERENT values than the caller
 *  passed" — on the pattern this module's own hint recommends, while `testUI`
 *  (which applies this same arity rule) stayed quiet. An Event in a DECLARED
 *  parameter is left alone: that one is a real bug, and its warning stands.
 *  Unchanged when the arity cannot be read (a rest parameter). Pure. */
export function plainUnreadEvents(
  fn: unknown,
  args: unknown[],
): unknown[] {
  if (typeof fn !== "function" || !args.some(isDomEvent)) return args;
  const declared = declaredArgCount(fn as (...a: never[]) => unknown);
  if (declared === null) return args;
  return args.map((a, i) =>
    i >= declared && isDomEvent(a)
      ? { isTrusted: (a as { isTrusted?: unknown }).isTrusted === true }
      : a
  );
}

/** The hint for `cell.key(...args)` when a DOM Event sits in a parameter
 *  `fn` declares, else null. Pure. */
export function eventArgWarning(
  cell: string,
  key: string,
  fn: unknown,
  args: readonly unknown[],
): string | null {
  const at = args.findIndex(isDomEvent);
  if (at < 0 || typeof fn !== "function") return null;
  const declared = declaredArgCount(fn as (...a: never[]) => unknown);
  if (declared !== null && at >= declared) return null; // ignored by the method
  const ev = args[at] as { type: string; constructor?: { name?: string } };
  const kind = ev.constructor?.name || "Event";
  return `${cell}.${key}() got a DOM ${kind} ("${ev.type}") as argument ` +
    `${at + 1} — a raw element handler passes the EVENT, not the value. If ` +
    `you meant the value: onInput={(e) => ${cell}.${key}(e.currentTarget.value)}, ` +
    `or the kit's <Input onInput={${cell}.${key}}> (it passes the string). ` +
    `Said once per method.`;
}
