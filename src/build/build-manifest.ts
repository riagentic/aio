// build-manifest.ts — `dist/manifest.json`, read by the people who need it.
//
// Since "one path, one name, one dist/", the fleet is the ONLY build path, and
// every artifact it produces lands in the out dir under a versioned, target-
// suffixed name and is recorded here. Nothing is left in the project root.
//
// Two callers had not been told. `dev:android` and `install:android --build`
// both spawned a build and then scanned `Deno.cwd()` for a `.apk` — a listing
// that was right when a direct `build.ts --android` wrote there, and has been
// empty ever since. The build succeeded; the caller reported "no .apk". The
// manifest is the contract, so a caller that wants an artifact reads it rather
// than guessing at a directory.

import { join, resolve } from "@std/path";
import { readDenoJson } from "../server/deno-json.ts";
import { DIST_DIR } from "../server/app-files.ts";
import { isShipManifestName } from "./build-shape.ts";

/** What a fleet build records about itself. */
export type BuildManifest = {
  app?: string;
  title?: string;
  /** THE version the fleet resolved — what every artifact is named with. */
  version?: string;
  commit?: string | null;
  dirty?: boolean;
  buildNumber?: number;
  builtAt?: string;
  release?: boolean;
  targets?: {
    target: string;
    role?: string;
    binary?: string;
    ok?: boolean;
    /** True when this artifact runs on the machine that built it. */
    host?: boolean;
    platform?: string;
    /** Android targets: the applicationId the APK was built with. */
    applicationId?: string;
    /** Android targets: built with `--android-dev-url` (a dev APK). */
    dev?: boolean;
    artifacts?: { file: string; bytes?: number }[];
  }[];
};

/** Where this project's build artifacts land: `build.out`, else `dist/`. The
 *  same resolution `build-all.ts` uses, so one project has one answer. */
export async function outDirOf(root: string): Promise<string> {
  const cfg = (await readDenoJson(root))?.config ?? {};
  const out = (cfg.build as { out?: string } | undefined)?.out;
  return resolve(root, out ?? DIST_DIR);
}

/** The manifest of the last build in `dir`, or null when there is none. */
export async function readBuildManifest(
  dir: string,
): Promise<BuildManifest | null> {
  try {
    const raw = await Deno.readTextFile(join(dir, "manifest.json"));
    const m = JSON.parse(raw) as BuildManifest;
    return m && typeof m === "object" ? m : null;
  } catch {
    // aio-ok: "no build here yet" is the caller's to phrase — it knows which
    // command the user ran and which one produces what they were looking for.
    return null;
  }
}

/** Absolute paths of the artifacts a successful build produced, newest build
 *  first within the manifest's own order. `suffix` filters by file extension
 *  (".apk"), `target` by the target name that produced it. */
export function artifactPaths(
  dir: string,
  m: BuildManifest | null,
  opts: { target?: string; suffix?: string } = {},
): string[] {
  const out: string[] = [];
  for (const t of m?.targets ?? []) {
    if (t.ok === false) continue;
    if (opts.target && t.target !== opts.target) continue;
    for (const a of t.artifacts ?? []) {
      if (opts.suffix && !a.file.endsWith(opts.suffix)) continue;
      out.push(join(dir, a.file));
    }
  }
  return out;
}

/** The one artifact a caller asked for, or a message naming what it found
 *  instead — never an empty listing the caller has to interpret. */
export async function soleArtifact(
  root: string,
  opts: { target?: string; suffix?: string; what: string },
): Promise<{ path: string } | { error: string }> {
  const dir = await outDirOf(root);
  const rel = dir.replace(root + "/", "");
  const m = await readBuildManifest(dir);
  if (!m) {
    return {
      error: `no ${rel}/manifest.json — this build produced no report. ` +
        `\`deno task build --targets=${opts.target ?? "<name>"}\` writes one.`,
    };
  }
  const hits = artifactPaths(dir, m, opts);
  if (hits.length === 0) {
    const had = (m.targets ?? []).map((t) => t.target).join(", ") || "nothing";
    return {
      error: `${rel}/manifest.json records no ${opts.what} — it holds: ${had}.`,
    };
  }
  return { path: hits[0]! };
}

// ── what the PREVIOUS release says about this one ──────────────────────────
//
// The out dir is rebuilt clean, so the last build's manifest is read before
// it goes — the only record of what is installed out there.

/** `major.minor.build` of a version string (`1.2.345-beta` → [1, 2, 345]). */
function versionTriple(v: unknown): [number, number, number] | null {
  const m = typeof v === "string" ? /^(\d+)\.(\d+)\.(\d+)/.exec(v) : null;
  return m ? [+m[1]!, +m[2]!, +m[3]!] : null;
}

