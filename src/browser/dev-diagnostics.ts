/**
 * @module
 * dev-diagnostics — THE dev-only chunk. Everything a page carries for the
 * developer and nothing a user's page can run.
 *
 * It is reached from exactly one place (`dev-hooks.ts`'s `loadDevChunk()`,
 * called only when dev mode is on), through a dynamic import the browser
 * bundler marks external — so `dist/app.js` does not contain a byte of it and
 * a production page never fetches it. Measured: 32,878 bytes raw / 12.0 KB
 * gzipped off every page load. The reasoning, and the dev==prod argument for
 * each module, is in `air/dev-hooks.ts`.
 *
 * Two rules for anything added here:
 *
 *  1. It must be OBSERVE-ONLY, or a control channel production does not mount.
 *     A module whose absence changes what the app DOES makes production more
 *     permissive than dev, which is the one direction this project never
 *     allows. If in doubt it stays in the bundle.
 *  2. Its installation happens HERE, at module load — a side effect, not an
 *     export somebody has to remember to call. The chunk loading IS the
 *     installation, so there is one thing to get right rather than two.
 */

import { auditContrast } from "../air/contrast-audit.ts";
import { auditIdSelectors } from "../air/selector-audit.ts";
import {
  getMeasuredSurfaces,
  getSerializedSurfaces,
  runUITrigger,
} from "../air/ui-remote.ts";
import { _registerDevHooks } from "../air/dev-hooks.ts";
import { installDevOverlay } from "./dev-overlay.ts";
import { _installReadOnlyHint } from "../air/dev-readonly-hint.ts";

// The two audits and the surface/trigger executor are CALLED from the render
// path and the command router, so they go in as hooks.
_registerDevHooks({
  auditContrast,
  auditIdSelectors,
  uiRemote: { getSerializedSurfaces, getMeasuredSurfaces, runUITrigger },
});

// …and the two installers are side effects with nothing to call back into.
// Both are idempotent and both re-check `isDevMode()` themselves, so loading
// this module twice, or loading it with dev mode off, is a no-op.
installDevOverlay();
_installReadOnlyHint();
