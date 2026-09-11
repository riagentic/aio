// desktop-notify.ts — the client half of `notify()`.
//
// One implementation for every renderer: the Notification API is what a
// browser, the Electron renderer (granted without a prompt) and a PWA all
// have. What differs is PERMISSION, and that is the only branch here:
//   granted  → show;
//   default  → ask once (a browser only grants from a user gesture, so an
//              unprompted ask may come back "default" — then the app calls
//              `requestNotificationPermission()` from a click and it sticks);
//   denied   → say so, once, and drop.
// A runtime with no Notification API at all (an Android WebView, a test
// window) is named too. Nothing here is silent: a notification that never
// appeared is the "it works sometimes" bug this codebase refuses.
import { log } from "../diagnostics/logger-api.ts";
import type { NotifyOptions } from "../state/notify.ts";

const _said = new Set<string>();
function _once(key: string, msg: string): void {
  if (_said.has(key)) return;
  _said.add(key);
  log.warn("notify", msg);
}

type NotificationCtor = {
  new (title: string, opts?: Record<string, unknown>): {
    onclick: ((ev: unknown) => void) | null;
    close(): void;
  };
  permission: "default" | "granted" | "denied";
  requestPermission(): Promise<"default" | "granted" | "denied">;
};

function _api(): NotificationCtor | null {
  const N = (globalThis as { Notification?: unknown }).Notification;
  return typeof N === "function" ? N as unknown as NotificationCtor : null;
}

/** Bring the app to the front — through the Electron shell when there is
 *  one (a hidden, close-to-tray window has no `window.focus()` that works),
 *  else the page's own. */
export function focusApp(): void {
  const shell = (globalThis as { __aioShell?: { focus?: () => void } })
    .__aioShell;
  if (shell?.focus) {
    shell.focus();
    return;
  }
  try {
    (globalThis as { focus?: () => void }).focus?.();
  } catch {
    // aio-ok: a page may not be allowed to focus itself; nothing to do
  }
}

/** Go to a route the way a link would: a history entry plus the `popstate`
 *  the router already listens for. No import of the router — this file is
 *  the browser runtime, which the renderer sits above, not beside. */
export function navigateTo(route: string): void {
  const g = globalThis as {
    history?: History;
    dispatchEvent?: (e: Event) => boolean;
  };
  if (!g.history || !g.dispatchEvent) return;
  g.history.pushState(null, "", route);
  // `PopStateEvent` is a browser class; a runtime without it (a test) still
  // has `Event`, and the router listens by NAME.
  const Ev =
    (globalThis as unknown as { PopStateEvent?: typeof Event }).PopStateEvent ??
      Event;
  g.dispatchEvent(new Ev("popstate"));
}

function _show(N: NotificationCtor, n: NotifyOptions): void {
  const origin = (globalThis as { location?: { origin?: string } }).location
    ?.origin ?? "";
  const note = new N(n.title, {
    body: n.body,
    tag: n.tag,
    silent: n.silent,
    // One app, one colour: the same monogram the window and the taskbar show.
    icon: `${origin}/icon.png`,
  });
  note.onclick = () => {
    focusApp();
    if (n.route) navigateTo(n.route);
    note.close();
  };
}

/** Show a desktop notification, or say exactly why it could not be shown. */
export function showDesktopNotification(n: NotifyOptions): void {
  const N = _api();
  if (!N) {
    _once(
      "unsupported",
      `this runtime has no Notification API (an Android WebView, a headless ` +
        `page, a test window) — "${n.title}" was not shown.`,
    );
    return;
  }
  if (N.permission === "granted") {
    _show(N, n);
    return;
  }
  if (N.permission === "denied") {
    _once(
      "denied",
      `desktop notifications are BLOCKED for this origin — "${n.title}" was ` +
        `not shown. The user un-blocks it in the browser's site settings; ` +
        `the app cannot.`,
    );
    return;
  }
  N.requestPermission().then(
    (p) => {
      if (p === "granted") {
        _show(N, n);
        return;
      }
      _once(
        "gesture",
        `desktop notifications need permission, and a browser only grants it ` +
          `from a user gesture — "${n.title}" was not shown. Call ` +
          `requestNotificationPermission() from a click handler once; the ` +
          `answer sticks.`,
      );
    },
    (e) =>
      _once("ask-failed", `asking for notification permission failed: ${e}`),
  );
}

/** Ask the user, from a click handler. Resolves to the browser's answer, or
 *  `"unsupported"` where there is no Notification API. Idempotent: once
 *  granted or denied the browser answers without asking again. */
export function requestNotificationPermission(): Promise<
  "default" | "granted" | "denied" | "unsupported"
> {
  const N = _api();
  if (!N) return Promise.resolve("unsupported");
  if (N.permission !== "default") return Promise.resolve(N.permission);
  return N.requestPermission();
}
