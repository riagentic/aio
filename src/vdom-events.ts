// VDOM event delegation — single root listener per event type instead of per-element.
// Non-bubbling events (focus, blur, scroll, etc.) remain per-element.

// ── Delegated event set ────────────────────────────────────────────
// Common bubbling events use a single root listener instead of per-element
// addEventListener. This reduces listener count from O(elements) to O(event types).
export const _DELEGATED_EVENTS = new Set([
  "click",
  "dblclick",
  "mousedown",
  "mouseup",
  "mousemove",
  "contextmenu",
  "keydown",
  "keyup",
  "keypress",
  "input",
  "change",
  "submit",
  "reset",
  "pointerdown",
  "pointerup",
  "pointermove",
  "touchstart",
  "touchend",
  "touchmove",
  "touchcancel",
  "dragstart",
  "dragend",
  "dragenter",
  "dragleave",
  "dragover",
  "drop",
  "drag",
  "copy",
  "cut",
  "paste",
]);

// ── Per-element wrapped listener storage ───────────────────────────
// Per-element map of { eventName -> handler } for delegated event dispatch.
const _wrappedListeners = new WeakMap<Element, Map<string, EventListener>>();

// Tracks which delegation roots have listeners registered per event type,
// and the actual listener references for proper cleanup (AIO-197).
const _delegationRoots = new WeakMap<Element, Map<string, EventListener>>();

// ── Active delegation root ─────────────────────────────────────────
// Set by renderer during mount/hydrate/rerender.
// applyProps reads this to lazily register root listeners for delegated events.
let _activeDelegationRoot: Element | null = null;

/** Get the current active delegation root. */
export function _getActiveDelegationRoot(): Element | null {
  return _activeDelegationRoot;
}

/** Set the active delegation root (called by renderer before render cycles). */
export function _setDelegationRoot(root: Element | null): void {
  _activeDelegationRoot = root;
}

// ── Delegation management ──────────────────────────────────────────

/** Register a delegated event listener on the root element. */
export function _ensureDelegation(root: Element, evt: string): void {
  if (!_DELEGATED_EVENTS.has(evt)) return;
  let registered = _delegationRoots.get(root);
  if (!registered) {
    registered = new Map();
    _delegationRoots.set(root, registered);
  }
  if (registered.has(evt)) return;
  const listener = (e: Event) => {
    // Walk composedPath to handle shadow DOM correctly. For each element in the
    // path (target→root), check if it has a handler for this event type.
    const path = e.composedPath();
    for (const node of path) {
      if (node === root) break; // Don't go above mount root
      // Duck-type Element check (nodeType 1) — avoid instanceof which fails
      // in test environments (happy-dom) where global Element is undefined.
      if ((node as Node).nodeType !== 1) continue;
      const handler = _wrappedListeners.get(node as Element)?.get(evt);
      if (handler) {
        // AIO-281: catch handler errors to prevent parent handlers from being skipped
        try {
          handler(e);
        } catch (err) {
          console.error("[aio] event handler error:", err);
        }
        // Respect stopPropagation — check if propagation was stopped
        if (e.cancelBubble) break;
      }
    }
  };
  registered.set(evt, listener);
  root.addEventListener(evt, listener);
}

/** Remove all delegated listeners from a root element. AIO-197: properly
 *  calls removeEventListener to prevent listener accumulation on root reuse. */
export function _teardownDelegation(root: Element): void {
  const registered = _delegationRoots.get(root);
  if (registered) {
    for (const [evt, listener] of registered) {
      root.removeEventListener(evt, listener);
    }
  }
  _delegationRoots.delete(root);
}

/** Check if an event type is delegated. */
export function _isDelegated(evt: string): boolean {
  return _DELEGATED_EVENTS.has(evt);
}

// ── Wrapped listener accessors ─────────────────────────────────────

export function _getWrapped(
  el: Element,
  evt: string,
): EventListener | undefined {
  return _wrappedListeners.get(el)?.get(evt);
}

export function _setWrapped(el: Element, evt: string, fn: EventListener): void {
  let map = _wrappedListeners.get(el);
  if (!map) {
    map = new Map();
    _wrappedListeners.set(el, map);
  }
  map.set(evt, fn);
}

export function _deleteWrapped(el: Element, evt: string): void {
  const map = _wrappedListeners.get(el);
  if (!map) return;
  map.delete(evt);
  if (map.size === 0) {
    _wrappedListeners.delete(el);
  }
}

// ── onChange → onInput mapping (AIO-72: React compat) ──────────────
// React's onChange fires on every keystroke (it's actually onInput under the hood).
// Native DOM onChange fires on blur. Map onChange→input for form elements so
// React migrants get expected behavior. Applied in applyProps + _hydrateProps.
export const _CHANGE_TARGETS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

/** Map React-style event names to native DOM equivalents.
 *  @param hasOnInput — pass true when both onChange and onInput are on the same element
 *  to avoid collision (AIO-166). When true, onChange keeps native "change" semantics. */
export function _mapEventName(
  evt: string,
  el: Element,
  hasOnInput?: boolean,
): string {
  if (evt === "change" && _CHANGE_TARGETS.has(el.tagName) && !hasOnInput) {
    return "input";
  }
  if (evt === "doubleclick") return "dblclick"; // AIO-165
  return evt;
}
