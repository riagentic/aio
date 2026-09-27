/**
 * @module
 * The Android Back button, for a page that navigates by state.
 *
 * An aio app's screens are usually cell state, not URLs — and a standalone
 * APK's page is `/assets/index.html`, where there is no router to speak of.
 * So Back exited the app from any screen, and `history.pushState` does not
 * help: a WebView ignores entries pushed before the first user gesture, so
 * after a cold start the first Back exited anyway. A field report forked the
 * template's `MainActivity.kt` to get this; the fork had to be re-diffed on
 * every upgrade.
 *
 * The Android shell's Back asks the page first — `window.__aioBack()` through
 * `evaluateJavascript`, which needs no gesture — and does its own default
 * (WebView history, then leave the app) only when no handler took it.
 * Anywhere else nothing ever calls it, so registering is inert on desktop and
 * in a browser.
 */

/** The global the Android shell calls on Back. Named here and in the
 *  template's `MainActivity.kt` — the only two places it appears. */
const BACK_GLOBAL = "__aioBack";

const stack: { h: () => boolean }[] = [];

function back(): boolean {
  for (let i = stack.length - 1; i >= 0; i--) {
    try {
      if (stack[i]!.h() === true) return true;
    } catch (e) {
      // Loud, and HANDLED: a broken handler must not also close the app.
      console.error("[aio] an onBackButton handler threw:", e);
      return true;
    }
  }
  return false;
}

/**
 * Handle the Android Back button. `handler` returns `true` when it handled
 * Back (went up a screen, closed a dialog) — the app then stays; `false` lets
 * the next handler try, and when none takes it Android does its default
 * (WebView history, then leave the app). The LAST registered runs first, so a
 * dialog opened over a screen gets Back before the screen does. Returns the
 * disposer. Works from a cold start, before any tap. A no-op on desktop and
 * in a browser — nothing there calls it.
 *
 * ```tsx
 * onMount(() =>
 *   onBackButton(() => {
 *     if (nav.screen === "home") return false; // leave the app
 *     nav.up();
 *     return true;
 *   })
 * ); // onMount runs the returned disposer at unmount
 * ```
 *  @tier Kit */
export function onBackButton(handler: () => boolean): () => void {
  (globalThis as Record<string, unknown>)[BACK_GLOBAL] ??= back;
  const entry = { h: handler };
  stack.push(entry);
  return () => {
    const i = stack.indexOf(entry);
    if (i >= 0) stack.splice(i, 1);
  };
}
