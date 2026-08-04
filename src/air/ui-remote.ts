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
  triggerClick,
  triggerDragTo,
  triggerScroll,
  triggerSelect,
} from "./ui-trigger.ts";

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

/** Execute a trigger request against the live surface — same event sequences
 *  as `testUI` (shared `ui-trigger`), re-resolving between typed characters so
 *  controlled inputs behave. Resolves after the app had time to re-render. */
export async function runUITrigger(
  req: UITriggerRequest,
): Promise<UITriggerResult> {
  const base = { path: req.path, action: req.action };
  try {
    const info = findByPath(req.path);
    if (!info || !info._el) {
      return {
        ...base,
        ok: false,
        error: `element not found on the live surface`,
        available: allPaths(),
      };
    }
    if (req.action === "type") {
      (info._el as HTMLElement).focus?.();
      for (const ch of req.text ?? "") {
        const fresh = findByPath(req.path) ?? info;
        triggerChar(fresh._el, ch);
        await new Promise((r) => setTimeout(r, 0));
      }
    } else if (req.action === "select") {
      triggerSelect(info._el, req.text ?? "");
    } else if (req.action === "clear") {
      triggerClear(info._el);
    } else if (req.action === "check" || req.action === "uncheck") {
      const el = info._el as Element & { checked?: boolean };
      if (el.checked !== (req.action === "check")) triggerClick(info._el);
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
