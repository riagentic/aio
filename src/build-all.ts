/**
 * @module
 * Multi-target build orchestrator — one command builds a whole fleet.
 *
 * A single `deno task build` reads the target list from `deno.json`
 * (`"build": { "targets": [...] }`, or `--targets=a,b,c`), builds each target
 * by invoking the single-target pipeline ({@link build} in `build.ts`) as a
 * subprocess, and collects every artifact into a predictable `dist/` with a
 * `manifest.json`. This is THE build path (alpha52 one vocabulary): the
 * scaffolded `compile` task is this same pipeline narrowed to the default
 * target (`--targets=<client>`).
 *
 * ```sh
 * deno run -A jsr:@riagentic/aio/build-all               # build.targets
 * deno run -A jsr:@riagentic/aio/build-all --targets=server,electron-client
 * deno run -A jsr:@riagentic/aio/build-all --list        # show target names
 * ```
 */
import {
  basename,
  extname,
  fromFileUrl,
  join,
  resolve,
  SEPARATOR,
} from "@std/path";
import { slugify } from "./build/build-helpers.ts";
import {
  flagVocabulary,
  FLEET_BOOL_FLAGS,
  FLEET_VALUE_FLAGS,
  unknownFleetFlags,
} from "./build/build-flags.ts";
import { resolveAppDir, resolveEntry } from "./build/build-config.ts";
import { ansi } from "./diagnostics/color.ts";
import {
  crossCompileBlocker,
  hostPlatform,
  isHostPlatform,
  PLATFORMS,
  resolvePlatforms,
} from "./build/platforms.ts";

/** A build target → the single-target `build.ts` flags that produce it, its
 *  network role, and a one-line description. Client targets connect to a
 *  separately-built (or already-running) aio server. */
interface TargetSpec {
  flags: string[];
  role: "server" | "client" | "app";
  desc: string;
}
/** Every buildable target of the fleet, keyed by the name you pass to
 *  `deno task build` — its build flags, role, and one-line description. */
export const TARGETS: Record<string, TargetSpec> = {
  server: {
    flags: ["--compile", "--service", "--headless", "--remote"],
    role: "server",
    desc: "headless LAN/remote server binary + systemd unit (--expose)",
  },
  browser: {
    flags: ["--compile"],
    role: "app",
    desc: "self-contained binary serving the browser app",
  },
  electron: {
    flags: ["--compile", "--electron"],
    role: "app",
    desc: "Electron desktop app (AppImage / zip)",
  },
  android: {
    flags: ["--android"],
    role: "app",
    desc: "Android APK (bundled assets)",
  },
  cli: {
    flags: ["--compile", "--cli"],
    role: "app",
    desc: "headless CLI binary",
  },
  "electron-client": {
    flags: ["--client"],
    role: "client",
    desc: "standalone Electron connect-page client (AppImage)",
  },
  "android-client": {
    flags: ["--android", "--remote"],
    role: "client",
    desc: "Android client that connects to a server",
  },
  "cli-client": {
    flags: ["--compile", "--cli", "--remote"],
    role: "client",
    desc: "CLI client binary that connects to a server",
  },
};

/** What a target may override when `build.targets` is written in object form.
 *  Everything is optional — an empty object is the array form's behaviour. */
export interface TargetOverride {
  /** The module THIS target compiles, overriding deno.json `entry`. One repo,
   *  two apps: a relay server and the client that talks to it. */
  entry?: string;
  /** This target's binary/APK name, overriding deno.json `title`. Two
   *  different apps must not both be called `myapp` and be papered over by the
   *  collision suffix — they are not two builds of one app. */
  name?: string;
  /** OS/arch list for this target only, overriding `build.platforms`. */
  platforms?: string[];
}

interface BuildBlock {
  /** Either the plain list — `["server", "electron"]`, what `am create`
   *  writes and what every existing project has — or the object form, which
   *  adds per-target overrides:
   *
   *  ```jsonc
   *  "targets": {
   *    "server":   { "entry": "src/relay/app.ts", "name": "relay" },
   *    "electron": { "entry": "src/app.ts" }
   *  }
   *  ```
   *  Both normalize to the same internal shape ({@link normalizeTargets}). */
  targets?: string[] | Record<string, TargetOverride>;
  /** OS/arch to build each target for (default: just this machine). */
  platforms?: string[];
  out?: string;
  server?: string; // LAN/remote server address (recorded in the manifest)
}

