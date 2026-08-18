#!/usr/bin/env -S deno run -A
// `deno task install:electron` — get the Electron runtime, for real.
//
// The scaffolded task used to be `deno install --allow-scripts=npm:electron`,
// which is the command that DOES NOT RELIABLY WORK: `--allow-scripts` only
// PERMITS the lifecycle script, and whether it runs depends on what deno had
// cached and whether the package counts as newly added. When it is skipped the
// command exits 0 with a package that has no `dist/`, and every later step
// says "electron is not installed — run deno task install:electron" — advice
// that runs the same command and skips the same script.
//
// A field report walked that loop: "my scaffold DID define install:electron,
// and running it changed nothing — no output, no node_modules/electron/dist/,
// exit 0. The build then advised running it again." What worked was
// `cd node_modules/electron && node install.js`.
//
// The framework's own launcher has known that for a while and falls back to
// the package's installer. The task did not, so the two disagreed. Now the
// task IS the launcher's installer — one implementation, and the answer it
// reports is "is the runtime there?", never "did a command exit zero".
import { autoInstallElectron } from "./electron/electron-spawn.ts";
import { log } from "./diagnostics/logger-api.ts";

const ok = await autoInstallElectron({
  info: (m: string) => log.info("electron", m),
  error: (m: string) => log.error("electron", m),
});
if (!ok) {
  log.error(
    "electron",
    "the Electron runtime is still not present. Check the network and " +
      "retry; if a proxy blocks the download, set ELECTRON_MIRROR, or point " +
      "$ELECTRON_PATH at an Electron you already have.",
  );
  Deno.exit(1);
}
log.info("electron", "✓ runtime ready");
