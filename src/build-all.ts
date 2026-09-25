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
import { readDenoJson } from "./server/deno-json.ts";
import {
  unknownBuildKeys,
  VALID_BUILD_KEYS,
  VALID_BUILD_TARGET_KEYS,
} from "./server/config.ts";
import {
  basename,
  extname,
  fromFileUrl,
  join,
  resolve,
  SEPARATOR,
} from "@std/path";
import { slugify } from "./build/build-helpers.ts";
import { emptyDir, moveDirContents } from "./build/dist-staging.ts";
import {
  flagVocabulary,
  FLEET_BOOL_FLAGS,
  FLEET_VALUE_FLAGS,
  lastFlag,
  unknownFleetFlags,
} from "./build/build-flags.ts";
import {
  displayNameClashes,
  resolveAppDir,
  resolveEntry,
} from "./build/build-config.ts";
import { DIST_DIR } from "./server/app-files.ts";
import { bakedServerUrl } from "./server/paths.ts";
import { ansi } from "./diagnostics/color.ts";
import { bytes, count, style, tally } from "./diagnostics/fmt.ts";
import {
  artifactName,
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
/** The fleet target a set of single-target build flags names — derived from
 *  {@link TARGETS} itself, so there is no second table to drift.
 *
 *  THIS IS WHAT MAKES ONE BUILD PATH POSSIBLE. `src/build.ts` used to be a
 *  second entry point: `deno task compile:electron` (the pre-alpha52 scaffold
 *  emitted a whole `compile:*` matrix) ran it directly, which writes
 *  `<name>-<arch>.AppImage` into the project root — while `deno task build`
 *  ran the fleet, which places `dist/<name>-<version>-<arch>.AppImage`. Two
 *  code paths, two names for one artifact, and only one of them tested by
 *  `test:build`. A direct invocation now resolves its target here and runs the
 *  fleet, so every route ends in the same placement, the same version stamp
 *  and the same 61-case artifact E2E.
 *
 *  Exact set equality, not a subset: `--compile --cli` is `cli` and
 *  `--compile --cli --remote` is `cli-client`, and a subset match would call
 *  the second one the first. Pure. */
export function targetForFlags(flags: readonly string[]): string | null {
  // Only the flags that BUILD something take part. `--name=`, `--platform=`,
  // `--entry=`, `--release` and friends qualify a build; they do not choose a
  // target, and letting them into the comparison would make every real
  // invocation match nothing. The vocabulary is derived from TARGETS itself.
  const vocabulary = new Set(
    Object.values(TARGETS).flatMap((s) => s.flags),
  );
  const want = new Set(flags.filter((f) => vocabulary.has(f)));
  // `--cli` and `--electron` IMPLY `--compile` — they always have: the single
  // target builder reads `doCompile = --compile || --electron` and `--cli`
  // compiles a binary of its own. The fleet spells those targets out in full
  // (`--compile --cli`), so a user who types the short form is naming the same
  // build and must reach the same target. Written here rather than in the
  // caller because it is part of "which target do these flags name", which is
  // this function's whole question.
  if (want.has("--cli") || want.has("--electron")) want.add("--compile");
  for (const [name, spec] of Object.entries(TARGETS)) {
    const have = new Set(spec.flags);
    if (have.size !== want.size) continue;
    if ([...have].every((f) => want.has(f))) return name;
  }
  return null;
}

/** Every buildable target of the fleet, keyed by the name you pass to
 *  `deno task build` — its build flags, role, and one-line description. */
export const TARGETS: Record<string, TargetSpec> = {
  server: {
    flags: ["--compile", "--service", "--headless", "--remote"],
    role: "server",
    desc: "headless LAN/remote server binary + systemd unit (--expose)",
  },
  "server-app": {
    // R-6: an exposed server that also SERVES its page — status UI,
    // download shelf, dashboards. `server` is headless by definition; this is
    // the same binary WITH the browser bundle embedded. Before it had a name,
    // reaching it took a two-pass build that only reading build.ts revealed.
    flags: ["--compile", "--service", "--remote"],
    role: "server",
    desc:
      "exposed server binary WITH the browser UI (serves its page + systemd unit)",
  },
  browser: {
    flags: ["--compile"],
    role: "app",
    desc: "self-contained binary serving the browser app",
  },
  electron: {
    flags: ["--compile", "--electron"],
    role: "app",
    desc: "Electron desktop app (AppImage / .app + .dmg)",
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
  // No `ios` APP target exists and none can: an aio app is a Deno process and
  // there is no Deno on iOS. The client is a WKWebView shell around the
  // connect page — an Xcode project on any host, an .app where xcodebuild is.
  "ios-client": {
    flags: ["--ios", "--remote"],
    role: "client",
    desc: "iOS client (Xcode project; .app on macOS) that connects to a server",
  },
};

/** What a target may override when `build.targets` is written in object form.
 *  Everything is optional — an empty object is the array form's behaviour. */
export interface TargetOverride {
  /** What KIND of target this is — a key of {@link TARGETS}. Lets one repo
   *  declare TWO targets of the same kind under different labels:
   *
   *  ```jsonc
   *  "targets": {
   *    "agent":   { "kind": "electron", "entry": "src/agent/app.ts",   "name": "remote-agent" },
   *    "control": { "kind": "electron", "entry": "src/control/app.ts", "name": "remote-control" }
   *  }
   *  ```
   *  Optional when the label itself is a known target name (backwards
   *  compatible: `"electron": {…}` keeps meaning what it means today). */
  kind?: string;
  /** The module THIS target compiles, overriding deno.json `entry`. One repo,
   *  two apps: a relay server and the client that talks to it. */
  entry?: string;
  /** The UI component this target bundles, relative to ITS app dir (the
   *  directory of its entry) — passed to the single-target build as `--ui=`.
   *  Default: the App.tsx convention. */
  ui?: string;
  /** This target's binary/APK name, overriding deno.json `title`. Two
   *  different apps must not both be called `myapp` and be papered over by the
   *  collision suffix — they are not two builds of one app. */
  name?: string;
  /** The name a person SEES for this target's artifact — the macOS `.app`
   *  and DMG volume, the Linux `.desktop` `Name=`, the icon monogram, the
   *  Android label — overriding deno.json `title`. `name` names the FILES
   *  only. Two desktop targets that show one title install over each other
   *  in /Applications; the build warns and names this key. The running app's
   *  window title still comes from `aio.run({ ui: { title } })`. */
  title?: string;
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
  /** This target's LABEL — the deno.json key / --targets= word. Names the
   *  target in output, staging dirs and the manifest. */
  name: string;
  /** Key into {@link TARGETS} — what actually gets built. Equal to `name`
   *  unless the object form declared an explicit `kind`. */
  kind: string;
  /** Per-target entry module, or undefined to use deno.json `entry`. */
  entry?: string;
  /** Per-target UI component (relative to the target's app dir), or undefined
   *  for the App.tsx convention. */
  ui?: string;
  /** Per-target app name (pre-slugify), or undefined to use deno.json `title`. */
  appName?: string;
  /** Per-target display name, or undefined to use deno.json `title`. */
  title?: string;
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
      kind: o?.kind?.trim() || name,
      ...(o?.entry ? { entry: o.entry.trim() } : {}),
      ...(o?.ui ? { ui: o.ui.trim() } : {}),
      ...(o?.name ? { appName: o.name.trim() } : {}),
      // Whitespace-only is unset: the clash check and the build must see the
      // same title, and a blank one names nothing.
      ...(o?.title?.trim() ? { title: o.title.trim() } : {}),
      ...(Array.isArray(o?.platforms) ? { platforms: o.platforms } : {}),
    };
  });
}