/** One build to run, after both `targets` spellings have collapsed into a
 *  single shape. THE place target config is read — every consumer downstream
 *  (argv, artifact detection, the out-dir guard, the manifest) sees only this. */
export interface ResolvedTarget {
  /** Key into {@link TARGETS}. */
  name: string;
  /** Per-target entry module, or undefined to use deno.json `entry`. */
  entry?: string;
  /** Per-target app name (pre-slugify), or undefined to use deno.json `title`. */
  appName?: string;
  /** Per-target platform list, or undefined to use `build.platforms`. */
  platforms?: string[];
}

/** Collapse `build.targets` (array OR object form) plus an optional
 *  `--targets=a,b` override into the one internal shape.
 *
 *  `--targets=` selects WHICH targets run; it does not discard their declared
 *  overrides, so `--targets=server` on an object-form config still builds the
 *  server's own entry. Pure — no fs, no argv — so the compat contract (an
 *  array behaves exactly as before) is a unit test, not a claim. */
export function normalizeTargets(
  raw: string[] | Record<string, TargetOverride> | undefined,
  argTargets?: string,
): ResolvedTarget[] {
  const overrides = new Map<string, TargetOverride>();
  const declared: string[] = [];
  if (Array.isArray(raw)) {
    for (const t of raw) if (typeof t === "string") declared.push(t.trim());
  } else if (raw && typeof raw === "object") {
    for (const [name, o] of Object.entries(raw)) {
      declared.push(name.trim());
      overrides.set(name.trim(), (o ?? {}) as TargetOverride);
    }
  }
  const names =
    (argTargets !== undefined
      ? argTargets.split(",").map((t) => t.trim())
      : declared).filter(Boolean);
  return names.map((name) => {
    const o = overrides.get(name);
    return {
      name,
      ...(o?.entry ? { entry: o.entry.trim() } : {}),
      ...(o?.name ? { appName: o.name.trim() } : {}),
      ...(Array.isArray(o?.platforms) ? { platforms: o.platforms } : {}),
    };
  });
}

interface ArtifactRec {
  file: string;
  bytes: number;
}
interface TargetResult {
  target: string;
  role: string;
  platform: string;
  /** The binary name this target built under (per-target `name`, else the
   *  project title) and the module it compiled — recorded in the manifest so a
   *  two-app repo's dist/ says which artifact is which app. */
  binary: string;
  entry?: string;
  ok: boolean;
  /** Set when the combination was deliberately not built (e.g. Electron for a
   *  foreign OS) — a SKIP is reported, never silently omitted. */
  skipped?: string;
  error?: string;
  artifacts: ArtifactRec[];
}

// `ansi()` is the one place that decides NO_COLOR / not-a-terminal — a build
// log piped into a file or a CI transcript should not carry escapes.
const C = {
  b: ansi("\x1b[1m"),
  dim: ansi("\x1b[2m"),
  red: ansi("\x1b[31m"),
  green: ansi("\x1b[32m"),
  blue: ansi("\x1b[36m"),
  yellow: ansi("\x1b[33m"),
  r: ansi("\x1b[0m"),
};

const flag = (name: string): string | undefined =>
  Deno.args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

/** Human byte size. */
function human(n: number): string {
  if (n < 1024) return `${n} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${kb.toFixed(0)} KB`;
  const mb = kb / 1024;
  return mb < 1024 ? `${mb.toFixed(1)} MB` : `${(mb / 1024).toFixed(2)} GB`;
}

const ARTIFACT_EXTS = new Set([
  ".AppImage",
  ".apk",
  ".zip",
  ".service",
  ".exe",
]);

/** Is `name` a build artifact for `binaryName`? Per-target builds emit
 *  arch-suffixed names we can't fully predict, so we recognize by prefix+ext
 *  (the bare binary has no extension; the aio-client AppImage has its own). */
export function isArtifactName(name: string, binaryName: string): boolean {
  const ext = extname(name);
  if (ARTIFACT_EXTS.has(ext)) {
    return name.startsWith(binaryName) || name.startsWith("aio-client-");
  }
  if (ext === "") {
    if (
      name === binaryName || name === `${binaryName}-client` ||
      name.startsWith("aio-client-")
    ) return true;
    // Cross-compiled artifacts carry their platform and, on every OS but
    // Windows, no extension at all — `myapp-macos-arm64`. Without this they
    // matched nothing, so a perfectly good Mach-O binary was built, reported
    // as "no artifact", and left behind in the project root while the build
    // still declared success. Recognised by the platform table, so a new
    // platform cannot be forgotten here.
    for (const p of Object.keys(PLATFORMS)) {
      if (
        name === `${binaryName}-${p}` || name === `${binaryName}-client-${p}`
      ) {
        return true;
      }
    }
  }
  return false;
}

