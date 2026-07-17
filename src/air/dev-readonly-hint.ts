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
  }) => {
    if ((globalThis as Record<string, unknown>).__aioDev !== true) return;
    const msg = ev?.error?.message ?? ev?.message ?? "";
    if (
      !/read.only|read.only property|read.only object|Cannot assign to read only/i
        .test(msg)
    ) {
      return;
    }
    if (_hinted.has("readonly")) return;
    _hinted.add("readonly");
    // eslint-disable-next-line no-console
    console.info(
      "[aio] state is read-only — call a cell method to change it (rule AIO2). " +
        "Mutations from components bypass the framework and silently desync.",
    );
  };
  _installedListener = listener;
  target.addEventListener("error", listener);
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