import {
  buildBlockShapeProblems,
  buildBlockShapeWarnings,
  foreignOutEntries,
} from "./build/build-shape.ts";
import { iosArtifactName } from "./build/build-ios.ts";
import {
  artifactVersion,
  BUILD_VERSION_ENV,
  type BuildVersion,
  buildVersionFor,
  buildVersionNotes,
  unpublishableReason,
  versionedArtifactName,
} from "./build/build-version.ts";

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
// The fleet build's palette used to be seven private `\x1b[…m` constants —
// a second spelling of the house colours, which is how `✓` ended up a
// different green here than in `am`. Interpolation-shaped so the existing
// `${C.green}…${C.r}` call sites keep working, but every code now comes from
// `style` (src/diagnostics/fmt.ts) and therefore from the ONE colour decider.
const C = {
  b: ansi("\x1b[1m"),
  dim: ansi("\x1b[2m"),
  red: ansi("\x1b[31m"),
  green: ansi("\x1b[32m"),
  blue: ansi("\x1b[36m"),
  yellow: ansi("\x1b[33m"),
  r: ansi("\x1b[0m"),
};

/** A `--name=value` from argv. THE LAST OCCURRENCE WINS, and a repeat is
 *  said out loud.
 *
 *  It used to take the FIRST, which made `deno task compile --targets=cli`
 *  build the default target instead: the `compile` task line already carries
 *  `--targets=<default>`, so the operator's word was silently outranked by
 *  the task's. Nothing reported it — the build succeeded, on the wrong
 *  target, and named its artifact accordingly.
 *
 *  Last-wins is also what `parseCli` has always done for the runtime's own
 *  flags (its loop assigns on every match), so this is one rule for argv in
 *  aio rather than two readers disagreeing. It is the reading that matches
 *  intent, too: the task line is the app author's default and the command
 *  line is the operator's override, in that order, on one line. */
const flag = (name: string): string | undefined =>
  lastFlag(Deno.args, name, (values) => {
    console.warn(
      `${C.yellow}⚠ --${name} was given ${values.length} times${C.r} (${
        values.join(", ")
      }) — using the last: ${C.b}${values.at(-1)}${C.r}`,
    );
  });

/** Human byte size. */
/** Artifact sizes, in the ONE spelling aio prints bytes in (`fmt.bytes`).
 *  This used to round KB to whole numbers and GB to two decimals, so the same
 *  file read `214 KB` here and `214.3 KB` in `am` — the second copy of a
 *  formatter always ends up disagreeing with the first about something. */
const human = bytes;

const ARTIFACT_EXTS = new Set([
  ".AppImage",
  ".apk",
  ".zip",
  ".dmg",
  ".service",
  ".exe",
]);

/** Is `name` a build artifact for `binaryName`? Per-target builds emit
 *  arch-suffixed names we can't fully predict, so we recognize by prefix+ext
 *  (the bare binary has no extension; the aio-client AppImage has its own).
 *
 *  @internal alpha70 — a build/tooling internal reachable for tests via
 *  src/testing/internal.ts; not app-facing API. */
