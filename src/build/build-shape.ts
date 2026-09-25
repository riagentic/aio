/** Pure checks on a deno.json `build` block and on the build's `out`
 *  directory — kept out of `src/build-all.ts` so they stay internal (that file
 *  is a public entry). @internal */

/** What is wrong with the SHAPE of a deno.json `build` block — each problem
 *  one line naming the key. Pure; `[]` for a missing block.
 *
 *  The readers downstream assume the shapes they document and misread any
 *  other: `"targets": "browser"` said "no targets to build — add
 *  build.targets" to a file that had them, `"platforms": "linux"` was
 *  iterated per CHARACTER ("unknown platform(s): l, i, n, u, x"), `"out": 5`
 *  crashed with a @std/path stack trace, and `"entry": 1` crashed in
 *  `.trim()`. Those are refused. A shape that BUILT on 1.0.11 — only not as
 *  written — is not: see {@link buildBlockShapeWarnings}. */
export function buildBlockShapeProblems(
  block: unknown,
  opts: {
    /** `--targets=` was passed: `build.targets` decides nothing this run, so
     *  a scalar there (it built on 1.0.11 under the flag) is a warning, not a
     *  refusal. */
    targetsOverridden?: boolean;
  } = {},
): string[] {
  return shapeReport(block, opts).problems;
}

/** What in a deno.json `build` block builds, but not as written — each one a
 *  line to WARN with. These shapes built on 1.0.11, so refusing them would
 *  break a working build; saying nothing left them silently misread. Pure.
 *
 *   - `"targets": "server"` under `--targets=`: read by nothing (refused
 *     without the flag, where it built nothing).
 *   - a non-string in the targets array: dropped.
 *   - a per-target value that is not an object (`"server": false`, `"x"`):
 *     the target is BUILT, with no overrides. `null`/`true` mean exactly
 *     that and are not warned.
 *   - a per-target `"platforms": "linux"`: ignored — that target builds for
 *     `build.platforms`. */
export function buildBlockShapeWarnings(
  block: unknown,
  opts: { targetsOverridden?: boolean } = {},
): string[] {
  return shapeReport(block, opts).warnings;
}

function shapeReport(
  block: unknown,
  opts: { targetsOverridden?: boolean },
): { problems: string[]; warnings: string[] } {
  const problems: string[] = [];
  const warnings: string[] = [];
  if (block === undefined) return { problems, warnings };
  if (!block || typeof block !== "object" || Array.isArray(block)) {
    problems.push(`build must be an object, got ${JSON.stringify(block)}`);
    return { problems, warnings };
  }
  const b = block as Record<string, unknown>;
  const got = (v: unknown) => JSON.stringify(v);
  const stringList = (key: string, v: unknown, to: string[], why = "") => {
    if (v === undefined) return;
    if (!Array.isArray(v)) {
      to.push(`${key} must be an array of strings, got ${got(v)}${why}`);
    } else if (v.some((x) => typeof x !== "string")) {
      to.push(`${key} must hold only strings, got ${got(v)}${why}`);
    }
  };
  if (b.targets !== undefined) {
    const t = b.targets;
    if (Array.isArray(t)) {
      stringList("build.targets", t, warnings, " — the rest are not built");
    } else if (!t || typeof t !== "object") {
      const msg = `build.targets must be an array of target names or an ` +
        `object of per-target overrides, got ${got(t)}`;
      if (opts.targetsOverridden) {
        warnings.push(`${msg} — ignored: --targets= decides this run`);
      } else problems.push(msg);
    } else {
      for (const [label, o] of Object.entries(t)) {
        const at = `build.targets.${label}`;
        // `"server": null` is the array form's entry, and `true` reads the
        // same.
        if (o === null || o === true) continue;
        if (typeof o !== "object" || Array.isArray(o)) {
          warnings.push(
            `${at} must be an object of overrides, got ${got(o)} — the ` +
              `target is BUILT, with none (remove the key to skip it)`,
          );
          continue;
        }
        for (const k of ["kind", "entry", "ui", "name", "title"] as const) {
          const v = (o as Record<string, unknown>)[k];
          if (v !== undefined && typeof v !== "string") {
            problems.push(`${at}.${k} must be a string, got ${got(v)}`);
          }
        }
        // Not an array: ignored downstream (the target built for the
        // default platforms). An array is used as-is, so a non-string in it
        // reaches the platform resolver.
        const p = (o as { platforms?: unknown }).platforms;
        stringList(
          `${at}.platforms`,
          p,
          Array.isArray(p) ? problems : warnings,
          Array.isArray(p)
            ? ""
            : ` — ignored: this target builds for build.platforms`,
        );
      }
    }
  }
  stringList("build.platforms", b.platforms, problems);
  if (
    b.out !== undefined && (typeof b.out !== "string" || !b.out.trim())
  ) {
    problems.push(
      `build.out must be a directory name like "dist", got ${got(b.out)}`,
    );
  }
  return { problems, warnings };
}

