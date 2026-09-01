/**
 * @module
 * Live-client UI surface executor — serves the semantic UI surface and runs
 * faithful triggers inside a running app (browser / electron / android
 * WebView), on request from the server over the "ui-surface"/"ui-trigger"
 * channel. This is what `am surface` / `am trigger` talk to; it shares the
 * exact trigger implementation with `testUI`, so a test and an `am` session
 * behave identically. Dev-tooling: routed only in dev/authorized channels.
 */
import { _liveRoots } from "./renderer-state.ts";
import {
  buildUISurface,
  serializeSurface,
  type UIElementInfo,
  type UISurfaceNode,
} from "./ui-surface.ts";
import {
  triggerAction,
  triggerChar,
  triggerClear,
  triggerDragTo,
  triggerScroll,
  triggerSelect,
  triggerSetChecked,
} from "./ui-trigger.ts";
import { count } from "../diagnostics/fmt.ts";

/** A trigger request from the server (a "ui-trigger" frame payload). */
export type UITriggerRequest = {
  /** Element path on the surface, e.g. "App/TodoAdd:AddButton" */
  path: string;
  /** Action to perform — the full `testUI` action set (both tiers behave
   *  identically). */
  action:
    | "click"
    | "dblclick"
    | "type"
    | "press"
    | "keyDown"
    | "keyUp"
    | "hover"
    | "focus"
    | "blur"
    | "select"
    | "check"
    | "uncheck"
    | "clear"
    | "scroll"
    | "dragTo";
  /** Text for `type`; value for `select`; target element path for `dragTo`;
   *  offsets for `scroll` (e.g. "top=200" or "top=200 left=0") */
  text?: string;
  /** Key for `press`/`keyDown`/`keyUp` (default "Enter") */
  key?: string;
  /** Modifier flags for `press`/`keyDown`/`keyUp` — Ctrl/Cmd/Alt/Shift chords
   *  (e.g. Ctrl+Enter). */
  mods?: {
    ctrlKey?: boolean;
    metaKey?: boolean;
    altKey?: boolean;
    shiftKey?: boolean;
  };
};

/** Result sent back for a trigger request. */
export type UITriggerResult = {
  ok: boolean;
  path: string;
  action: string;
  error?: string;
  /** Element paths available at request time — returned on misses so callers
   *  (humans or AI) can self-correct without another round-trip. */
  available?: string[];
  /** The fresh serialized surface after the action settled — act → observe in
   *  a single round-trip (the natural agent loop). */
  surface?: UISurfaceNode[];
};

/** Build the live semantic surface of every mounted root. `full` lifts the text
 *  cap — `am surface --full`, for reading a long generated string that the
 *  scannable default would (visibly) cut. */
export function getLiveSurfaces(full = false): UISurfaceNode[] {
  const out: UISurfaceNode[] = [];
  for (const state of _liveRoots) {
    if (state.disposed) continue;
    const s = buildUISurface(
      state.vnode as Parameters<typeof buildUISurface>[0],
      full ? { maxText: Number.MAX_SAFE_INTEGER } : undefined,
    );
    if (s) out.push(s);
  }
  return out;
}

/** Wire-safe serialized surfaces (the "ui-surface-result" payload). */
export function getSerializedSurfaces(full = false): UISurfaceNode[] {
  return getLiveSurfaces(full).map(serializeSurface);
}

function findByPath(path: string): UIElementInfo | undefined {
  for (const root of getLiveSurfaces()) {
    const stack: UISurfaceNode[] = [root];
    while (stack.length) {
      const n = stack.pop()!;
      for (const e of n.elements) if (e.path === path) return e;
      stack.push(...n.children);
    }
  }
  return undefined;
}

function allPaths(): string[] {
  const out: string[] = [];
  for (const root of getLiveSurfaces()) {
    const stack: UISurfaceNode[] = [root];
    while (stack.length) {
      const n = stack.pop()!;
      for (const e of n.elements) out.push(e.path);
      stack.push(...n.children);
    }
  }
  return out;
}

const settle = () => new Promise((r) => setTimeout(r, 60));

/** The reserved path for a key that belongs to the WINDOW, not to an element.
 *
 *  `onGlobalKey` — the primitive for "Escape closes the lightbox", "⌘K opens
 *  the palette" — registers on the document, so no element on the surface OWNS
 *  the binding. From `testUI` the workaround is documented and fine
 *  (`ui.<anything>.press("Escape")` bubbles up). From `am` it is not: every
 *  path names an element, and the obvious candidates are the wrong ones — an
 *  input is skipped by `ignoreInInput`, and anything else is a guess about
 *  someone's DOM. So the app's primary keyboard gesture was undrivable from
 *  the CLI, with a reply that read like a missing element.
 *
 *  This is the address for it. Key actions only: a click or a `type` on the
 *  window is not a gesture a user can make, and silently accepting one would
 *  report ok for an interaction that did nothing. */
