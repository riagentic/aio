// hook-error.ts — the ONE report path for a user callback that threw inside the
// render pipeline (afterRender, onMount, onCleanup, a callback `ref`, an exit
// handler).
//
// It lives in its own dependency-free module on purpose: the COMMIT-phase
// modules (`vdom-create`, `vdom-remove`) have to report too, and they cannot
// import `renderer-flush` (which imports `vdom`) without a cycle. Zero imports
// here means every layer can reach it.
//
// The contract it exists to enforce: an effect must never be able to un-render
// the tree that scheduled it. Every call site that runs user code after (or
// during) a commit funnels its throw through here — logged loudly, NAMED, and
// then the commit stands.

/** Best-effort display name for a vnode tag — `TodoRow`, `button`. */
export function _componentName(tag: unknown): string {
  if (typeof tag === "function") {
    return (tag as { name?: string }).name || "Anonymous";
  }
  return typeof tag === "string" && tag ? tag : "Component";
}

/** Hints already printed — the error itself always logs (fail loud), but a hook
 *  that throws on EVERY render must not bury the console in the same advice. */
const _hinted = new Set<string>();

/**
 * Report an error thrown by a lifecycle hook without letting it abort the
 * render — one bad hook must never collapse the surface.
 *
 * `component` names whatever REGISTERED the callback, whenever that is knowable:
 * the symptom of a throwing effect is nowhere near its cause, and a field report
 * lost two debug cycles to exactly that distance ("the log line could at least
 * name the component, which would have pointed straight at it"). The message
 * also states that the render was kept, because the same report read a contained
 * effect failure as an abandoned render.
 *
 * Adds an actionable hint when the cause is DOM access with no DOM (testUI/SSR),
 * where the raw "document is not defined" lands far from its fix.
 */
/** Where a CONTAINED failure also goes, when someone is listening.
 *
 *  A hook that throws is contained on purpose: the render it belongs to is
 *  kept, and production logs and carries on. That is right for an app and
 *  wrong for a test — `testUI` already turns a re-render throw into a failed
 *  test through `_setRenderErrorSink`, and the two channels beside it (an
 *  `onMount` that throws, an event handler that throws) only reached
 *  `console.error`. So a `TypeError` in an `onClick` — the single most common
 *  app bug there is — was reported as a PASS. "Tests are the strictest
 *  environment" has to include the failures the framework deliberately
 *  swallows for production's sake. */
let _containedSink:
  | ((kind: string, e: unknown, component?: string) => void)
  | null = null;

/** @internal Harness seam — see `_containedSink`. */
export function _setContainedErrorSink(
  fn: ((kind: string, e: unknown, component?: string) => void) | null,
): void {
  _containedSink = fn;
}

/** @internal Tell the harness, if one is listening. Never throws: a sink that
 *  fails must not take the render with it, which is the whole point of
 *  containing the error in the first place. */
export function _notifyContained(
  kind: string,
  e: unknown,
  component?: string,
): void {
  try {
    _containedSink?.(kind, e, component);
  } catch {
    // aio-ok: a harness sink that throws must not escalate a CONTAINED
    // failure into an uncontained one — the test still gets the console line.
  }
}

export function _reportHookError(
  kind: string,
  e: unknown,
  component?: string,
): void {
  _notifyContained(kind, e, component);
  const where = component ? ` in <${component}>` : "";
  console.error(
    `[aio-renderer] ${kind} callback error${where} ` +
      `(the render it belongs to was KEPT — a contained effect failure):`,
    e,
  );
  const msg = String((e as { message?: unknown })?.message ?? e);
  if (
    /\b(document|window)\b[^]*?(is not defined|undefined)/.test(msg) &&
    typeof document === "undefined"
  ) {
    const key = `${kind}\x00${component ?? ""}\x00${msg}`;
    if (_hinted.has(key)) return;
    _hinted.add(key);
    console.error(
      `[aio-renderer] ↑ this ${kind}${where} ran without a DOM (testUI/SSR). ` +
        "Guard DOM access — `if (typeof document !== 'undefined') { … }` — " +
        "or use a `useRef` on the element instead of `document.getElementById`.",
    );
  }
}