/** The warning for a build whose version is LOWER than the previous build's
 *  (`prev`, the manifest it replaces), else null. The build number is the
 *  commit count, so a squash or a history rewrite lowers it — and Android
 *  refuses an APK whose versionCode is lower than the installed one (the only
 *  way past is an uninstall, which deletes the app's data), while the update
 *  check never offers it. Pure. */
export function versionRegressionNote(
  prev: BuildManifest | null,
  next: string,
  rel: string,
): string | null {
  const a = versionTriple(prev?.version);
  const b = versionTriple(next);
  if (!a || !b) return null;
  const i = b.findIndex((n, k) => n !== a[k]);
  if (i < 0 || b[i]! > a[i]!) return null;
  return `version ${next} is LOWER than the last build's ${prev!.version} ` +
    `(${rel}/manifest.json): Android refuses it as an update (lower ` +
    `versionCode — only an uninstall gets past, and that deletes the app's ` +
    `data), and the update check never offers it. The build number is the ` +
    `git commit count, so a squash or history rewrite lowers it.\n  fix: ` +
    `raise deno.json "version" (e.g. "${a[0]}.${a[1] + 1}"), or hand this ` +
    `build its version through AIO_BUILD_VERSION ` +
    `(docs/build/versioning.md).`;
}

/** Entries of the previous out dir (`entries`, its top-level names) that no
 *  build put there: not its `manifest.json`, not an artifact `prev` lists,
 *  not a file every build stages (`staged`), not a dotfile. The clean
 *  rebuild removes them — said, by name. Sorted. Pure. */
export function strayOutEntries(
  prev: BuildManifest | null,
  entries: readonly string[],
  staged: (name: string) => boolean,
): string[] {
  const listed = new Set(
    (prev?.targets ?? []).flatMap((t) =>
      (t.artifacts ?? []).map((a) => a.file)
    ),
  );
  return entries.filter((e) =>
    !e.startsWith(".") && e !== "manifest.json" && !listed.has(e) &&
    !staged(e) && !isShipOutputOf(listed, e)
  ).sort();
}

/** What `aio ship` / `am publish` wrote beside the artifacts `prev` lists —
 *  `<artifact>.ship.json` (ship's documented default place) and
 *  `<os>-<arch>.json` — among `entries`. A clean rebuild removes them with
 *  the release they describe; they are not "no build put there". Sorted.
 *  Pure. */
export function shipOutputEntries(
  prev: BuildManifest | null,
  entries: readonly string[],
): string[] {
  const listed = new Set(
    (prev?.targets ?? []).flatMap((t) =>
      (t.artifacts ?? []).map((a) => a.file)
    ),
  );
  return entries.filter((e) => isShipOutputOf(listed, e)).sort();
}

const isShipOutputOf = (artifacts: ReadonlySet<string>, e: string) =>
  isShipManifestName(e) ||
  (e.endsWith(".ship.json") && artifacts.has(e.slice(0, -".ship.json".length)));

/** The warnings for android targets whose applicationId differs from the one
 *  the previous build recorded for the same target. Only for a DERIVED id —
 *  the caller passes none when deno.json pins `android.applicationId`. A new
 *  id installs as a SECOND app beside the first, whose data stays behind.
 *  `prevId` derives the id of an older manifest that did not record one,
 *  from its APK's file name. Pure. */
export function applicationIdChangeNotes(
  prev: BuildManifest | null,
  next: readonly { target: string; applicationId?: string; dev?: boolean }[],
  prevId: (apkFile: string) => string | null,
  rel: string,
): string[] {
  const notes: string[] = [];
  for (const n of next) {
    if (!n.applicationId) continue;
    const p = (prev?.targets ?? []).find((t) =>
      t.target === n.target && t.ok !== false
    );
    const apk = p?.artifacts?.find((a) => a.file.endsWith(".apk"))?.file;
    // A dev APK (`--android-dev-url`) is its own app by design
    // (`app.aio.<x>dev`): never compared with a release one. An older
    // manifest did not record it; its file name says so.
    const prevDev = p?.dev ?? /-dev\.apk$/.test(apk ?? "");
    if (prevDev !== !!n.dev) continue;
    const was = p?.applicationId ?? (apk ? prevId(apk) : null);
    if (!was || was === n.applicationId) continue;
    notes.push(
      `${n.target}: the applicationId is now ${n.applicationId} — the last ` +
        `build (${rel}/manifest.json) was ${was}. Android installs it as a ` +
        `SECOND app; the installed one keeps its data. It is derived from ` +
        `the target's "name" (else the title).\n  fix: pin it in deno.json: ` +
        `"android": { "applicationId": "${was}" } (or pin the new one, if ` +
        `the change is meant).`,
    );
  }
  return notes;
}
