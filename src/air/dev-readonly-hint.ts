// AIO-4.4 — Dev hint that maps the "Cannot assign to read only property"
// error to AIO2 (state is read-only; call a cell method to change it).
// Wired up in browser-protocol.ts on first signal use in dev mode.

const _hinted = new Set<string>();

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
  };
  if (typeof target.addEventListener !== "function") return;

  target.addEventListener("error", (ev: {
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
  });
}

/** Reset hint tracking — for tests. */
export function _resetReadOnlyHint(): void {
  _hinted.clear();
  (globalThis as Record<string, unknown>).__aioReadOnlyHintInstalled = false;
}
