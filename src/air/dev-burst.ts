// dev-burst.ts — the render-burst tripwire: a component that re-rendered 50
// times in under a second, said with who wrote, from where, and which
// dependencies fired. Dev layer (air/dev-air.ts): it reads a clock and keeps a
// window per counted render, and its three messages are prose for a person.
import type { ComponentInstance } from "./renderer-types.ts";
import { _componentName } from "./hook-error.ts";

const DEV_RENDER_LIMIT = 50;

/** What scheduled an instance's latest counted render (dev only). */
const _devOrigin = new WeakMap<
  ComponentInstance,
  "render" | "lifecycle" | "push"
>();

/** …and WHO: the component whose body wrote, or the lifecycle hook that did. */
const _devWriter = new WeakMap<ComponentInstance, string>();

/** Dev only: dependency name → when it last fired a render of this instance.
 *
 *  A TIME, not a set. `_triggerSignals` is the DevTools feed and is emptied
 *  only while a DevTools handle is attached, so with nobody looking it is
 *  every dependency that ever fired this instance — and the burst message was
 *  reading it as "the dependencies that fired THESE renders". A value that
 *  fired once at boot got listed beside the stream that is actually looping,
 *  which is the reader hunting a dependency that had nothing to do with it:
 *  the same class of lie this whole tripwire was fixed for. The message's
 *  window is one second, so the answer has to be too. */
const _devFiredAt = new WeakMap<ComponentInstance, Map<string, number>>();

/** The named signals whose change fired this instance's renders IN THE BURST
 *  WINDOW, as one clause — the tripwire's "which dependency did this?" half.
 *
 *  A burst message that cannot name what fired the renders leaves the reader
 *  with the whole component to bisect (a field report asked for exactly this).
 *  Unnamed signals answer `anonymous`, which says nothing, so they are dropped
 *  and the one-liner that gives them names is offered instead. Cell signals are
 *  named after their cell, so the common case reads
 *  `fired by: cell:chat, streaming`. */
function _firedBy(inst: ComponentInstance, now: number): string {
  const cutoff = now - 1000;
  const fired = _devFiredAt.get(inst);
  const all = fired
    ? [...fired].filter(([, at]) => at >= cutoff).map(([n]) => n)
    : [];
  const named = all.filter((n) => n && n !== "anonymous");
  if (named.length > 0) {
    return ` The renders were fired by: ${named.slice(0, 6).join(", ")}${
      named.length > 6 ? `, … (${named.length} in all)` : ""
    }.`;
  }
  return all.length > 0
    ? ` The signals that fired them are unnamed — \`signal(value, "name")\` ` +
      `makes this message name them.`
    : "";
}

/** What asked for this render: a lifecycle hook, a render body (its
 *  component's name), or neither — a push from outside. */
export function _renderAsked(
  inst: ComponentInstance,
  hook: string | null | undefined,
  body: string | null,
): void {
  _devOrigin.set(inst, hook ? "lifecycle" : body !== null ? "render" : "push");
  _devWriter.set(inst, hook ?? body ?? "");
}

/** A dependency fired a render of `inst` — WHEN, for the one-second window. */
export function _depFired(inst: ComponentInstance, label: string): void {
  let fired = _devFiredAt.get(inst);
  if (!fired) _devFiredAt.set(inst, fired = new Map());
  fired.set(label, performance.now());
}

/** Count this render in the instance's window, and say so at the limit. */
export function _renderBurst(inst: ComponentInstance): void {
  const now = performance.now();
  const window = inst._devRenderTimestamps ?? [];
  // Evict timestamps older than 1 second
  const cutoff = now - 1000;
  let i = 0;
  while (i < window.length && window[i]! < cutoff) i++;
  if (i > 0) window.splice(0, i);
  window.push(now);
  inst._devRenderTimestamps = window;
  if (window.length === DEV_RENDER_LIMIT) {
    const name = _componentName(inst.vnode.tag);
    const origin = _devOrigin.get(inst) ?? "push";
    const writer = _devWriter.get(inst) ?? "";
    const head =
      `[aio-dev] ${name} re-rendered ${DEV_RENDER_LIMIT} times in under a second`;
    console.warn(
      origin === "render"
        ? `${head} — ${
          writer && writer !== name ? `<${writer}>'s render is` : "a render is"
        } WRITING state that ${
          writer && writer !== name ? "this render" : "the same render"
        } READS, so every render schedules the next one.${
          _firedBy(inst, now)
        } ` +
          `Two fixes: move the write into an event handler or onMount (a ` +
          `render must only read), or wrap the read in untrack(() => …) if ` +
          `the value is genuinely a one-shot initialisation that must not ` +
          `subscribe.`
        : origin === "lifecycle"
        ? `${head} — its ${writer} callback is WRITING state this render ` +
          `READS, so every render schedules the next one.${
            _firedBy(inst, now)
          } ` +
          `Write only when the value really changed (compare first), or read ` +
          `it with untrack(() => …) so the write cannot feed back.`
        // NOT "a render is writing": nothing of ours was on the stack when
        // the write happened, so the renders are driven from outside and
        // naming a render-write sends the reader hunting for code that does
        // not exist (a field report).
        : `${head} from writes made outside any render, lifecycle callback ` +
          `or event handler — a server push, a timer, a promise, a socket.` +
          `${
            _firedBy(inst, now)
          } For a text input bound to a cell (one push per ` +
          `keystroke re-renders every reader), keep the draft in useLocal ` +
          `and commit it on blur/submit; for a timer or a stream, throttle ` +
          `or batch the writes.`,
    );
  }
}
