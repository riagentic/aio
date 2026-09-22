/**
 * @module
 * dev-hooks — the seam the DEV-ONLY chunk fills, and the ONE place it loads.
 *
 * THE MEASUREMENT. Every production page downloaded 32,878 bytes raw / 12.0 KB
 * gzipped of code that a production page can never run:
 *
 *   · `contrast-audit.ts`, `selector-audit.ts`  — called only inside
 *     `if (isDevMode())` in renderer-flush;
 *   · `dev-overlay.ts`, `dev-readonly-hint.ts`  — both return immediately
 *     unless `isDevMode()`;
 *   · `ui-remote.ts` → `ui-surface.ts` + `ui-trigger.ts` — the `am surface` /
 *     `am trigger` engine, driven ONLY by the `ui-surface`/`ui-trigger` frames
 *     that `server-trojan.ts` sends, and the trojan is never mounted in prod
 *     (`server-static.ts`: "Trojan: control REST API — DEV-ONLY").
 *
 * WHY THEY WERE THERE. `isDevMode()` is a runtime read of `globalThis.
 * __aioDev`, so no bundler can prove the branch dead. And the flag is set in
 * exactly one place — `aioDevHTML` — which serves the dev import map and
 * live-transpiled source, NOT `dist/app.js`. So the bundle carried a dev layer
 * that the bundle's own contexts (prod page, Electron package, standalone APK)
 * cannot switch on.
 *
 * THE SHAPE. The dev layer moved into one module, `browser/dev-diagnostics.ts`,
 * reached through a DYNAMIC import that the browser bundler marks external
 * (`esbuild-plugin.ts`). The specifier it is externalized to,
 * `/__aio/browser/dev-diagnostics.ts`, is the dev server's own live-transpile
 * route — so the path is real wherever dev is real, and 404s in prod, where
 * the framework-source routes are closed. Nothing is fetched on a production
 * page, because there are only two callers and neither can fire on one:
 * `isDevMode()` at transport boot and in the render path, and a
 * `ui-surface`/`ui-trigger` frame, which only the trojan sends.
 *
 * DEV == PROD. Every module behind this seam is category (a) of the rule —
 * observe-only, or a control channel whose only caller prod never mounts. Prod
 * says LESS and does nothing differently. The two that could NOT move are
 * recorded where they live: `console-intercept.ts` forwards the page's console
 * to the server log in production too, and `component-profile.ts` keeps counts
 * a live `am eval '__aioProfile()'` reads off a production app.
 *
 * FAIL LOUD. A dev session whose diagnostics quietly did not arrive is worse
 * than one without them — you would believe a check ran. A failed load says so
 * once, names every check that is therefore NOT running, and says where the
 * module is supposed to come from.
 */

import type { UISurfaceNode } from "./ui-surface.ts";
import type { UITriggerRequest, UITriggerResult } from "./ui-remote.ts";
import type { SurfaceMeasurement } from "./ui-surface.ts";

/** The `am surface` / `am trigger` executor, as `browser-air-commands.ts`
 *  uses it. Type-only imports above: erased by the bundler, so naming these
 *  shapes costs the page nothing. */
export type UiRemoteApi = {
  getSerializedSurfaces(full?: boolean): UISurfaceNode[];
  getMeasuredSurfaces(
    full?: boolean,
  ): { roots: UISurfaceNode[]; measured: SurfaceMeasurement };
  runUITrigger(req: UITriggerRequest): Promise<UITriggerResult>;
};

/** What the dev chunk installs. Every slot is `null` until it loads, and a
 *  production page leaves them null forever — which is the point.
 *
 *  A mutable record rather than exported `let`s: a reader gets the CURRENT
 *  value through one object identity, so a call site is `devHooks.x?.(…)` with
 *  no live-binding subtlety and no re-export chain to keep in step. */
export type DevHooks = {
  /** Contrast audit over the committed tree (`contrast-audit.ts`). */
  auditContrast: ((root: Element | null | undefined) => number) | null;
  /** `#id` selectors in the app's CSS that match nothing
   *  (`selector-audit.ts`). */
  auditIdSelectors:
    | ((doc: Document | null | undefined, rootId: string) => number)
    | null;
  /** The live-client UI surface/trigger executor (`ui-remote.ts`). */
  uiRemote: UiRemoteApi | null;
};

export const devHooks: DevHooks = {
  auditContrast: null,
  auditIdSelectors: null,
  uiRemote: null,
};

/** Called by the dev chunk as it loads. Partial: a chunk that grows a hook
 *  does not have to restate the others. */
export function _registerDevHooks(h: Partial<DevHooks>): void {
  Object.assign(devHooks, h);
}

// ── loading it ─────────────────────────────────────────────────────────
//
// The import lives in `browser/`, and `air` may not import `browser` (the
// folder matrix). So the LOADER is registered from the browser runtime — one
// arrow function, registered at module load — and this module owns the
// once-only latch and the failure message, which is where every caller can
// reach them.

let _loader: (() => Promise<unknown>) | null = null;
let _pending: Promise<void> | null = null;
let _said = false;

/** Register the dynamic import. `browser/browser-air-commands.ts` does this at
 *  module load — the ONE `import("./dev-diagnostics.ts")` in the tree — and it
 *  is the module every browser path already reaches: the transport imports it
 *  for `routeCommand`, and so does anything driving the command router on its
 *  own. Nothing else should call this. */
export function _setDevChunkLoader(fn: () => Promise<unknown>): void {
  _loader = fn;
}

/** Load the dev-only chunk, once. Resolves when its hooks are installed, or
 *  when it has failed LOUDLY — never rejects, because every caller is a dev
 *  observation and none of them may break the page.
 *
 *  Idempotent: the second caller awaits the first one's import. */
export function loadDevChunk(): Promise<void> {
  if (_pending) return _pending;
  const load = _loader;
  if (!load) {
    // No loader registered at all: this page is not running the browser
    // runtime (SSR, a unit test importing the renderer alone). Nothing to say
    // — there is no dev session to mislead.
    return _pending = Promise.resolve();
  }
  return _pending = (async () => {
    try {
      await load();
      return;
    } catch (e) {
      if (_said) return;
      _said = true;
      // ONE line, and it names what is therefore not running. The failure
      // mode this exists for is a developer who believes an audit ran.
      console.error(
        "[aio] the dev-only chunk did not load — the colour-contrast audit, " +
          "the #id-selector audit, the dev error overlay, the read-only-state " +
          "hint and the `am surface` / `am trigger` engine are NOT running on " +
          "this page. A production bundle does not carry them; `aio dev` " +
          "serves them at /__aio/browser/dev-diagnostics.ts. Cause: " +
          String(e),
      );
    }
  })();
}
