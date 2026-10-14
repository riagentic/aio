// dev-events.ts — the typo lint over `on*` prop names. Dev layer
// (air/dev-air.ts): a production bundle carries neither the list nor the line.
import { _DELEGATED_EVENTS } from "./vdom-events.ts";

// ── AIO-7.2: dev-mode unknown-event guard ───────────────────────────
// React's common events all lowercase correctly except the aliased ones above;
// an on* prop whose derived name isn't a known DOM event silently never fires.
// Warn once per event name in dev so typos surface immediately.
// Built on first use: this module is evaluated while vdom-events.ts (which
// reaches it through dev-hooks.ts) may still be loading.
let _known: Set<string> | null = null;
const _knownEvents = (): Set<string> =>
  _known ??= new Set([
    ..._DELEGATED_EVENTS,
    "mouseenter",
    "mouseleave",
    "mouseover",
    "mouseout",
    "wheel",
    "beforeinput",
    "focus",
    "blur",
    "focusin",
    "focusout",
    "select",
    "invalid",
    "pointerenter",
    "pointerleave",
    "pointerover",
    "pointerout",
    "pointercancel",
    "gotpointercapture",
    "lostpointercapture",
    "scroll",
    "resize",
    "load",
    "error",
    "abort",
    "transitionend",
    "transitionstart",
    "transitionrun",
    "transitioncancel",
    "animationstart",
    "animationend",
    "animationiteration",
    "compositionstart",
    "compositionend",
    "compositionupdate",
    "play",
    "pause",
    "ended",
    "timeupdate",
    "volumechange",
    "seeked",
    "seeking",
    "loadedmetadata",
    "loadeddata",
    "canplay",
    "canplaythrough",
    "durationchange",
    "toggle",
    "close",
    "cancel",
    "open",
  ]);
const _warnedEvents = new Set<string>();

export function _warnUnknownEvent(evt: string, el: Element): void {
  if (!(globalThis as Record<string, unknown>).__aioDev) return;
  if (_knownEvents().has(evt) || _warnedEvents.has(evt)) return;
  // Custom elements dispatch arbitrary CustomEvents — don't warn for them.
  if (el.tagName.includes("-")) return;
  _warnedEvents.add(evt);
  console.warn(
    `[air] unknown event "${evt}" — the handler will never fire. ` +
      `Check the prop name casing (e.g. onDoubleClick → dblclick).`,
  );
}

/** Forget which unknown events were named — `setDevMode()` re-arms a session. */
export function _resetEventWarnings(): void {
  _warnedEvents.clear();
}