/** Pick the flat-layout name for `file`, disambiguating a cross-target
 *  collision (e.g. browser + server both emit the bare binary) by appending the
 *  target before the extension. Does not mutate `used`. */
export function placedName(
  file: string,
  used: Set<string>,
  target: string,
): string {
  if (!used.has(file)) return file;
  const ext = extname(file);
  return `${file.slice(0, file.length - ext.length)}-${target}${ext}`;
}

/** Strip a trailing separator so `/proj/apps/` and `/proj/apps` compare equal.
 *  (`/` itself keeps its single separator.) */
function trimSep(p: string): string {
  return p.length > 1 && p.endsWith(SEPARATOR) ? p.slice(0, -1) : p;
}

/** True when `a` IS `b` or lives inside it, compared by PATH SEGMENTS.
 *  Never `a.startsWith(b)`: that makes `/proj/appsX` "inside" `/proj/apps`, so
 *  a sibling with a near-miss name would be refused (or, in the other
 *  direction, a real containment missed). */
function within(a: string, b: string): boolean {
  const x = trimSep(a), y = trimSep(b);
  return x === y || x.startsWith(y.endsWith(SEPARATOR) ? y : y + SEPARATOR);
}

/** True if `outDir` is unsafe to wipe+recreate: the `out` dir is assembled by
 *  removing it RECURSIVELY, so it must be a dedicated subdir of the project
 *  that CONTAINS no protected directory and lives INSIDE none — never the root,
 *  an ancestor (`out: ".."`), `.aio` (our staging parent), `.git`, or a source
 *  dir. `out: ""` / `"."` resolve to the root and are caught here.
 *
 *  Containment, in BOTH directions, is the whole guard. Exact-set membership
 *  (what this used to test) let `out: "apps"` past while the app lived in
 *  `apps/web/` — the build then deleted the user's source tree, printed
 *  `✓ 1/1 build(s)` and exited 0. The descendant direction is just as fatal:
 *  `out: "src/ui"` under an app dir of `src/` wipes half the app.
 *
 *  `appDirs` are THE app-dir decider's answers (`BuildConfig.appDir`), one per
 *  target. `src/` is hardcoded only because it is the scaffold's convention; an
 *  app whose entry lives at `apps/web/main.ts` keeps its sources somewhere this
 *  list cannot guess.
 *
 *  It is a LIST, not one dir, because per-target entries mean one repo can hold
 *  two apps: guarding only the first target's dir would leave the second app's
 *  sources deletable — the exact hole the guard exists to close. Pass every
 *  target's dir; duplicates are fine. An app dir that IS the root (a flat
 *  layout, entry `app.ts`) is dropped: the root is already refused above, and
 *  keeping it would make every possible out dir "inside a protected dir" and
 *  leave a flat-layout app with nowhere to build. */
export function unsafeOutDir(
  outDir: string,
  root: string,
  appDirs: readonly string[] = [],
): boolean {
  const out = trimSep(outDir);
  const rootDir = trimSep(root);
  // Must be a STRICT subdirectory of the project (this also catches the root
  // itself, `/`, and anything outside the project).
  if (out === rootDir || !within(out, rootDir)) return true;
  const protectedDirs = [
    join(rootDir, ".aio"),
    join(rootDir, "src"),
    join(rootDir, ".git"),
    ...appDirs,
  ].map(trimSep).filter((d) => d !== rootDir);
  // Both directions: `out` may not sit inside a protected dir, and may not
  // swallow one.
  return protectedDirs.some((d) => within(out, d) || within(d, out));
}

/** Move a file, falling back to copy+delete across filesystem boundaries — a
 *  dist/ or .aio on a tmpfs/overlay mount makes a bare rename throw EXDEV. */
async function moveFile(from: string, to: string): Promise<void> {
  try {
    await Deno.rename(from, to);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) throw e;
    // EXDEV (cross-device) or any rename failure → copy then remove.
    await Deno.copyFile(from, to);
    await Deno.remove(from);
  }
}

