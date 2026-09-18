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
function isDomEvent(
  v: unknown,
): v is { type: string; constructor?: { name?: string } } {
  if (typeof v !== "object" || v === null) return false;
  const e = v as Record<string, unknown>;
  return typeof e.type === "string" && "currentTarget" in e &&
    typeof e.preventDefault === "function" &&
    typeof e.stopPropagation === "function";
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
