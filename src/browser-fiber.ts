// React fiber tree walker — dev-mode tools for UI inspection and click simulation.
// Used by transport layer to respond to __getState and __click: commands.

// ── Types ──────────────────────────────────────────────────────────

type _ComponentInfo = {
  component: string;
  state?: unknown;
  props?: Record<string, unknown>;
  children?: _ComponentInfo[];
};

// ── Fiber root ────────────────────────────────────────────────────

/** Find React fiber root from the DOM */
function _findFiberRoot(): Record<string, unknown> | null {
  const root = document.getElementById("root") ??
    document.getElementById("app");
  if (!root) return null;
  const fiberKey = Object.getOwnPropertyNames(root).find((k) =>
    k.startsWith("__reactFiber$") || k.startsWith("__reactContainer$") ||
    k.startsWith("__reactInternalInstance$")
  );
  if (!fiberKey) return null;
  let fiber = (root as unknown as Record<string, unknown>)[fiberKey] as
    | Record<string, unknown>
    | null;
  if (!fiber) return null;
  if (fiberKey.startsWith("__reactContainer$") && fiber.current) {
    fiber = fiber.current as Record<string, unknown>;
  }
  return fiber;
}

// ── Tree walker ───────────────────────────────────────────────────

/** Walk React fiber tree and return component info list */
export function _walkReactTree(): _ComponentInfo[] {
  const fiber = _findFiberRoot();
  if (!fiber) return [];
  const result: _ComponentInfo[] = [];
  _walkFiber(fiber, result);
  return result;
}

function _walkFiber(
  fiber: Record<string, unknown>,
  out: _ComponentInfo[],
): void {
  // tag 0 = FunctionComponent, 1 = ClassComponent, 11 = ForwardRef, 15 = SimpleMemoComponent
  const tag = fiber.tag as number;
  const type = fiber.type as ((...args: unknown[]) => unknown) | {
    displayName?: string;
    name?: string;
  } | null;

  if (type && (tag === 0 || tag === 1 || tag === 11 || tag === 15)) {
    const name = typeof type === "function"
      ? (type as { displayName?: string; name?: string }).displayName ??
        (type as { name?: string }).name ?? "Anonymous"
      : (type as { displayName?: string }).displayName ?? "Unknown";

    if (name && !name.startsWith("__") && name !== "Fragment") {
      const info: _ComponentInfo = { component: name };

      const hookState = _extractHookState(
        fiber.memoizedState as Record<string, unknown> | null,
      );
      if (hookState.length) {
        info.state = hookState.length === 1 ? hookState[0] : hookState;
      }

      const props = fiber.memoizedProps as Record<string, unknown> | null;
      if (props) {
        const cleaned: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(props)) {
          if (k === "children" || typeof v === "function") continue;
          try {
            JSON.stringify(v);
            cleaned[k] = v;
          } catch { /* non-serializable, skip */ }
        }
        if (Object.keys(cleaned).length) info.props = cleaned;
      }

      out.push(info);
    }
  }

  let child = fiber.child as Record<string, unknown> | null;
  while (child) {
    _walkFiber(child, out);
    child = child.sibling as Record<string, unknown> | null;
  }
}

function _extractHookState(
  memoizedState: Record<string, unknown> | null,
): unknown[] {
  const states: unknown[] = [];
  let hook = memoizedState;
  while (hook) {
    const queue = hook.queue as Record<string, unknown> | null;
    if (queue && "lastRenderedState" in queue) {
      const val = queue.lastRenderedState;
      try {
        JSON.stringify(val);
        states.push(val);
      } catch { /* skip */ }
    }
    hook = hook.next as Record<string, unknown> | null;
  }
  return states;
}

// ── Click handler ─────────────────────────────────────────────────

/** Find a component's fiber by name + index or name + prop match */
function _findComponentFiber(
  fiber: Record<string, unknown>,
  name: string,
  match: { index: number } | { prop: string; value: string },
  counter = { n: 0 },
): Record<string, unknown> | null {
  const tag = fiber.tag as number;
  const type = fiber.type as unknown;
  if (type && (tag === 0 || tag === 1 || tag === 11 || tag === 15)) {
    const cName = typeof type === "function"
      ? (type as { displayName?: string; name?: string }).displayName ??
        (type as { name?: string }).name
      : null;
    if (cName === name) {
      if ("index" in match) {
        if (counter.n === match.index) return fiber;
        counter.n++;
      } else {
        const props = fiber.memoizedProps as Record<string, unknown> | null;
        if (props && String(props[match.prop]) === match.value) return fiber;
      }
    }
  }
  let child = fiber.child as Record<string, unknown> | null;
  while (child) {
    const found = _findComponentFiber(child, name, match, counter);
    if (found) return found;
    child = child.sibling as Record<string, unknown> | null;
  }
  return null;
}

/** Find the nearest DOM node from a fiber (walk down to first HostComponent) */
function _fiberToDOM(fiber: Record<string, unknown>): HTMLElement | null {
  if (fiber.tag === 5 && fiber.stateNode instanceof HTMLElement) {
    return fiber.stateNode;
  }
  let child = fiber.child as Record<string, unknown> | null;
  while (child) {
    if (child.tag === 5 && child.stateNode instanceof HTMLElement) {
      return child.stateNode as HTMLElement;
    }
    const found = _fiberToDOM(child);
    if (found) return found;
    child = child.sibling as Record<string, unknown> | null;
  }
  return null;
}

/** Handle __click: command — find component and click its DOM node */
export function _handleClick(
  cmd: string,
): { ok: boolean; error?: string; clicked?: string } {
  const root = _findFiberRoot();
  if (!root) return { ok: false, error: "no React root found" };

  const parts = cmd.split(":");
  const name = parts[0];
  if (!name) return { ok: false, error: "no component name" };

  let match: { index: number } | { prop: string; value: string };
  if (parts.length === 2 && /^\d+$/.test(parts[1]!)) {
    match = { index: Number(parts[1]) };
  } else if (parts.length === 3) {
    match = { prop: parts[1]!, value: parts[2]! };
  } else {
    match = { index: 0 };
  }

  const fiber = _findComponentFiber(root, name, match);
  if (!fiber) return { ok: false, error: `component '${name}' not found` };

  const el = _fiberToDOM(fiber);
  if (!el) return { ok: false, error: `component '${name}' has no DOM node` };

  el.click();
  return { ok: true, clicked: `${name} → <${el.tagName.toLowerCase()}>` };
}