function printTargets(): void {
  console.log(`${C.b}Available build targets:${C.r}`);
  for (const [name, spec] of Object.entries(TARGETS)) {
    console.log(
      `  ${C.blue}${name.padEnd(16)}${C.r}${C.dim}${
        spec.role.padEnd(8)
      }${C.r}${spec.desc}`,
    );
  }
  console.log(
    `\n${C.b}Available platforms:${C.r} ${C.dim}(default: host)${C.r}`,
  );
  for (const [name, spec] of Object.entries(PLATFORMS)) {
    const here = isHostPlatform(name) ? ` ${C.green}(this machine)${C.r}` : "";
    console.log(
      `  ${C.blue}${name.padEnd(16)}${C.r}${C.dim}${
        spec.triple.padEnd(28)
      }${C.r}${spec.desc}${here}`,
    );
  }
  console.log(
    `\n${C.dim}Declare them in deno.json → "build": { "targets": [...], "platforms": [...] },${C.r}`,
  );
  console.log(
    `${C.dim}or pass --targets=a,b --platforms=linux,windows,macos-arm64.${C.r}`,
  );
  console.log(
    `${C.dim}--all-platforms builds every one of them; what a target cannot${C.r}\n` +
      `${C.dim}cross-build is printed with the reason, never dropped.${C.r}`,
  );
  console.log(
    `${C.dim}Two apps in one repo? Give each target its own module:${C.r}\n` +
      `${C.dim}  "targets": { "server": { "entry": "src/relay/app.ts", "name": "relay" }, "electron": {} }${C.r}`,
  );
  console.log(
    `${C.dim}Electron cross-builds to Windows/macOS (its runtime is a download); a Linux
AppImage needs a Linux host, and an APK is built once, on any host.${C.r}`,
  );
}

