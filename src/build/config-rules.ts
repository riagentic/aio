// config-rules.ts — the build-config rules a RUNNING app's modules read too.
//
// `build-config.ts` imports the whole builder: the fleet, every target's
// packager, the compile step. Two modules a compiled app does run — the update
// check (`ship.ts`) and the dev bundler (`build-integrity.ts`) — took a
// one-line rule each from it, and through those two imports every compiled app
// carried 23 builder modules (210 KB minified, and esbuild in its npm graph)
// that it can never run. The rules live here, importing nothing of the
// builder; `build-config.ts` re-exports them, so there is still one decider.
// tests/app-graph-no-builder.test.ts keeps the app's graph free of the builder.
import { dirname, resolve } from "@std/path";
import { resolveEntryPath } from "../server/paths.ts";
import type { BuildConfig } from "./build-config.ts";

/** The entry an app declares in `deno.json`, and the scaffold's default when
 *  it declares none. THE entry decider: every tool that needs to know which
 *  module IS the app — the build, `dev:android`'s server child, the app dir
 *  rule below — reads it from here. A hardcoded `"src/app.ts"` elsewhere is a
 *  second decider, and it breaks the moment an app puts its entry anywhere
 *  else (WYSIDIWYSIP).
 *
 *  `override` is a per-BUILD entry (`--entry=`, which `build-all` passes for a
 *  target that declares its own `entry`) — one repo can hold two apps, a relay
 *  and a client, and each target must compile its own module. It flows through
 *  the same decider so `appDir` and everything derived from it follow for free;
 *  a target-specific app-dir rule would be exactly the second decider this
 *  function exists to prevent. */
export function resolveEntry(
  mainConfig: Record<string, unknown>,
  override?: string,
): string {
  // Delegates: `am` needs the same answer and cannot import the build.
  return resolveEntryPath(mainConfig, override);
}

/** THE app-dir decider (WYSIDIWYSIP), as one named rule rather than an
 *  expression inlined at its single call site: the app dir is the ENTRY'S
 *  DIRECTORY — exactly what the runtime resolves as `baseDir`
 *  (`aio.ts _inferBaseDir`: the main module's directory). Dev serving and prod
 *  packaging must never resolve an app asset from two different places, so
 *  anything that needs the app dir without a full `loadBuildConfig()` (a test,
 *  a tool) calls THIS instead of re-deriving it. */
export function resolveAppDir(root: string, configEntry: string): string {
  return resolve(root, dirname(configEntry));
}

/** Does this build make the standalone bundle? `standalone` when set, else
 *  what it means — so a hand-built config that says only `doAndroid: true`
 *  still gets the APK's bundle, never a silent browser one. */
export function isStandalone(
  cfg: Pick<BuildConfig, "standalone" | "doAndroid" | "doWeb">,
): boolean {
  return cfg.standalone ?? (cfg.doAndroid || cfg.doWeb === true);
}