export function isArtifactName(name: string, binaryName: string): boolean {
  // A placed artifact carries THE version after its base name
  // (`myapp-1.2.345-client.apk`); the builders write it without. Both are this
  // app's — one rule, applied to the unversioned form. `artifactVersion` is the
  // other half of the same decider (what version a placed file carries).
  const split = artifactVersion(name, binaryName);
  if (split === null) return false;
  if (split.version !== null) name = split.unversioned;
  const ext = extname(name);
  if (ARTIFACT_EXTS.has(ext)) {
    return name.startsWith(binaryName) || name.startsWith("aio-client-");
  }
  if (ext === "") {
    if (
      name === binaryName || name === `${binaryName}-client` ||
      name === iosArtifactName(binaryName) ||
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

/** Which targets must carry their label in the artifact name — computed from
 *  the PROJECT, never from what one command line happened to build.
 *
 *  That distinction is the whole fix. Naming used to be decided by collision
 *  order inside one run, so `--targets=cli` wrote `dist/notes` (on top of the
 *  browser binary that had been there) while `--targets=browser,cli` wrote
 *  `dist/notes` AND `dist/notes-cli` — the same target, two names, depending
 *  on what else you happened to build in the same command. Anything
 *  downstream (an installer, a ship manifest, a script) then pointed at a file
 *  whose identity changed with the invocation.
 *
 *  The universe is every target the project DECLARES plus any this run adds,
 *  in that order. Targets are grouped by the binary name they produce; a group
 *  of one keeps the bare name (a repo whose two targets are two differently
 *  named apps — `relay` and `two-apps` — needs no suffix at all), and inside a
 *  group everything after the FIRST declared member is suffixed. Every
 *  target's artifact name is therefore a property of the project: stable
 *  across `--targets=` subsets, incremental builds and machines.
 *
 *  @internal alpha70 — a build/tooling internal reachable for tests via
 *  src/testing/internal.ts; not app-facing API. */
export function suffixedTargets(
  raw: string[] | Record<string, TargetOverride> | undefined,
  running: readonly ResolvedTarget[],
  binaryNameOf: (t: ResolvedTarget) => string,
): Set<string> {
  const universe = [...normalizeTargets(raw, undefined)];
  for (const t of running) {
    if (!universe.some((u) => u.name === t.name)) universe.push(t);
  }
  const byName = new Map<string, string[]>();
  for (const t of universe) {
    const key = binaryNameOf(t);
    (byName.get(key) ?? byName.set(key, []).get(key)!).push(t.name);
  }
  const suffixed = new Set<string>();
  for (const group of byName.values()) {
    for (const label of group.slice(1)) suffixed.add(label);
  }
  return suffixed;
}

/** Which file name a target's artifact starts from, by target kind — the
 *  shape the single-target builder writes (see `isArtifactName`).
 *
 *  Targets only collide when they write the SAME name. Grouping by the app's
 *  binary name alone treated every client as a collision with the server it
 *  dials: `["server", "cli-client"]` labelled the client, whose artifact
 *  already says what it is, and placed `notes-1.2.345-client-cli-client`
 *  where docs/build/versioning.md promises `notes-1.2.345-client` (the
 *  android client likewise, as `…-client-android-client.apk`). */
const ARTIFACT_SHAPE: Readonly<Record<string, string>> = {
  server: "<bin>",
  "server-app": "<bin>",
  browser: "<bin>",
  cli: "<bin>",
  electron: "<bin>-<arch>.AppImage",
  android: "<bin>.apk",
  "android-client": "<bin>-client.apk",
  "cli-client": "<bin>-client",
  "ios-client": "<bin>-ios-client",
  // Not named after the app at all — two of these collide whatever they build.
  "electron-client": "aio-client-<arch>.AppImage",
};

/** The collision group of a target's artifact: two targets in one group would
 *  write the same file, so all but the first declared carry their label.
 *  Pure. An unknown kind is its own group (it collides with nothing known). */
function artifactGroup(kind: string, binaryName: string): string {
  return (ARTIFACT_SHAPE[kind] ?? `<bin>:${kind}`).replace("<bin>", binaryName);
}

/** The flat-layout name for `file` built by `target`: the bare name, unless
 *  this target shares its binary name with an earlier-declared one.
 *
 *  Pure and composition-independent — see `suffixedTargets`.
 *
 *  @internal alpha70 — a build/tooling internal reachable for tests via
 *  src/testing/internal.ts; not app-facing API. */
export function placedName(
  file: string,
  target: string,
  suffixed: ReadonlySet<string>,
  /** THE build version — every placed artifact carries it right after the
   *  binary name (`<name>-<version>…`), dirty/nogit suffix included, so a
   *  dirty artifact is visibly dirty. `binaryName` says where the name ends. */
  version?: { version: string; binaryName: string },
): string {
  const labelled = ((): string => {
    if (!suffixed.has(target)) return file;
    const ext = extname(file);
    const base = file.slice(0, file.length - ext.length);
    // An artifact that already carries its label (the iOS project directory
    // is written as `<name>-ios-client`) is not labelled twice.
    if (base.endsWith(`-${target}`)) return file;
    return `${base}-${target}${ext}`;
  })();
  return version
    ? versionedArtifactName(labelled, version.binaryName, version.version)
    : labelled;
}

/** Target kinds whose artifact is a bare binary booting `aio.run()` — the
 *  ones `--version` answers with the identity the app will run under. */
const IDENTITY_KINDS: ReadonlySet<string> = new Set([
  "server",
  "server-app",
  "browser",
]);

/** A placed artifact to ask for its runtime identity. */
interface IdentityProbe {
  target: string;
  /** The binary name the build gave it (per-target `name`, else the title). */
  binary: string;
  path: string;
}

/** Ask each placed binary which appId it runs under: `--version` prints
 *  `<appId> [<version>] (aio …)` from the SAME `resolveAppId` call the boot
 *  makes, explicit `aio.run({ appId })` included — measured, not inferred from
 *  deno.json, which cannot see what an entry passes. Unanswered probes are
 *  dropped: the build's own smoke run already refused a binary that does not
 *  run. */
async function probeIdentities(
  probes: readonly IdentityProbe[],
): Promise<(IdentityProbe & { appId: string })[]> {
  const out: (IdentityProbe & { appId: string })[] = [];
  for (const p of probes) {
    try {
      const r = await new Deno.Command(p.path, {
        args: ["--version"],
        stdout: "piped",
        stderr: "null",
        signal: AbortSignal.timeout(30_000),
      }).output();
      const line = new TextDecoder().decode(r.stdout).trim().split("\n").pop();
      const appId = line?.match(/^(\S+)(?: \S+)? \(aio [^)]*\)$/)?.[1];
      if (r.success && appId) out.push({ ...p, appId });
    } catch {
      /* not runnable here — the build's smoke run owns that verdict */
    }
  }
  return out;
}

/** One warning per appId that two DIFFERENTLY named apps resolved to.
 *
 *  A per-target `name` renames the BINARY, not the app: a compiled binary
 *  takes its identity from its embedded deno.json (appId > title > name), and
 *  every target of one repo embeds the same one. So the `relay` of a
 *  `{ "server": { "name": "relay", "entry": "src/relay/app.ts" } }` fleet ran
 *  as the main app — `[AIO] Already running: spapp` when both started on one
 *  machine, and one shared data directory when they did not collide.
 *
 *  A warning, not a refusal: two apps deployed to different machines never
 *  meet, and a build that shipped them has been working; and baking the
 *  target name in as the appId would MOVE an already-deployed binary's data
 *  directory on its next build. The fix is the app's own, one line per entry.
 *  Pure. */
function sharedIdentityWarnings(
  probed: readonly { target: string; binary: string; appId: string }[],
): string[] {
  const byId = new Map<string, Map<string, string[]>>();
  for (const p of probed) {
    const bins = byId.get(p.appId) ??
      byId.set(p.appId, new Map()).get(p.appId)!;
    (bins.get(p.binary) ?? bins.set(p.binary, []).get(p.binary)!).push(
      p.target,
    );
  }
  const warnings: string[] = [];
  for (const [appId, bins] of byId) {
    if (bins.size < 2) continue;
    const who = [...bins].map(([b, ts]) => `${b} (${ts.join(", ")})`);
    warnings.push(
      `${who.join(" and ")} are different apps that all run as appId ` +
        `"${appId}" — one lock and one data directory: started ` +
        `on one machine the second refuses with "Already running", and ` +
        `otherwise they share state. A per-target "name" renames the binary, ` +
        `not the app. Give each entry its own identity: ` +
        `aio.run({ appId: "<name>", … }) (docs/basics/app-architectures.md).`,
    );
  }
  return warnings;
}

/** Point a placed systemd unit at the files that are actually in the release,
 *  and return the install steps that use them.
 *
 *  The single-target build writes the unit and its "Install:" advice before
 *  the fleet renames anything, so both named the STAGED files — `sudo cp app
 *  /usr/local/bin/app`, `sudo cp app.service /etc/systemd/system/` — while
 *  `dist/` held `app-1.2.3` and `app-1.2.3.service`. Copied as printed, the
 *  second one also installs the unit as `app-1.2.3.service`, and the
 *  `systemctl enable --now app` right after it finds no such unit. So the
 *  unit's own install comment is rewritten to the placed binary here, and the
 *  steps copy the unit to the name `ExecStart` and `enable` expect. */
async function placeServiceUnit(
  unitPath: string,
  binary: string,
  stagedBin: string,
  renamed: ReadonlyMap<string, string>,
  outRel: string,
): Promise<string[]> {
  const placedBin = renamed.get(stagedBin);
  if (placedBin && placedBin !== stagedBin) {
    const text = await Deno.readTextFile(unitPath);
    await Deno.writeTextFile(
      unitPath,
      text.replace(
        `(sudo cp ${stagedBin} /usr/local/bin/${binary})`,
        `(sudo cp ${placedBin} /usr/local/bin/${binary})`,
      ),
    );
  }
  const unitFile = unitPath.slice(unitPath.lastIndexOf(SEPARATOR) + 1);
  return [
    ...(placedBin
      ? [`sudo cp ${join(outRel, placedBin)} /usr/local/bin/${binary}`]
      : []),
    `sudo cp ${join(outRel, unitFile)} /etc/systemd/system/${binary}.service`,
    `sudo systemctl enable --now ${binary}`,
  ];
}

/** The target names a previous `dist/manifest.json` recorded, so a build can
 *  say which of them this run is about to drop. Missing/unreadable → none. */
async function manifestTargetNames(path: string): Promise<string[]> {
  try {
    const m = JSON.parse(await Deno.readTextFile(path)) as {
      targets?: { target?: string; ok?: boolean }[];
    };
    return (m.targets ?? []).filter((t) => t.ok !== false).map((t) =>
      String(t.target)
    ).filter(Boolean);
  } catch {
    return [];
  }
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

/** EVERY value flag the single-target builder reads, and the fleet flag that
 *  carries it. The fleet is the only build path now (see ONE BUILD PATH), so a
 *  flag this map does not name is a flag that is PARSED, VALIDATED and then
 *  dropped on the floor — accepted in full and silently ignored.
 *
 *  That is not hypothetical. `--platform=windows` reached `refuseBadBuildArgs`,
 *  resolved to a real platform spec, and then never left this process: the
 *  build produced a host ELF binary under the host's name and called it done.
 *  `build-cli.ts` carries a comment describing that exact failure as fixed.
 *  `--out=` went the same way, taking the R-4 remedy with it, and
 *  `--android-dev-url=` took `dev:android`'s whole reason to exist.
 *
 *  @internal alpha75 — a build/tooling internal reachable for tests; not
 *  app-facing API.
 *
 *  `tests/build-flag-passthrough.test.ts` reads the builder's own source for
 *  the flags it parses and fails on any that is neither forwarded here nor
 *  listed as fleet-owned — so the next flag cannot be dropped in silence. */
export const FLEET_FLAG_FOR: Readonly<Record<string, string>> = {
  "--entry": "--entry",
  "--name": "--name",
  "--display-name": "--display-name",
  "--ui": "--ui",
  "--out": "--out",
  // The fleet's axis is a LIST (it fans one build over many platforms); the
  // single-target builder takes exactly one. One name each way, not two.
  "--platform": "--platforms",
  "--android-dev-url": "--android-dev-url",
};

/** Boolean flags the fleet acts on itself.
 *
 *  @internal alpha75 — a build/tooling internal; not app-facing API. */
export const FLEET_BOOLEANS: readonly string[] = [
  "--release",
  "--force",
  "--allow-server-only",
  "--analyze",
];

/** The fleet's own argv for a delegated single-target build.
 *
 *  @internal alpha75 — a build/tooling internal; not app-facing API. */
export function forwardedToFleet(args: readonly string[]): string[] {
  const out: string[] = [];
  for (const a of args) {
    if (FLEET_BOOLEANS.includes(a)) {
      out.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    if (eq <= 0) continue;
    const fleet = FLEET_FLAG_FOR[a.slice(0, eq)];
    if (fleet) out.push(`${fleet}=${a.slice(eq + 1)}`);
  }
  return out;
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
 *  leave a flat-layout app with nowhere to build.
 *
 *  @internal alpha70 — a build/tooling internal reachable for tests via
 *  src/testing/internal.ts; not app-facing API. */
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
  // dist/ is the per-target builds' own scratch: every child wipes it
  // recursively before bundling, so an out dir INSIDE it is deleted mid-run by
  // a sibling target — after the first one reported success. `out: "dist"`
  // ITSELF stays legal, and is the default: the fleet moves the previous dist/
  // aside before any child runs, which is what makes the exact case safe and
  // the nested case fatal. The single-target builder refused `--out=dist/x`
  // for the same reason; since alpha73 routes every build through the fleet,
  // the rule has to live where the decision now is.
  const distDir = trimSep(join(rootDir, DIST_DIR));
  if (out !== distDir && within(out, distDir)) return true;
  // Both directions: `out` may not sit inside a protected dir, and may not
  // swallow one.
  return protectedDirs.some((d) => within(out, d) || within(d, out));
}

/** Move a file, falling back to copy+delete across filesystem boundaries — a
 *  dist/ or .aio on a tmpfs/overlay mount makes a bare rename throw EXDEV. */
/** Bytes of a file, or of every file under a directory artifact. */
async function sizeOf(path: string): Promise<number> {
  const st = await Deno.stat(path);
  if (!st.isDirectory) return st.size;
  let total = 0;
  for await (const e of Deno.readDir(path)) {
    total += await sizeOf(join(path, e.name));
  }
  return total;
}

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
      `${C.dim}  "targets": { "server": { "entry": "src/relay/app.ts", "name": "relay" }, "electron": {} }${C.r}\n` +
      `${C.dim}Two of the SAME kind? Label them and name the kind:${C.r}\n` +
      `${C.dim}  "targets": { "agent": { "kind": "electron", "entry": "src/agent/app.ts", "name": "agent" }, ` +
      `"control": { "kind": "electron", "entry": "src/control/app.ts", "name": "control" } }${C.r}`,
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
    denoJson = (await readDenoJson(root))?.config ?? {};
  } catch {
    console.error(
      `${C.red}✗ no readable deno.json in ${root}${C.r}\n` +
        `  ${C.dim}fix: run from the app directory (the one holding deno.json), ` +
        `or scaffold one: am create <name>${C.r}`,
    );
    return 1;
  }
  const targetsOverridden = flag("targets") !== undefined;
  const shapeProblems = buildBlockShapeProblems(denoJson.build, {
    targetsOverridden,
  });
  if (shapeProblems.length > 0) {
    console.error(
      `${C.red}✗ deno.json build block:${C.r}\n${
        shapeProblems.map((p) => `  ${p}`).join("\n")
      }\n`,
    );
    printTargets();
    return 1;
  }
  for (
    const w of buildBlockShapeWarnings(denoJson.build, { targetsOverridden })
  ) {
    console.warn(`${C.yellow}⚠ deno.json ${w}${C.r}`);
  }
  // A misspelled key builds the DEFAULT of what it meant (`targtes` → the
  // declared-or-empty target list, `platform` → host only) and said nothing;
  // the linter knew, the build did not. Warned, not refused: a stray key
  // built before and must keep building.
  const strayKeys = unknownBuildKeys(denoJson.build);
  if (strayKeys.length > 0) {
    console.warn(
      `${C.yellow}⚠ deno.json build block: aio never reads ${
        strayKeys.join(", ")
      } — ${
        strayKeys.length === 1 ? "it does" : "they do"
      } nothing in this build.${C.r}\n  ${C.dim}known: ${
        [...VALID_BUILD_KEYS].join(", ")
      }; per target: ${[...VALID_BUILD_TARGET_KEYS].join(", ")}${C.r}`,
    );
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
  const unknown = targetList.filter((t) => !(t.kind in TARGETS));
  if (unknown.length > 0) {
    console.error(
      `${C.red}✗ unknown target(s): ${
        unknown.map((t) =>
          t.kind === t.name ? t.name : `${t.name} (kind: ${t.kind})`
        ).join(", ")
      }${C.r}\n  ${C.dim}a label that is not itself a target name needs ` +
        `"kind": e.g. "agent": { "kind": "electron", "entry": "src/agent/app.ts" }${C.r}\n`,
    );
    printTargets();
    return 1;
  }
  // Two labels are two targets; two IDENTICAL labels can only be a typo the
  // object form cannot express — but --targets=a,a can. Refuse.
  const dupLabels = targetList.map((t) => t.name).filter((n, i, a) =>
    a.indexOf(n) !== i
  );
  if (dupLabels.length > 0) {
    console.error(
      `${C.red}✗ duplicate target label(s): ${
        [...new Set(dupLabels)].join(", ")
      }${C.r}\n  ${C.dim}fix: name each target once — --targets=${
        [...new Set(targetList.map((t) => t.name))].join(",")
      }${C.r}\n`,
    );
    return 1;
  }
  // An address that is not one fails HERE, once, naming the field — not once
  // per child build after the server target has already compiled.
  try {
    bakedServerUrl(block.server);
  } catch (e) {
    console.error(`${C.red}✗ ${(e as Error).message}${C.r}\n`);
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
    TARGETS[t.kind]?.role === "client"
  );
  const hasServerTarget = targetList.some((t) =>
    TARGETS[t.kind]?.role === "server"
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

  // Two desktop editions that SHOW one name install over each other: the
  // macOS `.app` in /Applications is named by the display name, not the file
  // name. A per-target `name` renames the files only (changing that would
  // rename shipped apps), so say it here, naming the key that fixes it.
  const projectTitle = typeof denoJson.title === "string" && denoJson.title
    ? denoJson.title
    : undefined;
  for (
    const [a, b, shown] of displayNameClashes(targetList.map((t) => {
      const bin = slugify(t.appName ?? flag("name") ?? title);
      return {
        label: t.name,
        kind: t.kind,
        display: t.title ?? flag("display-name") ?? projectTitle ?? bin,
        binary: bin,
      };
    }))
  ) {
    console.warn(
      `${C.yellow}⚠ targets "${a}" and "${b}" are two apps that both show as ` +
        `"${shown}"${C.r} — installed on macOS, the second ${shown}.app ` +
        `replaces the first in /Applications.\n  fix: give one its own ` +
        `display name: ${C.blue}"build": { "targets": { "${b}": { "title": ` +
        `"${shown} …" } } }${C.r}`,
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

  // `resolve(root, arg)`, not `resolve(join(root, arg))`. `join()` swallows
  // the leading separator of a later segment, so `--out=/srv/release` became
  // `<root>/srv/release` — a directory INSIDE the project, which
  // `unsafeOutDir` then approved. The summary printed the leading slash
  // stripped, so it read as the path that was asked for, and the artifact was
  // nowhere near it. A RELATIVE escape (`--out=../release`) was refused
  // loudly the whole time, so the check worked for one spelling and was
  // silently bypassed by the other. `build-config.ts` has always used
  // `resolve(root, outArg ?? ".")` — two readers of one flag, disagreeing.
  //
  // With this, an absolute path outside the project reaches `unsafeOutDir`
  // and is REFUSED by name, which is the answer the relative form already
  // gave.
  const outDir = resolve(root, flag("out") ?? block.out ?? DIST_DIR);
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
    // dist/ has its own reason, and a generic "pick another directory" would
    // hide it: this one is not about deleting the user's files, it is about
    // the build deleting its OWN output between targets.
    const distDir = resolve(join(root, DIST_DIR));
    if (outDir !== distDir && outDir.startsWith(distDir + SEPARATOR)) {
      console.error(
        `${C.red}✗ refusing to build into ${outDir}${C.r} — it points inside ` +
          `dist/, which is the bundle staging dir: it is embedded into the ` +
          `binary wholesale and wiped by every target this run builds.\n  ` +
          `${C.dim}fix: pick a directory of its own (--out=out, ` +
          `--out=out/agent).${C.r}`,
      );
      return 1;
    }
    console.error(
      `${C.red}✗ refusing to build into ${outDir}${C.r} — it is assembled by ` +
        `DELETING it recursively, so "out" must be a dedicated subdirectory ` +
        `of the project that neither contains nor sits inside the project ` +
        `root, an app dir (${
          appDirs.join(", ") || "none"
        }), src, .git or .aio.\n  ${C.dim}fix: "build": { "out": "dist" } in ` +
        `deno.json (or --out=dist), then delete the "out" that pointed here.${C.r}`,
    );
    return 1;
  }
  // …and it must hold nothing but a previous release. dist/ is exempt: it is
  // aio's own staging dir, which every per-target build wipes anyway.
  if (outDir !== resolve(join(root, DIST_DIR))) {
    const entries: string[] = [];
    // A directory's own entries — a publish channel dir (see
    // foreignOutEntries) is aio's only when everything in it is.
    const dirs: Record<string, string[]> = {};
    try {
      for await (const e of Deno.readDir(outDir)) {
        entries.push(e.name);
        if (!e.isDirectory) continue;
        const inside: string[] = [];
        for await (const f of Deno.readDir(join(outDir, e.name))) {
          // A nested directory is never publish output: listed as itself, it
          // matches no rule and keeps the directory foreign.
          inside.push(f.isDirectory ? `${f.name}/` : f.name);
        }
        dirs[e.name] = inside;
      }
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
    }
    let previous: unknown = null;
    try {
      previous = JSON.parse(
        await Deno.readTextFile(join(outDir, "manifest.json")),
      );
    } catch {
      // aio-ok: no previous release here — every entry is foreign, which is
      // the refusing answer, so nothing is swallowed
    }
    const foreign = foreignOutEntries(entries, previous, dirs);
    if (foreign.length > 0) {
      const shown = foreign.slice(0, 5).join(", ") +
        (foreign.length > 5 ? `, … (${foreign.length} in all)` : "");
      console.error(
        `${C.red}✗ refusing to build into ${outDir}${C.r} — it holds files ` +
          `no aio build put there (${shown}), and "out" is emptied and ` +
          `refilled on every build: they would be DELETED.\n  ${C.dim}fix: ` +
          `point "out" at a directory of its own, or move those files out ` +
          `first.${C.r}`,
      );
      return 1;
    }
  }
  const release = Deno.args.includes("--release");
  const force = Deno.args.includes("--force");
  // THE app version, resolved ONCE for the whole fleet and handed to every
  // per-target build (AIO_BUILD_VERSION) — so every artifact of one run
  // carries one version, and the notes print once.
  let version: BuildVersion;
  try {
    version = (await buildVersionFor(
      root,
      (denoJson as { version?: unknown }).version,
      { out: block.out },
    )).bv;
  } catch (e) {
    console.error(`${C.red}${e instanceof Error ? e.message : e}${C.r}`);
    return 1;
  }
  for (const n of buildVersionNotes(version)) {
    console.log(`  ${C.yellow}note:${C.r} ${n}`);
  }
  // A fleet build is reached from a CLI, so the CLI's own spelling is the
  // one its reader can type.
  const _unpublishable = unpublishableReason(version.version, "--allow-dirty");
  if (release && _unpublishable) {
    console.log(
      `  ${C.yellow}note:${C.r} ${_unpublishable} — this --release build ` +
        `cannot be published as is`,
    );
  }
  // Forwarded, not interpreted: only `--android` consults it (see
  // build-bundle's standalone-APK gate). It has to travel through the fleet
  // because the fleet IS the build path — `deno task build` and `deno task
  // compile` are both this module, so a flag it does not forward is a flag no
  // scaffolded app can reach.
  const allowServerOnly = Deno.args.includes("--allow-server-only");
  // The bundle-size report is printed by the child that bundles, so the flag
  // has to reach it — accepted and dropped, it was a flag that did nothing.
  const analyze = Deno.args.includes("--analyze");

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
      // Files by name; the one DIRECTORY artifact (an iOS Xcode project) by
      // its exact name.
      const isDirArtifact = e.isDirectory && e.name === iosArtifactName(bin);
      if (!isDirArtifact && (!e.isFile || !isArtifactName(e.name, bin))) {
        continue;
      }
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
  // Its CONTENTS move, never the directory: `out` is typically `dist/`, which
  // a lab VM bind-mounts and serves to its guest, and a bind mount follows the
  // inode. Renaming the directory aside gave the guest an empty share for the
  // life of the lab while every host-side reading stayed correct — see
  // `emptyDir` in src/build/dist-staging.ts.
  let preserved = false;
  try {
    preserved = await moveDirContents(outDir, preservedOut);
  } catch (e) {
    // SAID, not swallowed. The previous release stays where it is (the move
    // rolls itself back), but the per-target builds treat `out` as scratch and
    // will empty it — so this is the moment the last good release stops being
    // recoverable, and a build that fails after it used to report "the
    // previous dist/ is intact" when it no longer was.
    console.warn(
      `${C.yellow}! could not move the previous ${
        outDir.replace(root + SEPARATOR, "")
      }/ aside${C.r} — ${
        e instanceof Error ? e.message : String(e)
      }. It is still there and still intact, but this build will overwrite it: ` +
        `if it fails, there is no release to put back.`,
    );
  }

  console.log(
    `${C.b}Building ${
      count(targetList.length, "target")
    } for ${C.blue}${title}${C.r}${C.b} ${version.version} → ${
      outDir.replace(root + SEPARATOR, "")
    }/${C.r}${release ? ` ${C.dim}(release)${C.r}` : ""}`,
  );

  const results: TargetResult[] = [];
  const rel = (p: string) => p.replace(root + "/", "");
  /** Install steps for each placed systemd unit, printed with the summary. */
  const serviceInstalls: { target: string; lines: string[] }[] = [];
  /** Placed binaries that boot `aio.run()`, asked for their identity below. */
  const identityProbes: IdentityProbe[] = [];
  try {
    for (const t of targetList) {
      const target = t.name;
      const spec = TARGETS[t.kind]!;
      // A target's own app title/binary name, else the project's — the one
      // place a per-target name is turned into the name everything downstream
      // (argv, artifact detection, the manifest) uses.
      // `--name=` on the fleet's own command line overrides the title for this
      // run — the same override the single-target entry point has always
      // accepted, now that it is the same entry point. A per-target `name:` in
      // deno.json still wins, because it names ONE target and the flag names
      // the run.
      const targetTitle = t.appName ?? flag("name") ?? title;
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
          : crossCompileBlocker(t.kind, platform);
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
          ...((t.title ?? flag("display-name"))
            ? [`--display-name=${t.title ?? flag("display-name")}`]
            : []),
          `--platform=${platform}`,
          // Per-target entry: the single-target build resolves configEntry —
          // and therefore appDir and every app asset — from this.
          ...((t.entry ?? flag("entry"))
            ? [`--entry=${t.entry ?? flag("entry")}`]
            : []),
          ...((t.ui ?? flag("ui")) ? [`--ui=${t.ui ?? flag("ui")}`] : []),
          // `dev:android`'s whole point: the APK it builds must dial the dev
          // server instead of embedding its bundle. The flag reaches the fleet
          // (build.ts forwards it) and has to reach the BUILDER, or the dev
          // task produces a production APK and says nothing.
          ...(flag("android-dev-url")
            ? [`--android-dev-url=${flag("android-dev-url")}`]
            : []),
        ];
        if (release) args.push("--release");
        if (force) args.push("--force");
        if (allowServerOnly) args.push("--allow-server-only");
        if (analyze) args.push("--analyze");
        const { code } = await new Deno.Command("deno", {
          args,
          cwd: root,
          env: { [BUILD_VERSION_ENV]: JSON.stringify(version) },
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
          console.error(
            `${C.red}✗ ${label} failed (exit ${code})${C.r} ${C.dim}— the ` +
              `builder's own refusal is above this line; nothing from this ` +
              `target reaches ${outDir.replace(root + SEPARATOR, "")}/. ` +
              `Reproduce it alone: --targets=${target}${C.r}`,
          );
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
            bytes: await sizeOf(join(tdir, name)),
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
          console.error(
            `${C.red}✗ ${label} — ${why}${C.r}\n  ${C.dim}looked for: ` +
              `${targetBin}, ${targetBin}-client, ${targetBin}-<platform>, ` +
              `${targetBin}*.{AppImage,apk,zip,dmg,exe,service}, aio-client-*, ` +
              `the ${iosArtifactName(targetBin)}/ directory — new since the ` +
              `build began.\n  fix: the single-target build wrote elsewhere ` +
              `or under another name. A per-target "name" in build.targets ` +
              `must match what the builder printed above; an --out on the ` +
              `builder side is not supported under the fleet.${C.r}`,
          );
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
        await emptyDir(outDir);
        await moveDirContents(preservedOut, outDir);
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
    // Which targets the PREVIOUS release in this directory held. `dist/` is
    // one release, assembled clean — so a narrower build legitimately replaces
    // a wider one, but it must never do so silently: an artifact that was there
    // a minute ago and is gone now is exactly the surprise this build reported
    // as `✓ 1/1 build(s)`.
    const previousTargets = preserved
      ? await manifestTargetNames(join(preservedOut, "manifest.json"))
      : [];
    await emptyDir(outDir);
    await Deno.mkdir(outDir, { recursive: true });
    // Same rule the build itself used for `targetBin` — a per-target `name`,
    // else the project's title.
    const suffixed = suffixedTargets(
      block.targets,
      targetList,
      (t) => artifactGroup(t.kind, slugify(t.appName ?? title)),
    );
    const used = new Map<string, string>(); // placed name → the target that owns it
    const manifestTargets = [];
    for (const r of results) {
      const placed: ArtifactRec[] = [];
      const renamed = new Map<string, string>(); // staged name → placed name
      if (r.ok) {
        for (const a of r.artifacts) {
          // Flat layout, named by TARGET — deterministic, and identical whether
          // this target was built alone or alongside others (see placedName).
          // Cross-built artifacts already carry their platform (artifactName),
          // so the two axes never collide with each other.
          const name = placedName(a.file, r.target, suffixed, {
            version: version.version,
            binaryName: r.binary,
          });
          const owner = used.get(name);
          if (owner !== undefined) {
            // Two targets claiming one file name: the second move would delete
            // the first target's artifact and the summary would report both as
            // built. Refuse, and name the way out (per-target `name:`).
            throw new Error(
              `targets "${owner}" and "${r.target}" both produce ` +
                `${
                  outDir.replace(root + SEPARATOR, "")
                }/${name} — the second ` +
                `would overwrite the first. Give one of them its own name: ` +
                `"build": { "targets": { "${r.target}": { "name": "…" } } }.`,
            );
          }
          used.set(name, r.target);
          await moveFile(
            join(staging, `${r.target}__${r.platform}`, a.file),
            join(outDir, name),
          );
          placed.push({ file: name, bytes: a.bytes });
          renamed.set(a.file, name);
        }
        const kind = targetList.find((t) => t.name === r.target)?.kind;
        const bin = renamed.get(artifactName(r.binary, r.platform));
        if (
          bin && kind && IDENTITY_KINDS.has(kind) && isHostPlatform(r.platform)
        ) {
          identityProbes.push({
            target: r.target,
            binary: r.binary,
            path: join(outDir, bin),
          });
        }
        // The unit is named like its binary (a cross build carries the
        // platform), so it is looked up the same way.
        const unit = renamed.get(
          `${artifactName(r.binary, r.platform)}.service`,
        );
        if (unit) {
          serviceInstalls.push({
            target: r.target,
            lines: await placeServiceUnit(
              join(outDir, unit),
              r.binary,
              artifactName(r.binary, r.platform),
              renamed,
              rel(outDir),
            ),
          });
        }
        // …and its size is the size ON DISK, taken after every placement
        // rewrite: `placeServiceUnit` edits the unit's install comment, so a
        // byte count taken at staging recorded 1618 in manifest.json for a
        // 1639-byte file — the manifest a release pipeline checks against.
        for (const p of placed) p.bytes = await sizeOf(join(outDir, p.file));
        // The summary prints what is ON DISK. It used to print the staged name
        // (`✓ cli → notes`) while the file it had just written was `notes-cli`.
        r.artifacts = placed;
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
      /** THE app version every artifact below is named with and reports. */
      version: version.version,
      /** Short sha of the commit it was built from — null without a repo. */
      commit: version.commit,
      dirty: version.dirty,
      buildNumber: version.build,
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
    // …and say what this release no longer holds. `dist/` is assembled clean,
    // so building one target replaces a directory that held others — correct,
    // and silent until now: the artifacts were simply gone, with a green
    // summary above them.
    // Deduped: the manifest has one entry per target PER PLATFORM, so a
    // three-platform `server` read "no longer holds server, server, server"
    // and suggested `--targets=server,server,server,…`.
    const dropped = [...new Set(previousTargets)].filter((t) =>
      !results.some((r) => r.ok && r.target === t)
    );
    if (dropped.length > 0) {
      console.log(
        `\n  ${C.yellow}note:${C.r} ${
          outDir.replace(root + SEPARATOR, "")
        }/ is one release, rebuilt clean — it no longer holds ${C.blue}${
          dropped.join(", ")
        }${C.r} ${C.dim}(built into it earlier).${C.r}\n  ${C.dim}Build them ` +
          `together to keep both: ${C.r}${C.blue}--targets=${
            [
              ...new Set([
                ...dropped,
                ...results.filter((r) => r.ok).map((r) => r.target),
              ]),
            ].join(",")
          }${C.r}`,
      );
    }
  } finally {
    await Deno.remove(staging, { recursive: true }).catch(() => {});
  }

  // ── summary ───────────────────────────────────────────────────────────────
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${C.b}built${C.r}`);
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
  for (
    const line of sharedIdentityWarnings(await probeIdentities(identityProbes))
  ) {
    console.warn(`\n  ${C.yellow}⚠ ${line}${C.r}`);
  }
  for (const { target, lines } of serviceInstalls) {
    console.log(
      `\n  ${C.dim}install ${target} as a service:${C.r}\n${
        lines.map((l) => `    ${l}`).join("\n")
      }`,
    );
  }
  // What was CHECKED, not only what was produced (report 2 §3). The client-graph
  // audit and the module-scope evaluation run per target and refuse the
  // artifact outright, so an artifact on the list above is already proof they
  // passed — but that proof is only legible to someone who read the whole
  // build. A summary that lists files and never names the checks reads as "it
  // compiled", which is the reading the audit exists to correct.
  const audited =
    results.filter((r) => r.ok && !r.skipped && r.artifacts.length)
      .length;
  if (audited > 0) {
    console.log(
      `\n  ${C.dim}client graph:${C.r} audited + evaluated for ${
        audited === 1 ? "the artifact" : `all ${audited} artifacts`
      } ${C.dim}(a server-only leak, a module-scope Node global, or a top ` +
        `level that throws refuses the artifact — nothing above reached disk ` +
        `without passing)${C.r}`,
    );
  }
  const skipped = results.filter((r) => r.skipped).length;
  const built = results.length - failed.length - skipped;
  // `✓ 2/3 build(s)` asked the reader to do the subtraction and told them
  // nothing about which way it went. A tally names each outcome and drops the
  // ones that did not happen, so a clean fleet reads `3 built → dist/`.
  console.log(
    "\n  " + tally([
      [built, "built", "ok"],
      [skipped, "skipped", "warn"],
      [failed.length, "failed", "bad"],
    ]) + style.dim("  → ") + style.underline(rel(outDir) + "/"),
  );
  return failed.length ? 1 : 0;
}

if (import.meta.main) Deno.exit(await buildAll());
