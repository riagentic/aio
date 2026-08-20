/**
 * @module
 * THE build flag vocabulary — for both entry points, in one place.
 *
 * Every build flag is read with `Deno.args.includes("--x")` / `.find(...)`, so
 * a flag the build does not recognize is not an error: it is simply ABSENT.
 * The build then does something else and exits 0. That is not hypothetical —
 * the scaffold's own default `compile` task passed `--client=cli` /
 * `--client=server-only` (the RUNTIME flags `aio.run()` reads) where the BUILD
 * spellings are `--cli` and `--service --headless`, so `deno task compile` on
 * a cli/server app quietly built the browser-shaped binary: a browser bundle
 * embedded, no systemd unit, no complaint, and a different artifact from
 * `deno task compile:cli` / `compile:service` for the same app.
 *
 * Kept pure and dependency-free so the whole vocabulary is a unit test rather
 * than a claim, and so the two entry points cannot drift into two answers.
 */

/** Every boolean flag the single-target build (`build.ts`) understands. */
export const BUILD_BOOL_FLAGS = [
  "--compile",
  "--electron",
  "--android",
  "--cli",
  "--client",
  "--remote",
  "--service",
  "--headless",
  "--force",
  "--release",
  // Builds nothing: prints the TMPDIR a launcher must hand this project's
  // packaged artifact (`AppDirs.app`) and exits. Part of the vocabulary because
  // an unknown flag here is silently ignored — a launcher asking with a typo
  // would get an empty answer and fall back to shared /tmp without a word.
  // Standalone Android has no Deno runtime, so a build whose graph reaches
  // server-only code is refused (it would ship a UI whose buttons do nothing).
  // This says "those paths are guarded and never taken on Android" — the
  // developer asserting what the build cannot see.
  "--allow-server-only",
  "--print-app-tmpdir",
] as const;

/** Every `--flag=value` the single-target build understands. */
export const BUILD_VALUE_FLAGS = [
  "--entry",
  "--name",
  "--platform",
  "--android-dev-url",
  // The UI component this build bundles (relative to the app dir), overriding
  // the `App.tsx` convention — the build-side half of dev's `ui.entry`. The
  // bundle records it (`__aioBundleUi`) and the server refuses to serve a
  // bundle whose UI entry differs from the running config (dev==prod).
  "--ui",
  // Where final artifacts (binary, APK, AppImage, .service) land, instead of
  // the project root. Orchestrating several single-target builds needs a
  // per-app destination — without this, callers staged artifacts in dist/,
  // which the next build wipes (dist/ is embedded into the binary wholesale).
  "--out",
] as const;

/** Every boolean flag the fleet build (`build-all.ts`) understands. */
export const FLEET_BOOL_FLAGS = [
  "--list",
  "--help",
  "--release",
  "--force",
  // "ship everything this repo can produce from here" — expands to every
  // platform in the table. What a target cannot cross-build is printed with
  // its reason, so "all" never quietly means "some".
  "--all-platforms",
] as const;

/** Every `--flag=value` the fleet build understands. */
export const FLEET_VALUE_FLAGS = [
  "--targets",
  "--platforms",
  "--out",
  "--build-spec",
] as const;

/** The `--flags` in `args` that are not in `bools`/`values`. A bare value flag
 *  (`--entry`) and a valued boolean (`--compile=true`) are both unknown: they
 *  would have been read as absent. */
function unknown(
  args: readonly string[],
  bools: readonly string[],
  values: readonly string[],
): string[] {
  const b = new Set<string>(bools);
  const v = new Set<string>(values);
  return args.filter((a) => a.startsWith("--")).filter((a) => {
    const eq = a.indexOf("=");
    return eq === -1 ? !b.has(a) : !v.has(a.slice(0, eq));
  });
}

/** The `--flags` the single-target build does NOT understand. */
export function unknownBuildFlags(args: readonly string[]): string[] {
  return unknown(args, BUILD_BOOL_FLAGS, BUILD_VALUE_FLAGS);
}

/** The `--flags` the fleet build does NOT understand. `--target=`/`--platform=`
 *  (singular) are the near-misses that mattered: ignored, the fleet fanned out
 *  over deno.json's whole list instead of the one target asked for. */
export function unknownFleetFlags(args: readonly string[]): string[] {
  return unknown(args, FLEET_BOOL_FLAGS, FLEET_VALUE_FLAGS);
}

/** Human list of a vocabulary, for the refusal message. */
export function flagVocabulary(
  bools: readonly string[],
  values: readonly string[],
): string {
  return `${bools.join(" ")} ${values.map((f) => `${f}=…`).join(" ")}`;
}

/** What to say about an unknown flag. `--client=<mode>` earns a named fix: it
 *  is a REAL flag of the compiled app, not a typo, so "unknown flag" alone
 *  would read like the build being pedantic. */
export function flagHint(flag: string): string {
  if (!flag.startsWith("--client=")) return "";
  const mode = flag.slice("--client=".length);
  const build: Record<string, string> = {
    browser: "--compile",
    electron: "--compile --electron",
    cli: "--compile --cli",
    "server-only": "--compile --service --headless",
  };
  return `\n         → \`--client=${mode}\` is the RUNTIME flag the compiled ` +
    `app reads (aio.run picks the client from it). The BUILD spelling of ` +
    `that target is \`${build[mode] ?? "--compile"}\`.`;
}
