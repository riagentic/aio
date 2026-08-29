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
  "--ios",
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
  // Same shape, the other directory: WHERE a built artifact gets installed.
  // `run.sh` asks rather than hardcoding `~/app`, so the installer, `am
  // remove` and the updater cannot drift into three opinions about where an
  // app lives. It was read by build.ts and missing from this table — harmless
  // only because build.ts answers it before `loadBuildConfig` validates. The
  // vocabulary is supposed to be the whole vocabulary; the source gate in
  // tests/build-flags.test.ts now checks that it is.
  "--print-install-root",
] as const;

/** Every `--flag=value` the single-target build understands. */
export const BUILD_VALUE_FLAGS = [
  "--entry",
  // Builds nothing: prints what an artifact FILE is installed as — base name,
  // extension, and the version its name carries — and exits. The one place
  // that rule lives; `run.sh` / `run.ps1` ask instead of parsing names in
  // shell (an installer and `am remove` disagreeing about an app's file name
  // is the same app with two data directories).
  "--print-install-name",
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
  // Forwarded verbatim to the single-target build (only `--android` consults
  // it). It belongs here because the fleet IS the build path since alpha52:
  // `deno task build` and `deno task compile` both run through build-all, so a
  // flag the fleet does not know is a flag no scaffolded app can pass. The
  // Android refusal names `--allow-server-only` as its way out, and that way
  // out was reachable only by invoking the framework's build.ts by hand.
  "--allow-server-only",
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

/** Every boolean flag `aio ship` (and its `keygen` / `github` subcommands)
 *  understands. */
export const SHIP_BOOL_FLAGS = [
  "--github",
  "--no-data",
  "--stdout",
  "--force",
  "--allow-dirty",
] as const;

/** Every `--flag=value` `aio ship` understands. */
export const SHIP_VALUE_FLAGS = [
  "--src",
  "--name",
  "--version",
  "--key",
  "--channel",
  "--target",
  "--url",
  "--notes",
  "--min-from",
  "--data",
  "--out",
  "--channel-dir",
] as const;

/** The `--flags` `aio ship` does NOT understand.
 *
 *  Same rule as the two build entry points, and the stakes are higher here
 *  than anywhere else in the toolchain: `ship` reads every flag with
 *  `args.find(a => a.startsWith("--k="))`, so a misspelled one is ABSENT and
 *  the default takes over silently. `--keys=release-key.json` publishes an
 *  UNSIGNED manifest; `--no-dta` runs the data probe instead of skipping it;
 *  `--min-form=` drops the floor a client checks before installing. All three
 *  produce a well-formed release whose defect only shows up on other people's
 *  machines, days later — exactly the shape build-flags.ts exists to make
 *  impossible. */
export function unknownShipFlags(args: readonly string[]): string[] {
  return unknown(args, SHIP_BOOL_FLAGS, SHIP_VALUE_FLAGS);
}

/** The `--print-*` flags: each answers ONE question, builds nothing, and exits.
 *  Their stdout is an answer a script parses (`run.sh` reads it), so a build
 *  asked a question prints nothing else there.
 *
 *  DERIVED from the vocabulary rather than spelled out a second time: a
 *  hand-written `startsWith("--print-")` probe elsewhere is a flag literal no
 *  table knows, which is exactly what the source-vs-table gate refuses. */
export const PRINT_FLAGS: readonly string[] = [
  ...BUILD_BOOL_FLAGS,
  ...BUILD_VALUE_FLAGS,
].filter((f) => f.startsWith("--print-"));

/** Was this build asked a question instead of told to build? */
export function isBuildQuestion(args: readonly string[]): boolean {
  return args.some((a) =>
    PRINT_FLAGS.some((f) => a === f || a.startsWith(`${f}=`))
  );
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

/** The value of `--name=` in `args`, LAST OCCURRENCE WINS, with the repeat
 *  reported through `onRepeat`.
 *
 *  THE ONE RULE FOR ARGV IN AIO, and it used to be two: `parseCli` (the
 *  runtime's reader) assigns on every match, so the last flag wins there —
 *  while the fleet builder took the FIRST. The difference was reachable from
 *  a command line the scaffolder itself writes: `deno task compile` bakes
 *  `--targets=<default>`, so `deno task compile --targets=cli` built the
 *  default target and named its artifact accordingly, with nothing said.
 *
 *  Last-wins is also the reading that matches intent — the task line is the
 *  app author's default, the command line is the operator's override, and
 *  they arrive in that order on one line.
 *
 *  Pure: `onRepeat` is the caller's, so the same rule is testable without a
 *  console. */
export function lastFlag(
  args: readonly string[],
  name: string,
  onRepeat?: (values: string[]) => void,
): string | undefined {
  const values: string[] = [];
  for (const a of args) {
    if (a.startsWith(`--${name}=`)) values.push(a.slice(name.length + 3));
  }
  if (values.length > 1) onRepeat?.(values);
  return values.at(-1);
}
