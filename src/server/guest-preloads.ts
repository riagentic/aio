// guest-preloads.ts — deno.json `build.guestPreloads`: the `<webview>` guest
// preload files an app ships.
//
// From a field report: a guest preload worked in `deno task dev` and was
// dropped in every packaged build, because the window only accepts a preload
// inside its base directory, a package's base directory is its `dist/`, and
// `dist/` is an allowlist the app cannot add to. So the app DECLARES the
// files; the build stages them into the package; the page names one with
// `guestPreload()`; and the window resolves that name in the directory this
// run keeps them in. ONE declaration, read by the build and by the dev
// server, so the two cannot disagree about what is declared.
import { dirname, join } from "@std/path";
import { guestPreloadRefusal } from "../protocol/guest-preload.ts";
import { readDenoJson } from "./deno-json.ts";

/** Where a build stages the declared files, inside the package's `dist/`. */
export const GUEST_PRELOADS_DIR = "guest-preloads";

/** The staged directory's own record of what was DECLARED — so a package
 *  that lost a file after staging can say "declared, and missing here"
 *  where the directory listing alone could only say "not declared". */
export const GUEST_PRELOADS_DECLARED = ".declared.json";

/** What the window's `will-attach-webview` hook resolves a `guestPreload()`
 *  name against: the directory, and the declared paths inside it. */
export type GuestPreloads = { dir: string; files: string[] };

/** The files deno.json `build.guestPreloads` declares — `[]` when absent.
 *  Throws naming the entry when the value is not a list of valid paths
 *  (`guestPreloadRefusal`). Pure. */
export function declaredGuestPreloads(
  config: { build?: unknown } | undefined,
): string[] {
  const v = (config?.build as { guestPreloads?: unknown } | undefined)
    ?.guestPreloads;
  if (v === undefined) return [];
  const eg = `e.g. "build": { "guestPreloads": ["src/guest/preload.cjs"] }`;
  if (!Array.isArray(v)) {
    throw new Error(
      `deno.json build.guestPreloads is ${JSON.stringify(v)} — it must be ` +
        `a list of <webview> guest preload files, relative to the ` +
        `deno.json (${eg}).`,
    );
  }
  for (const p of v) {
    const why = guestPreloadRefusal(p);
    if (why) {
      throw new Error(
        `deno.json build.guestPreloads: ${JSON.stringify(p)} — ${why} (${eg}).`,
      );
    }
  }
  return [...new Set(v as string[])];
}

/** Every file under `dir`, as `/`-separated paths relative to it. */
async function filesUnder(dir: string, rel = ""): Promise<string[]> {
  const out: string[] = [];
  for await (const e of Deno.readDir(join(dir, rel))) {
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory) out.push(...await filesUnder(dir, p));
    else if (p !== GUEST_PRELOADS_DECLARED) out.push(p);
  }
  return out.sort();
}

/** Where a PACKAGE keeps its staged guest preloads, most specific first.
 *  Linux and Windows: inside the real `dist/` beside the binary. macOS: in
 *  the bundle's `Contents/Resources/` — a `.app` carries no `dist/` on disk
 *  (`Contents/MacOS/` is code-only under `codesign`; see build/macos-app.ts).
 *  Pure. */
export function stagedGuestPreloadDirs(
  o: { distDir?: string; execDir: string; os: string },
): string[] {
  return [
    ...(o.distDir ? [join(o.distDir, GUEST_PRELOADS_DIR)] : []),
    ...(o.os === "darwin"
      ? [join(dirname(o.execDir), "Resources", GUEST_PRELOADS_DIR)]
      : []),
  ];
}

/** What the build recorded as declared in a staged directory, or null when
 *  there is no usable record (a package built before the record existed, or
 *  one that is not a list of valid paths): the listing then decides, as it
 *  always did. */
async function stagedDeclaration(dir: string): Promise<string[] | null> {
  let text: string;
  try {
    text = await Deno.readTextFile(join(dir, GUEST_PRELOADS_DECLARED));
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return null;
    throw e;
  }
  try {
    const v: unknown = JSON.parse(text);
    if (Array.isArray(v) && v.every((p) => guestPreloadRefusal(p) === null)) {
      return [...new Set(v as string[])].sort();
    }
  } catch {
    // aio-ok: not JSON — no usable record, the listing decides (below)
  }
  return null;
}

/** The guest preloads of THIS run.
 *
 *  A package: what the build recorded as declared in the first of `staged`
 *  that exists (`.declared.json`; without one, the files that are there) —
 *  and NONE when no staged directory exists, because nothing was declared at
 *  build time. `packaged` says so (the caller's `isCompiled()`): a package
 *  never reads a deno.json, which could only be one ABOVE its install
 *  directory — somebody else's project, whose declaration it then took and
 *  refused file by file on every start.
 *
 *  Anything else (dev, or a run from source): the declaration in the
 *  deno.json at or above `baseDir`, resolved in that deno.json's directory.
 *  A missing file is not decided here: the build refuses it, and the window
 *  refuses it by name when a guest asks. */
export async function resolveGuestPreloads(
  o: { baseDir: string; staged?: readonly string[]; packaged?: boolean },
): Promise<GuestPreloads> {
  for (const dir of o.staged ?? []) {
    try {
      const present = await filesUnder(dir);
      return { dir, files: await stagedDeclaration(dir) ?? present };
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
    }
  }
  if (o.packaged) return { dir: o.baseDir, files: [] };
  let at = o.baseDir;
  for (;;) {
    const found = await readDenoJson(at);
    if (found) return { dir: at, files: declaredGuestPreloads(found.config) };
    const up = dirname(at);
    if (up === at) return { dir: o.baseDir, files: [] };
    at = up;
  }
}
