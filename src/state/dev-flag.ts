// dev-flag.ts — "are we in dev?", asked once for the whole runtime.
//
// `__aioDev` on globalThis is THE flag: the dev server stamps it into the
// served shell, and every test harness arms it (`_armTestStrict`). AIR then
// grew a SECOND flag beside it — `_devMode`, in five copies (vdom-types,
// renderer-rerender, renderer-lifecycle, signal, and the a11y check), fanned
// out from the public `setDevMode()`. Nothing in the framework ever called
// that, so the entire renderer dev-warning layer — the conditional-hook
// tripwire, the infinite re-render detector, "recovered a stranded <X>, this
// is an aio scheduler bug, please report", onMount outside render, missing and
// duplicate keys, the whole a11y layer, hydration attribute parity — was
// behind a switch only an app could find. A warning behind a flag nobody sets
// is a warning that does not exist. Eleven test files armed it by hand, so
// every one of them proved the warning WORKS and none proved it was ON.
//
// So: one flag, read lazily (the shell sets `__aioDev` before the bundle runs,
// but a lazy read does not have to care about ordering), with an explicit
// override for the app that wants to force it either way.

/** `true`/`false` force it; `null` means "follow `__aioDev`". */
let _override: boolean | null = null;

/** Are dev-mode diagnostics on? */
export function isDevMode(): boolean {
  return _override ??
    (globalThis as Record<string, unknown>).__aioDev === true;
}

/** Did the APP ask for dev mode in so many words (`setDevMode(true)`)?
 *
 *  Dev diagnostics that only OBSERVE — every warning — follow `isDevMode()`
 *  and are therefore on wherever `__aioDev` is. A dev feature that CHANGES
 *  what the page contains must not be: stamping `data-component` on every
 *  component root puts an attribute in the mounted DOM that SSR does not
 *  write, so hydration parity — a real diagnostic — starts reporting a
 *  divergence the framework itself introduced. Those stay opt-in. */
export function isDevModeExplicit(): boolean {
  return _override === true;
}

/** Force dev diagnostics on or off, or pass `null` to follow `__aioDev` again.
 *
 *  The public `setDevMode()` is this with its warning caches cleared. */
export function setDevModeOverride(v: boolean | null): void {
  _override = v;
}
