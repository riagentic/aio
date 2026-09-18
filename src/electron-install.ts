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
import {
  autoInstallElectron,
  electronDistDir,
  installedRuntimeVersion,
} from "./electron/electron-spawn.ts";
import { DEFAULT_ELECTRON_VERSION } from "./electron/electron-runtime-fetch.ts";
import { log } from "./diagnostics/logger-api.ts";

// `--check`: answer "is the runtime there?" and nothing else — exit 0 when
// `<pkg>/dist` exists, 1 when it does not, no download, no output. This is how
// `am fix` asks the question WITHOUT re-implementing the resolver: am may not
// import src/electron (boundary matrix), and a second copy of "where electron
// lives" is exactly the two-decider bug this file's history is about.
if (Deno.args.includes("--check")) {
  Deno.exit((await electronDistDir()) === null ? 1 : 0);
}

// `--version`: print the installed runtime's version (nothing when none) and
// exit 0. `am fix` / `am pin` ask here rather than re-reading node_modules
// themselves — one reader of "which Electron is installed".
if (Deno.args.includes("--version")) {
  const v = await installedRuntimeVersion();
  if (v) console.log(v);
  Deno.exit(0);
}

// `--install=<x.y.z>`: install exactly that version — the one the app's
// PINNED aio is tested with, which `am` reads from that aio's source. Without
// it: this aio's own tested version.
const asked = Deno.args.find((a) => a.startsWith("--install="))?.slice(10);
if (asked !== undefined && !/^\d+\.\d+\.\d+$/.test(asked)) {
  log.error(
    "electron",
    `--install wants an exact x.y.z version, got "${asked}"`,
  );
  Deno.exit(2);
}
const want = asked ?? DEFAULT_ELECTRON_VERSION;

const ok = await autoInstallElectron(
  {
    info: (m: string) => log.info("electron", m),
    error: (m: string) => log.error("electron", m),
  },
  undefined,
  // Present AND the version asked for: a stale runtime is not "installed".
  async () => (await installedRuntimeVersion()) === want,
  want,
);
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
