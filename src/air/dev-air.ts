/**
 * @module
 * dev-air — the renderer's own dev layer: every check AIR runs for the
 * DEVELOPER, as the hooks `dev-hooks.ts` hands the render path.
 *
 * WHY IT IS A MODULE OF ITS OWN. These checks all sit behind `isDevMode()`,
 * a runtime read of `globalThis.__aioDev` that no bundler can prove false, so
 * a production page downloaded every one of them: the a11y lint and its role
 * tables, the controlled-input drift check, the list of known event names,
 * the key checks, the child-alignment walk, the render-burst tripwire and its
 * prose. None can run there — only the dev shell sets the flag, and it serves
 * source, never the bundle.
 *
 * HOW IT LEAVES THE BUNDLE. `dev-hooks.ts` imports this file statically, and
 * the browser bundler (`build/esbuild-plugin.ts`) answers that import with an
 * empty record. So:
 *
 *   · every runtime that runs SOURCE — a dev page, a test, a server render —
 *     has the hooks installed before the first line of the renderer runs.
 *     Synchronously, by construction: there is no harness to remember to load
 *     them and no first frames that go unchecked. A test that mounts AIR
 *     directly is as strict as `testUI` (tests/air-dev-layer-installed.test.ts);
 *   · a production bundle carries none of it, and every call site is
 *     `devHooks.x?.(…)` on a slot that stays null.
 *
 * Unlike `browser/dev-diagnostics.ts` (the chunk a page fetches) nothing here
 * needs the browser runtime, which is why it can be static.
 *
 * ONE RULE for a module listed here: no top-level use of an import from the
 * renderer. This file is evaluated while the module that first asked for
 * `dev-hooks.ts` is still loading, so a top-level `new Set([...imported])`
 * reads a binding that does not exist yet. Build such values on first use.
 */
import { _devA11yCheck, _rearmA11y } from "./dev-a11y.ts";
import { _afterHandler, _cancelDriftChecks } from "./control-drift.ts";
import { _resetEventWarnings, _warnUnknownEvent } from "./dev-events.ts";
import { _checkKeys } from "./dev-keys.ts";
import { _assertRegionAlignment } from "./dev-align.ts";
import { _depFired, _renderAsked, _renderBurst } from "./dev-burst.ts";
import { _resetTTPanel, _showTT } from "./time-travel-dom.ts";

/** The slots this layer fills. `dev-hooks.ts` spreads it into `devHooks`. */
export const airDevHooks = {
  a11y: _devA11yCheck,
  rearm: () => {
    _rearmA11y();
    _resetEventWarnings();
  },
  afterHandler: _afterHandler,
  cancelDriftChecks: _cancelDriftChecks,
  unknownEvent: _warnUnknownEvent,
  checkKeys: _checkKeys,
  assertAligned: _assertRegionAlignment,
  renderAsked: _renderAsked,
  depFired: _depFired,
  renderBurst: _renderBurst,
  showTT: _showTT,
  resetTTPanel: _resetTTPanel,
};
