// AIO-4.4 — Dev hint that maps the "Cannot assign to read only property"
// error to AIO2 (state is read-only; call a cell method to change it).
// Wired up in browser-protocol.ts on first signal use in dev mode.

const _hinted = new Set<string>();

// Track the installed listener so _uninstallReadOnlyHint can remove it.
// deno-lint-ignore no-explicit-any
let _installedListener: ((ev: any) => void) | null = null;

/** Install a global onerror handler that, in dev, prints a hint when the
 *  user mutates frozen state. Idempotent — installs at most once. */
export function _installReadOnlyHint(): void {
  if ((globalThis as Record<string, unknown>).__aioReadOnlyHintInstalled) {
    return;
  }
  (globalThis as Record<string, unknown>).__aioReadOnlyHintInstalled = true;

  // Browser global — `window.onerror`. Deno has its own unhandled error
  // reporting, so we use `addEventListener("error", ...)` on globalThis.
  const target = globalThis as unknown as {
    addEventListener?: (
      type: string,
      // deno-lint-ignore no-explicit-any
      listener: (ev: any) => void,
    ) => void;
    removeEventListener?: (
      type: string,
      // deno-lint-ignore no-explicit-any
      listener: (ev: any) => void,
    ) => void;
  };
  if (typeof target.addEventListener !== "function") return;

  const listener = (ev: {
    message?: string;
    error?: Error;
  }) => _hintReadOnly(ev?.error ?? ev?.message);
  _installedListener = listener;
  target.addEventListener("error", listener);
}

/** Print the AIO2 hint (once, dev only) when `err` is a write to read-only
 *  state. Called by the global `error` listener above AND by AIR's event
 *  handler wrapper (via `devHooks.readOnlyHint`): a component writes state
 *  from a handler, and the wrapper CATCHES that throw so one bad handler
 *  cannot take the page — the global event never fires for it, so the
 *  listener alone never hinted the write the rule is about.
 *
 *  "only a getter" is the TOP-level write (`counter.count = 5` — a cell's
 *  state key is a getter-only property); "read only" is a nested one
 *  (`counter.box.n = 5` — committed state is frozen). */
export function _hintReadOnly(err: unknown): void {
  if ((globalThis as Record<string, unknown>).__aioDev !== true) return;
  const msg = err instanceof Error ? err.message : String(err ?? "");
  // Every engine's wording: V8 "read only" / "which has only a getter",
  // SpiderMonkey "read-only" / "getter-only", JavaScriptCore "readonly".
  if (!/read.?only|only a getter|getter-only/i.test(msg)) return;
  if (_hinted.has("readonly")) return;
  _hinted.add("readonly");
  // eslint-disable-next-line no-console
  console.info(
    "[aio] state is read-only — call a cell method to change it (rule AIO2). " +
      "Mutations from components bypass the framework and silently desync.",
  );
}

/** Uninstall the global error listener — for teardown / hot-reload so the
 *  listener doesn't accumulate across reconnects. */
export function _uninstallReadOnlyHint(): void {
  const target = globalThis as unknown as {
    removeEventListener?: (
      type: string,
      // deno-lint-ignore no-explicit-any
      listener: (ev: any) => void,
    ) => void;
  };
  if (_installedListener && typeof target.removeEventListener === "function") {
    target.removeEventListener("error", _installedListener);
  }
  _installedListener = null;
  (globalThis as Record<string, unknown>).__aioReadOnlyHintInstalled = false;
}

/** Reset hint tracking — for tests. */
export function _resetReadOnlyHint(): void {
  _hinted.clear();
  _uninstallReadOnlyHint();
}