const WINDOW_PATH = "window";
const KEY_ACTIONS = new Set(["press", "keyDown", "keyUp"]);

/** The document to dispatch a window-level event on. Dispatching on the
 *  DOCUMENT (not `document.body`) is what reaches both listener homes: a
 *  document listener sees it directly and a `window` listener sees it as the
 *  last hop of propagation — and the event's target has no `tagName`, so
 *  `ignoreInInput` correctly does not treat it as typing into a field. */
// deno-lint-ignore no-explicit-any
function windowTarget(): any | null {
  for (const st of _liveRoots) {
    const doc = (st.root as { ownerDocument?: unknown } | undefined)
      ?.ownerDocument;
    if (doc) return doc;
  }
  return (globalThis as { document?: unknown }).document ?? null;
}

/** Execute a trigger request against the live surface — same event sequences
 *  as `testUI` (shared `ui-trigger`), re-resolving between typed characters so
 *  controlled inputs behave. Resolves after the app had time to re-render. */
export async function runUITrigger(
  req: UITriggerRequest,
): Promise<UITriggerResult> {
  const base = { path: req.path, action: req.action };
  try {
    if (req.path === WINDOW_PATH) {
      if (!KEY_ACTIONS.has(req.action)) {
        return {
          ...base,
          ok: false,
          error: `"${WINDOW_PATH}" is the address for a WINDOW-LEVEL KEY ` +
            `(onGlobalKey) — "${req.action}" needs an element. ` +
            `Accepted here: ${[...KEY_ACTIONS].join(", ")}.`,
          available: allPaths(),
        };
      }
      const doc = windowTarget();
      if (!doc) {
        return { ...base, ok: false, error: `no document on this client` };
      }
      triggerAction(
        doc,
        req.action as "press" | "keyDown" | "keyUp",
        req.key,
        req.mods,
      );
      await settle();
      return { ...base, ok: true, surface: getSerializedSurfaces() };
    }
    const info = findByPath(req.path);
    if (!info || !info._el) {
      return {
        ...base,
        ok: false,
        error: `element not found on the live surface`,
        // `window` is a real address and does not appear on the surface, so a
        // miss that lists only elements hides the one answer for a key that
        // belongs to no element.
        available: [WINDOW_PATH, ...allPaths()],
      };
    }
    if (req.action === "type") {
      (info._el as HTMLElement).focus?.();
      let typed = 0;
      for (const ch of req.text ?? "") {
        // Re-resolve between characters (controlled inputs re-render). A MISS
        // used to fall back to the element captured before the first
        // keystroke — by then detached from the document, so the remaining
        // characters went into a node no user can see and the reply still said
        // `ok: true`. If the control left the surface mid-word, say so.
        const fresh = findByPath(req.path);
        if (!fresh?._el || (fresh._el as Element).isConnected === false) {
          throw new Error(
            `"${req.path}" left the live surface after ${
              count(typed, "character")
            } ` +
              `— the rest of ${JSON.stringify(req.text ?? "")} was not typed`,
          );
        }
        triggerChar(fresh._el, ch);
        typed++;
        await new Promise((r) => setTimeout(r, 0));
      }
    } else if (req.action === "select") {
      triggerSelect(info._el, req.text ?? "");
    } else if (req.action === "clear") {
      triggerClear(info._el);
    } else if (req.action === "check" || req.action === "uncheck") {
      // ONE guard, shared with testUI: `el.checked` is `undefined` on a
      // <button>, so the old `el.checked !== want` comparison clicked anything
      // it was pointed at and reported ok.
      triggerSetChecked(info._el, req.action === "check", { name: req.path });
    } else if (req.action === "scroll") {
      const to: { top?: number; left?: number } = {};
      for (const m of (req.text ?? "").matchAll(/(top|left)\s*=\s*(-?\d+)/g)) {
        to[m[1] as "top" | "left"] = Number(m[2]);
      }
      triggerScroll(info._el, to);
    } else if (req.action === "dragTo") {
      const dst = findByPath(req.text ?? "");
      if (!dst || !dst._el) {
        return {
          ...base,
          ok: false,
          error: `dragTo target "${req.text}" not found on the live surface`,
          available: allPaths(),
        };
      }
      triggerDragTo(info._el, dst._el);
    } else {
      triggerAction(info._el, req.action, req.key, req.mods);
    }
    await settle();
    return { ...base, ok: true, surface: getSerializedSurfaces() };
  } catch (e) {
    return { ...base, ok: false, error: String(e) };
  }
}
