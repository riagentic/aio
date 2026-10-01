/**
 * @module
 * Build-tool audit for a finished binary — "why is this PE hundreds of MB, and
 * is the TypeScript compiler / esbuild / appimagetool still riding along?"
 *
 * `deno compile` embeds the module graph as text inside the PE. When a build
 * tool's npm package slips into that graph, the whole tool ships: `tsc` and
 * `tsc.exe` copies, `typescript.js`, hundreds of `lib.*.d.ts` (~152 MB on a
 * real desktop host), plus `esbuild@…/esbuild.exe` and, historically, the
 * cached `appimagetool`. {@link DEV_ONLY_PACKAGES} in `build-compile.ts` is
 * supposed to keep them out; this module is the instrument that shows whether
 * it actually did, on a REAL artifact, rather than trusting the intent.
 *
 * ## Why it reads the VFS FILE TABLE, not raw bytes
 *
 * A first cut searched the whole file for path strings. It lit up on every
 * binary for two reasons that have nothing to do with a leak:
 *
 *   1. this module's OWN source — that list of needles — is itself one of the
 *      build modules `deno compile` embeds (aio's server graph reaches
 *      `build.ts`), so the binary contained the very words being searched for;
 *   2. `deno compile` also embeds `node_modules` link bookkeeping, whose
 *      entries name `.deno/typescript@…` even when the package was excluded.
 *
 * The VFS records (`{"File":{"n":"…"`) are the files that were actually
 * embedded. Matching needles against those NAMES is exact: the module's own
 * text is content, not a name, and link bookkeeping is not a `File` record.
 * See `feedback/optimal-builds.md` Task2 Steps A/B/D.
 */

/** How a `File` VFS record starts (see the measurement playbook). */
const VFS_RECORD_PREFIX = '{"File":{"n":"';

/** Path fragments that only ever name an embedded build-tool FILE. Deliberately
 *  specific: `typescript` is a directory in the journal too, but
 *  `typescript/lib/tsc.js` is a file that only exists if the compiler shipped. */
export const BUILD_TOOL_NEEDLES: readonly string[] = [
  "/typescript/lib/tsc.js",
  "/typescript/lib/tsc.mjs",
  "/typescript/lib/typescript.js",
  "/typescript/lib/tsserver.js",
  "/esbuild/bin/esbuild",
  "/@esbuild/win32-x64/esbuild.exe",
  "/appimagetool-x86_64-",
  "/appimagetool-aarch64-",
];

/** Which needles `name` contains. Pure. */
export function nameHasBuildTool(name: string): string[] {
  return BUILD_TOOL_NEEDLES.filter((n) => name.includes(n));
}

/** Every embedded file name in a VFS chunk window. Pure. A name that reaches
 *  the end of the window without a closing quote is skipped — the caller
 *  overlaps the windows, so the complete record is read again next time. */
export function vfsFileNamesIn(window: Uint8Array): string[] {
  const out: string[] = [];
  const text = new TextDecoder("utf-8", { fatal: false }).decode(window);
  let at = 0;
  while (true) {
    const i = text.indexOf(VFS_RECORD_PREFIX, at);
    if (i < 0) break;
    const start = i + VFS_RECORD_PREFIX.length;
    const end = text.indexOf('"', start);
    if (end < 0) break; // name runs past this window — the next one re-reads it
    out.push(text.slice(start, end));
    at = end + 1;
  }
  return out;
}

/** The npm/tool package a needle belongs to — so `build.keepPackages`
 *  (`"typescript"`) silences only its own needles. Pure. */
export function needlePackage(needle: string): string {
  if (needle.includes("typescript")) return "typescript";
  if (needle.includes("esbuild")) return "esbuild";
  if (needle.includes("appimagetool")) return "appimagetool";
  return needle;
}

/** Which build-tool needles the embedded file NAMES in `bytes` contain. Pure;
 *  the in-memory form of {@link scanArtifactForBuildTools}, for tests. */
export function buildToolHitsIn(bytes: Uint8Array): string[] {
  const found = new Set<string>();
  for (const name of vfsFileNamesIn(bytes)) {
    for (const n of nameHasBuildTool(name)) found.add(n);
  }
  return [...found];
}

/** Which build-tool needles an artifact on disk contains, read from its VFS
 *  file table. Streams in chunks with an overlap big enough that a record split
 *  across the seam is still read whole. */
export async function scanArtifactForBuildTools(
  path: string,
  chunkSize = 8 * 1024 * 1024,
): Promise<string[]> {
  const overlap = VFS_RECORD_PREFIX.length +
    Math.max(...BUILD_TOOL_NEEDLES.map((n) => n.length)) - 1;
  const found = new Set<string>();
  const file = await Deno.open(path, { read: true });
  try {
    let carry = new Uint8Array(0);
    const buf = new Uint8Array(chunkSize);
    while (true) {
      const n = await file.read(buf);
      if (n === null) break;
      const window = new Uint8Array(carry.length + n);
      window.set(carry, 0);
      window.set(buf.subarray(0, n), carry.length);
      for (const hit of buildToolHitsIn(window)) found.add(hit);
      if (found.size === BUILD_TOOL_NEEDLES.length) break;
      carry = window.slice(Math.max(0, window.length - overlap));
    }
  } finally {
    file.close();
  }
  return BUILD_TOOL_NEEDLES.filter((n) => found.has(n));
}
