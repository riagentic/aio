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