/** The update manifest name `shipApp` writes beside an artifact and into a
 *  channel directory — `manifestFileName` (ship.ts): `<os>-<arch>.json`, for
 *  every OS/arch a Deno binary reports. Spelled out rather than `*-*.json`, so
 *  a user's `app-config.json` is never taken for one. */
const SHIP_PLATFORM_JSON =
  /^(?:linux|darwin|windows|freebsd|netbsd|aix|solaris|illumos|android)-(?:x86_64|aarch64)\.json$/;

/** Entries of an existing `out` directory this build did NOT put there — the
 *  ones assembling a clean release would delete. Pure.
 *
 *  `out` is emptied and refilled on every build, so it must be the build's own
 *  directory. `--out=tests` (or `"out": "docs"`, `"assets"`) passed every
 *  path guard and deleted `tests/cell.test.ts` without a word, under a green
 *  "1 built → tests/". What a previous build placed there is exactly what its
 *  manifest.json lists (every placed file is recorded), so anything else is
 *  someone's file. `previous` is that manifest's parsed JSON, or null.
 *
 *  …plus what aio's own publish wrote next to those artifacts: `am publish` /
 *  `aio ship` put `<artifact>.ship.json` and `<os>-<arch>.json` beside the
 *  binary, and `am publish --dir=<out>` a channel directory holding only
 *  `<os>-<arch>.json` and copies of the listed artifacts. `dirs` maps each
 *  DIRECTORY entry to its own entries (absent → the directory is foreign). */
export function foreignOutEntries(
  entries: readonly string[],
  previous: unknown,
  dirs: Readonly<Record<string, readonly string[]>> = {},
): string[] {
  const artifacts = new Set<string>();
  const targets = (previous as { targets?: unknown } | null)?.targets;
  const isManifest = Array.isArray(targets);
  if (isManifest) {
    for (const t of targets) {
      const arts = (t as { artifacts?: unknown } | null)?.artifacts;
      if (!Array.isArray(arts)) continue;
      for (const a of arts) {
        const f = (a as { file?: unknown } | null)?.file;
        if (typeof f === "string") artifacts.add(f);
      }
    }
  }
  const shipOutput = (e: string) =>
    SHIP_PLATFORM_JSON.test(e) ||
    (e.endsWith(".ship.json") && artifacts.has(e.slice(0, -10)));
  const ours = (e: string) => {
    if (!isManifest) return false;
    if (e === "manifest.json" || artifacts.has(e) || shipOutput(e)) return true;
    const inside = Object.hasOwn(dirs, e) ? dirs[e] : undefined;
    return inside !== undefined && inside.length > 0 &&
      inside.every((f) => artifacts.has(f) || SHIP_PLATFORM_JSON.test(f));
  };
  return entries.filter((e) => !ours(e)).sort();
}