/** Run the multi-target build. Returns the process exit code (0 = all ok). */
export async function buildAll(): Promise<number> {
  if (Deno.args.includes("--list") || Deno.args.includes("--help")) {
    printTargets();
    return 0;
  }
  const unknownFlags = unknownFleetFlags(Deno.args);
  if (unknownFlags.length > 0) {
    console.error(
      `${C.red}✗ unknown flag(s): ${unknownFlags.join(", ")}${C.r}\n` +
        `  ${C.dim}known: ${
          flagVocabulary(FLEET_BOOL_FLAGS, FLEET_VALUE_FLAGS)
        }${C.r}\n` +
        `  ${C.dim}(an unrecognized flag is ignored, so this build would have ` +
        `fanned out over a DIFFERENT set of targets/platforms than you asked ` +
        `for.)${C.r}\n`,
    );
    printTargets();
    return 1;
  }

  const root = Deno.cwd();
  let denoJson: { title?: string; build?: BuildBlock; entry?: string };
  try {
    denoJson = JSON.parse(await Deno.readTextFile(join(root, "deno.json")));
  } catch {
    console.error(`${C.red}✗ no readable deno.json in ${root}${C.r}`);
    return 1;
  }
  const block: BuildBlock = denoJson.build ?? {};
  const title = denoJson.title ?? basename(root);
  const binaryName = slugify(title);

  // Target list: --targets= overrides deno.json build.targets. Both spellings
  // of `targets` (array, object-with-overrides) collapse here, once.
  const argTargets = flag("targets");
  const targetList = normalizeTargets(block.targets, argTargets);
  if (targetList.length === 0) {
    console.error(
      `${C.red}✗ no targets to build.${C.r} Add ${C.blue}"build": { "targets": [...] }${C.r} to deno.json, or pass ${C.blue}--targets=server,electron-client${C.r}\n`,
    );
    printTargets();
    return 1;
  }
  const unknown = targetList.filter((t) => !(t.name in TARGETS));
  if (unknown.length > 0) {
    console.error(
      `${C.red}✗ unknown target(s): ${
        unknown.map((t) => t.name).join(", ")
      }${C.r}\n`,
    );
    printTargets();
    return 1;
  }
  // A fleet of clients with nothing to connect to is a config that BUILDS
  // fine and ships broken: `*-client` artifacts dial a server, and a fleet
  // declaring clients but no `server` target and no `build.server` address
  // records nothing for them to dial (a field report shipped exactly this —
  // `["browser", "electron-client", "android-client"]`, where `browser` is a
  // LOCAL app binary, not the exposed server the clients need). Loud warning,
  // not an error: the server may legitimately be built elsewhere.
  const clientTargets = targetList.filter((t) =>
    TARGETS[t.name]?.role === "client"
  );
  const hasServerTarget = targetList.some((t) =>
    TARGETS[t.name]?.role === "server"
  );
  if (clientTargets.length > 0 && !hasServerTarget && !block.server) {
    console.error(
      `${C.yellow}⚠ fleet declares client target(s) (${
        clientTargets.map((t) => t.name).join(", ")
      }) but no "server" target and no "build": { "server": "host:port" }.${C.r}\n` +
        `  Clients dial a server; this fleet records none. Add the ${C.blue}server${C.r} target ` +
        `(builds the exposed --remote binary), or set ${C.blue}"build": { "server": "192.168.1.50:8000" }${C.r} ` +
        `if it is built/hosted elsewhere.\n  ${C.dim}(browser/electron/android without -client are LOCAL app binaries, not servers)${C.r}`,
    );
  }

  // A per-target `entry` that names no file compiles nothing useful and is a
  // typo you find minutes later in a deno compile error — check it here, where
  // the target it belongs to can be named.
  const missingEntries: string[] = [];
  for (const t of targetList) {
    if (!t.entry) continue;
    try {
      await Deno.stat(join(root, t.entry));
    } catch {
      missingEntries.push(`${t.name} → ${t.entry}`);
    }
  }
  if (missingEntries.length > 0) {
    console.error(
      `${C.red}✗ build.targets entry not found:${C.r}\n${
        missingEntries.map((m) => `  ${m}`).join("\n")
      }\n  ${C.dim}paths are relative to ${root}${C.r}`,
    );
    return 1;
  }

  // Platform list: --platforms= overrides deno.json build.platforms; the
  // default is this machine only, so an existing project's build is unchanged.
  // `--all-platforms` — the one-liner for "ship everything this repo can
  // produce from here". It expands to every platform aio knows, and the
  // per-target refusal below still applies: an Electron AppImage needs a Linux
  // host, an APK is built once. Nothing is silently dropped — every skip is
  // printed with its reason, so "all" never quietly means "some".
  const argPlatforms = flag("platforms");
  const allPlatforms = Deno.args.includes("--all-platforms");
  const rawPlatforms = allPlatforms
    ? Object.keys(PLATFORMS)
    : argPlatforms
    ? argPlatforms.split(",")
    : block.platforms ?? ["host"];
  const platformsResolved = resolvePlatforms(rawPlatforms);
  if (!platformsResolved.ok) {
    console.error(`${C.red}✗ ${platformsResolved.error}${C.r}\n`);
    printTargets();
    return 1;
  }
  const platformList = platformsResolved.platforms.length > 0
    ? platformsResolved.platforms
    : [hostPlatform()];

  // A target may narrow the platform list to its own — resolved here so a bad
  // name is refused before any build runs, naming the target that declared it.
  const targetPlatforms = new Map<string, string[]>();
  for (const t of targetList) {
    if (!t.platforms) continue;
    const r = resolvePlatforms(t.platforms);
    if (!r.ok) {
      console.error(`${C.red}✗ target "${t.name}": ${r.error}${C.r}\n`);
      printTargets();
      return 1;
    }
    targetPlatforms.set(
      t.name,
      r.platforms.length > 0 ? r.platforms : [hostPlatform()],
    );
  }

  const outDir = resolve(join(root, flag("out") ?? block.out ?? "dist"));
  // The app dirs come from THE decider — one per target, since each target may
  // compile its own entry — so `out` can never be pointed at the directory
  // holding ANY of the built apps' sources, whatever layout they use.
  const appDirs = [
    ...new Set(
      targetList.map((t) =>
        resolveAppDir(root, resolveEntry(denoJson, t.entry))
      ),
    ),
  ];
  if (unsafeOutDir(outDir, root, appDirs)) {
    console.error(
      `${C.red}✗ refusing to build into ${outDir}${C.r} — it is assembled by ` +
        `DELETING it recursively, so "out" must be a dedicated subdirectory ` +
        `of the project that neither contains nor sits inside the project ` +
        `root, an app dir (${
          appDirs.join(", ") || "none"
        }), src, .git or .aio.`,
    );
    return 1;
  }
  const release = Deno.args.includes("--release");
  const force = Deno.args.includes("--force");

  // Resolve the single-target build entry. Prefer the caller-supplied
  // `--build-spec` (the generated task passes the framework's own build path /
  // jsr specifier, so JSR resolution is preserved); fall back to this module's
  // sibling for a direct `deno run build-all.ts`.
  const buildUrl = new URL("./build.ts", import.meta.url);
  const buildScript = flag("build-spec") ??
    (buildUrl.protocol === "file:" ? fromFileUrl(buildUrl) : buildUrl.href);

  // ── artifact detection ──────────────────────────────────────────────────
  // Per-target builds emit arch-suffixed names we can't fully predict, so we
  // diff the root dir before/after each build and gather what appeared/changed.
  // Key by mtime AND size: on a coarse-mtime filesystem a rebuild that
  // overwrites a same-named artifact within the same second keeps the mtime but
  // changes the size, so size closes the "missed artifact" gap.
  // `bin` is the TARGET's binary name — with per-target names, two targets in
  // one repo are two different apps and `myapp*` would miss `relay`.
  const snapshot = async (bin: string): Promise<Map<string, string>> => {
    const m = new Map<string, string>();
    for await (const e of Deno.readDir(root)) {
      if (!e.isFile || !isArtifactName(e.name, bin)) continue;
      try {
        const st = await Deno.stat(join(root, e.name));
        m.set(e.name, `${st.mtime?.getTime() ?? 0}:${st.size}`);
      } catch { /* vanished — ignore */ }
    }
    return m;
  };

  // Same-filesystem staging (survives each build's dist/ clean; rename is safe).
  const staging = join(root, ".aio", `build-staging-${crypto.randomUUID()}`);
  await Deno.mkdir(staging, { recursive: true });

  // Move the PREVIOUS output out of the per-target builds' reach before any of
  // them runs. `out` defaults to `dist/`, which those builds treat as their own
  // scratch space — the bundle step removes it recursively, and the pre-compile
  // sweep deletes everything in it but app.js/style.css/icon.png. So the last
  // good release (its binaries AND manifest.json, the file a release pipeline
  // reads to decide what to publish) was already gone by the time a failed
  // fleet run reported "no artifacts produced — leaving dist/ untouched".
  // Preserved here, restored on that path, discarded with `staging` otherwise.
  const preservedOut = join(staging, "previous-out");
  let preserved = false;
  try {
    await Deno.rename(outDir, preservedOut);
    preserved = true;
  } catch { /* nothing there yet, or not movable — nothing to protect */ }

  console.log(
    `${C.b}Building ${targetList.length} target(s) for ${C.blue}${title}${C.r}${C.b} → ${
      outDir.replace(root + "/", "")
    }/${C.r}${release ? ` ${C.dim}(release)${C.r}` : ""}`,
  );

  const results: TargetResult[] = [];
  try {
    for (const t of targetList) {
      const target = t.name;
      const spec = TARGETS[target]!;
      // A target's own app title/binary name, else the project's — the one
      // place a per-target name is turned into the name everything downstream
      // (argv, artifact detection, the manifest) uses.
      const targetTitle = t.appName ?? title;
      const targetBin = slugify(targetTitle);
      const platforms = targetPlatforms.get(target) ?? platformList;
      for (const platform of platforms) {
        const label = platforms.length > 1 || !isHostPlatform(platform)
          ? `${target} ${C.dim}[${platform}]${C.r}`
          : target;
        // Electron/Android package with platform-specific tooling — building
        // them for another OS is refused with the reason, not attempted and not
        // silently dropped (a missing artifact people discover at release time).
        const blocker = isHostPlatform(platform)
          ? null
          : crossCompileBlocker(target, platform);
        if (blocker) {
          console.log(
            `\n${C.b}▶ ${label}${C.r} ${C.yellow}skipped${C.r} ${C.dim}— ${blocker}${C.r}`,
          );
          results.push({
            target,
            role: spec.role,
            platform,
            binary: targetBin,
            ...(t.entry ? { entry: t.entry } : {}),
            ok: true,
            skipped: blocker,
            artifacts: [],
          });
          continue;
        }
        console.log(
          `\n${C.b}▶ ${label}${C.r} ${C.dim}— ${spec.desc}${
            t.entry ? ` (${t.entry})` : ""
          }${C.r}`,
        );
        const before = await snapshot(targetBin);
        const args = [
          "run",
          "-A",
          buildScript,
          ...spec.flags,
          `--name=${targetTitle}`,
          `--platform=${platform}`,
          // Per-target entry: the single-target build resolves configEntry —
          // and therefore appDir and every app asset — from this.
          ...(t.entry ? [`--entry=${t.entry}`] : []),
        ];
        if (release) args.push("--release");
        if (force) args.push("--force");
        const { code } = await new Deno.Command("deno", {
          args,
          cwd: root,
          stdout: "inherit",
          stderr: "inherit",
        }).output();

        if (code !== 0) {
          results.push({
            target,
            role: spec.role,
            platform,
            binary: targetBin,
            ...(t.entry ? { entry: t.entry } : {}),
            ok: false,
            error: `build exited ${code}`,
            artifacts: [],
          });
          console.error(`${C.red}✗ ${label} failed (exit ${code})${C.r}`);
          continue;
        }

        // Gather artifacts that appeared or changed, move them to staging.
        const after = await snapshot(targetBin);
        const fresh = [...after].filter(([n, sig]) =>
          !before.has(n) || sig !== before.get(n)
        ).map(([n]) => n);
        const tdir = join(staging, `${target}__${platform}`);
        await Deno.mkdir(tdir, { recursive: true });
        const artifacts: ArtifactRec[] = [];
        for (const name of fresh) {
          await moveFile(join(root, name), join(tdir, name));
          artifacts.push({
            file: name,
            bytes: (await Deno.stat(join(tdir, name))).size,
          });
        }
        // A target that emitted nothing is a FAILED target, not a warning.
        // It used to be `ok: true` with an empty artifact list: the summary
        // printed a green ✓, the exit code stayed 0, and manifest.json — the
        // file a release pipeline reads to decide what to publish — recorded
        // the target as successful with nothing to publish. Every real target
        // emits at least one file into the project root (binary, .service,
        // .apk, .AppImage/.zip), so "nothing appeared" means the build did not
        // do what it said, and that has to stop the fleet.
        if (artifacts.length === 0) {
          const why = `built but produced no recognized artifact for ` +
            `"${targetBin}" in ${root}`;
          console.error(`${C.red}✗ ${label} — ${why}${C.r}`);
          results.push({
            target,
            role: spec.role,
            platform,
            binary: targetBin,
            ...(t.entry ? { entry: t.entry } : {}),
            ok: false,
            error: why,
            artifacts: [],
          });
          continue;
        }
        results.push({
          target,
          role: spec.role,
          platform,
          binary: targetBin,
          ...(t.entry ? { entry: t.entry } : {}),
          ok: true,
          artifacts,
        });
      }
    }

    // ── assemble a clean dist/ (flat) + manifest ────────────────────────────
    // Never destroy a prior good dist/ for a build that produced nothing (every
    // target failed) — leave the previous artifacts in place and just report.
    const totalArtifacts = results.reduce(
      (n, r) => n + (r.ok ? r.artifacts.length : 0),
      0,
    );
    if (totalArtifacts === 0) {
      // Put the previous release back exactly as it was. The per-target builds
      // have been scribbling in `out` (that is why it was moved aside), so the
      // directory standing there now is intermediate rubbish, not a release.
      if (preserved) {
        await Deno.remove(outDir, { recursive: true }).catch(() => {});
        await Deno.rename(preservedOut, outDir);
      }
      // Distinguish "everything was refused" from "everything failed" — a
      // build that skipped every combination is a REQUEST problem (asking for
      // Electron on a foreign OS), and saying "no artifacts produced" for it
      // reads like a crash.
      const allSkipped = results.length > 0 && results.every((r) => r.skipped);
      if (allSkipped) {
        console.error(
          `\n${C.yellow}✗ nothing to build — every target/platform pair was skipped:${C.r}`,
        );
        for (const r of results) {
          console.error(
            `  ${C.dim}${r.target} [${r.platform}] — ${r.skipped}${C.r}`,
          );
        }
        console.error(
          `  ${C.dim}build those on their own OS, or drop them from --platforms${C.r}`,
        );
      } else {
        const rel = outDir.replace(root + SEPARATOR, "");
        console.error(
          `\n${C.red}✗ no artifacts produced — ${
            preserved
              ? `the previous ${rel}/ is intact`
              : `${rel}/ holds no release`
          }${C.r}`,
        );
      }
      return 1;
    }
    await Deno.remove(outDir, { recursive: true }).catch(() => {});
    await Deno.mkdir(outDir, { recursive: true });
    const used = new Set<string>();
    const manifestTargets = [];
    for (const r of results) {
      const placed: ArtifactRec[] = [];
      if (r.ok) {
        for (const a of r.artifacts) {
          // Flat layout: on a cross-target name collision, disambiguate with the
          // target so nothing silently overwrites (e.g. browser + server binary).
          // Cross-built artifacts already carry their platform (artifactName),
          // so the two axes never collide with each other.
          const name = placedName(a.file, used, r.target);
          used.add(name);
          await moveFile(
            join(staging, `${r.target}__${r.platform}`, a.file),
            join(outDir, name),
          );
          placed.push({ file: name, bytes: a.bytes });
        }
      }
      manifestTargets.push({
        target: r.target,
        role: r.role,
        binary: r.binary,
        ...(r.entry ? { entry: r.entry } : {}),
        // The platform each artifact RUNS on — the manifest is what a release
        // pipeline reads to decide what to publish where, so it must say.
        platform: r.platform,
        triple: PLATFORMS[r.platform]?.triple ?? null,
        host: isHostPlatform(r.platform),
        ok: r.ok,
        ...(r.skipped ? { skipped: r.skipped } : {}),
        ...(r.error ? { error: r.error } : {}),
        artifacts: placed,
      });
    }
    const manifest = {
      app: binaryName,
      title,
      builtAt: new Date().toISOString(),
      release,
      /** The machine this was built on. Only these artifacts were runnable
       *  here; the rest were cross-compiled and are checked, not booted. */
      builtOn: hostPlatform(),
      // Every platform actually attempted, including the ones a target
      // narrowed itself to — the list, not just the global default.
      platforms: [...new Set(results.map((r) => r.platform))],
      server: block.server ?? null,
      targets: manifestTargets,
    };
    await Deno.writeTextFile(
      join(outDir, "manifest.json"),
      JSON.stringify(manifest, null, 2) + "\n",
    );
  } finally {
    await Deno.remove(staging, { recursive: true }).catch(() => {});
  }

  // ── summary ───────────────────────────────────────────────────────────────
  const failed = results.filter((r) => !r.ok);
  const rel = (p: string) => p.replace(root + "/", "");
  console.log(`\n${C.b}── build summary ──${C.r}`);
  const multi = new Set(results.map((r) => r.platform)).size > 1;
  const tag = (t: TargetResult) =>
    multi || !isHostPlatform(t.platform)
      ? `${t.target} ${C.dim}[${t.platform}]${C.r}`
      : t.target;
  for (const t of results) {
    if (!t.ok) {
      console.log(`  ${C.red}✗ ${tag(t)}${C.r} ${C.dim}${t.error}${C.r}`);
      continue;
    }
    if (t.skipped) {
      console.log(`  ${C.yellow}– ${tag(t)}${C.r} ${C.dim}${t.skipped}${C.r}`);
      continue;
    }
    const files = t.artifacts.map((a) =>
      `${a.file} ${C.dim}(${human(a.bytes)})${C.r}`
    );
    console.log(
      `  ${C.green}✓ ${tag(t)}${C.r} ${C.dim}→${C.r} ${
        files.join(", ") || C.dim + "no artifact" + C.r
      }`,
    );
  }
  // Say plainly which artifacts were never executed here. A cross-compiled
  // binary is built and checked, not booted — claiming otherwise is the kind
  // of "it built, so it works" that the artifact E2E exists to disprove.
  const crossed = [
    ...new Set(
      results.map((r) => r.platform).filter((p) => !isHostPlatform(p)),
    ),
  ];
  if (crossed.length > 0) {
    console.log(
      `\n  ${C.dim}cross-compiled (not run here — built on ${hostPlatform()}):${C.r} ${C.blue}${
        crossed.join(", ")
      }${C.r}`,
    );
  }
  if (block.server) {
    console.log(
      `\n  ${C.dim}clients connect to server:${C.r} ${C.blue}${block.server}${C.r}`,
    );
  }
  const skipped = results.filter((r) => r.skipped).length;
  const built = results.length - failed.length - skipped;
  console.log(
    `\n${failed.length ? C.red : C.green}${
      failed.length ? "✗" : "✓"
    } ${built}/${results.length - skipped} build(s) → ${C.blue}${
      rel(outDir)
    }/${C.r}${skipped ? ` ${C.dim}(${skipped} skipped)${C.r}` : ""}`,
  );
  return failed.length ? 1 : 0;
}

if (import.meta.main) Deno.exit(await buildAll());
