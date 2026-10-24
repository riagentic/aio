// app-icon-client.ts — the client half of `appIcon()`: hand the spec to the
// Electron shell's `__aioWindow.icon`, which applies it in the main process.
// Anywhere else (a browser tab, Android, a test window) there is no desktop
// icon to change — said once, never silent.
import { log } from "../diagnostics/logger-api.ts";

let _said = false;
const _refusals = new Set<string>();

/** Apply an "icon" frame (or a standalone runtime's `appIcon` effect). */
export function applyAppIcon(d: unknown): void {
  const w = (globalThis as {
    __aioWindow?: { icon?: (d: unknown) => Promise<unknown> };
  }).__aioWindow;
  if (typeof w?.icon !== "function") {
    if (!_said) {
      _said = true;
      log.warn(
        "appIcon",
        "this page is not in an aio desktop window (a browser tab, Android, " +
          "a test) — appIcon() changes nothing here.",
      );
    }
    return;
  }
  // A refusal is said HERE too: the preload refuses some before the main
  // process sees them (a failed check, an app URL that answered 404), and an
  // icon that silently never changed is the bug this file must not have.
  w.icon(d).then(undefined, (e) => {
    const msg = String((e as Error)?.message ?? e);
    if (_refusals.has(msg)) return;
    _refusals.add(msg);
    log.warn("appIcon", `the icon was not changed: ${msg}`);
  });
}
