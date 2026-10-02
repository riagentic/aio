/**
 * @module
 * Build-tool audit for a finished binary — "why is this PE hundreds of MB, and
 * is the TypeScript compiler / esbuild / appimagetool still riding along?"
 *
 * `deno compile` embeds the module graph as text inside the PE. When a build
 * tool's npm package slips into that graph, the whole tool ships: `tsc` and
 * `tsc.exe` copies, `typescript.js`, `_tsc.js`, `tsserver`, plus
 * `esbuild@…/esbuild` and, historically, the cached `appimagetool`.
 * {@link DEV_ONLY_PACKAGES} in `build-compile.ts` is supposed to keep them out;
 * this module is the instrument that shows whether it actually did, on a REAL
 * artifact, rather than trusting the intent.
 *
 * ## What the VFS actually looks like, and why the first cut missed everything
 *
 * From a field report: the first cut matched full PATH fragments
 * (`/typescript/lib/tsc.js`) against `File` records. But the VFS is a nested
 * JSON TREE and a `File` record stores only a BASENAME — in shape (the real
 * text is compact JSON, an array of one-key records):
 *
 *     Dir node_modules
 *       Dir .deno
 *         Dir typescript@6.0.3
 *           Dir node_modules
 *             Dir typescript
 *               Dir lib
 *                 File tsc
 *
 * so `name.includes("/typescript/lib/tsc.js")` was always false and the audit
 * reported NONE while the binary carried ~165 MB of `tsc`/`esbuild`/
 * `appimagetool`. This reads the tree and matches the BASENAME, then walks up
 * to the enclosing `.deno` entry so a hit is attributed to a PACKAGE
 * (`@typescript/typescript-darwin-arm64`), which is what `build.keepPackages`
 * silences.
 *
 * ## Which bytes ARE the tree
 *
 * The words that start the tree also appear in ordinary text the binary
 * embeds — a test fixture, a doc example, this module's own source — and for
 * a while they appeared in THIS comment: aio consumed as a remote import is
 * embedded un-minified, ahead of the tree, so the audit found the comment
 * first, could not parse it, and reported "clean" for every such binary. So
 * no comment here spells the marker (it is built from pieces,
 * {@link VFS_START_PIECES}), and — the part that holds whatever the binary
 * embeds — a marker is only a CANDIDATE: deno writes the tree as a
 * length-prefixed section, so the real one is the candidate whose preceding 8
 * bytes (little-endian) are exactly its own byte length.
 *
 * ## "Could not read" is not "clean"
 *
 * No candidate passing that test — no tree, a truncated file, a layout this
 * module does not know — throws {@link ArtifactUnreadable}. It used to be the
 * same empty list a clean artifact returns: an instrument that could not see
 * said the same thing as one that saw nothing.
 */
import { basename } from "@std/path";
import { HEY } from "../diagnostics/fmt.ts";
import {
  hostPlatform,
  type NpmSystem,
  npmSystemOf,
  PLATFORMS,
  runsOn,
} from "./platforms.ts";

/** File basenames that only ever belong to a build tool. The VFS stores a
 *  basename, not a path (a field report), so these are exact. */
export const BUILD_TOOL_BASENAMES: readonly string[] = [
  "tsc",
  "tsc.js",
  "tsc.exe",
  "tsserver",
  "tsserver.js",
  "typescript.js",
  "_tsc.js",
  "esbuild",
  "esbuild.exe",
  "esbuild.wasm",
  "appimagetool",
];

/** Is `name` a build-tool file? Exact for the compiler/bundler; a PREFIX for
 *  `appimagetool`, whose cached file is `appimagetool-x86_64-1.9.1` (the
 *  legacy bare name is `appimagetool`). Pure. */
export function isBuildToolBasename(name: string): boolean {
  return BUILD_TOOL_BASENAMES.includes(name) ||
    name.startsWith("appimagetool-");
}

/** Below this, a matching file is not the tool: a package's own `bin` script
 *  (`typescript/bin/tsc` is 45 bytes — `#!/usr/bin/env node\n
 *  require('../lib/tsc.js')`) is embedded with a package the app keeps.
 *  Flagging those would warn where nothing is wrong — the noise that makes a
 *  gate useless. The real compiler/bundler/native binary is MBs. */
export const BUILD_TOOL_MIN_BYTES = 64 * 1024;

/** What `deno install` leaves in `node_modules` for ITSELF, as the audit
 *  names it: the `.bin` launchers, and the installer's cache and lock under
 *  `.deno`. A binary runs none of them — and `deno compile` writes the `.bin`
 *  links again mid-compile and follows each into its package, so through them
 *  every binary carried `electron/cli.js` and `esbuild/bin/esbuild` out of
 *  packages the build had excluded. The build excludes all three
 *  (`build-compile.ts`); a hit means that stopped working. */
export const INSTALL_BIN_DIR = "node_modules/.bin";
export const INSTALL_STATE_FILES: readonly string[] = [
  ".setup-cache.bin",
  ".deno.lock",
];

/** Which `build.keepPackages` key silences a hit. A hit is a package name when
 *  the tree attributed it (`@typescript/typescript-darwin-arm64`), a bare
 *  basename otherwise (`appimagetool`, under `node_modules/.cache`). Pure. */
export function needlePackage(hit: string): string {
  if (
    hit === "tsc" || hit === "tsc.js" || hit === "tsc.exe" ||
    hit === "tsserver" || hit === "tsserver.js" || hit === "typescript.js" ||
    hit === "_tsc.js"
  ) {
    return "typescript";
  }
  if (hit.includes("typescript")) return "typescript";
  if (hit.includes("esbuild")) return "esbuild";
  if (hit.includes("appimagetool")) return "appimagetool";
  return hit;
}

/** The start of the VFS JSON array, as pieces. Joined at runtime so the
 *  contiguous marker never appears in the embedded source (see the module
 *  comment). A root entry is a directory, a file or a symlink — the three
 *  shapes deno writes. */
const VFS_START_PIECES: readonly string[][] = [
  ["[", '{"Dir"', ":", '{"n":"'],
  ["[", '{"File"', ":", '{"n":"'],
  ["[", '{"Symlink"', ":", '{"n":"'],
];

const START_MARKERS: readonly Uint8Array[] = VFS_START_PIECES.map((p) =>
  new TextEncoder().encode(p.join(""))
);
/** Bytes of the length prefix deno writes before the tree. */
const LEN_BYTES = 8;
const OPEN = 0x5b; // [
const CLOSE = 0x5d; // ]

/** The audit could not read the artifact's file tree — which is NOT "the
 *  artifact is clean". */
export class ArtifactUnreadable extends Error {
  constructor(candidates: number) {
    super(
      candidates === 0
        ? "no embedded file tree was found (not a deno-compile binary?)"
        : `${candidates} candidate file tree(s) found, none complete — a ` +
          `truncated artifact, or a layout this audit does not know`,
    );
    this.name = "ArtifactUnreadable";
  }
}

/** Does a start marker begin at `i`? */
function markerAt(bytes: Uint8Array, i: number): boolean {
  return START_MARKERS.some((m) =>
    // aio-ok(utf16-bytes): both are Uint8Arrays — these lengths are bytes
    i + m.length <= bytes.length && m.every((b, j) => bytes[i + j] === b)
  );
}

/** The byte length a length prefix declares, or -1 when it cannot be one. */
function declaredLength(prefix: Uint8Array): number {
  if (prefix.length !== LEN_BYTES) return -1;
  const n = new DataView(prefix.buffer, prefix.byteOffset, LEN_BYTES)
    .getBigUint64(0, true);
  return n >= 2n && n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : -1;
}

/** The tree in `json`, or null when the bytes are not one. */
function parseTree(json: Uint8Array): unknown[] | null {
  if (json[json.length - 1] !== CLOSE) return null;
  try {
    const tree = JSON.parse(new TextDecoder().decode(json));
    return Array.isArray(tree) ? tree : null;
  } catch {
    return null; // aio-ok: a candidate that is not the tree — the caller tries the next, and throws when none is
  }
}

/** The package name of a `.deno` entry (`typescript@6.0.3` → `typescript`,
 *  `@typescript+typescript-darwin-arm64@7.0.2` →
 *  `@typescript/typescript-darwin-arm64`), or null when the name is not one.
 *  The version starts at the FIRST `@` past a scope's own: an entry with peers
 *  (`@scope+tool@1.0.0_typescript@6.0.3`) carries more of them. */
function denoEntryPackage(name: string): string | null {
  const at = name.indexOf("@", 1);
  return at < 0 ? null : name.slice(0, at).replace("+", "/");
}

/** The package a file path is inside: the name in the segment right after the
 *  inner-most `.deno`, or null when the path has none. */
function packageOfPath(segments: readonly string[]): string | null {
  for (let i = segments.length - 1; i >= 0; i--) {
    if (segments[i] === ".deno" && i + 1 < segments.length) {
      const pkg = denoEntryPackage(segments[i + 1]!);
      if (pkg) return pkg;
    }
  }
  return null;
}

/** The recorded byte length of a `File` record (`o:[offset,length]`), or null
 *  when the record carries none (then the file is treated as large: never let a
 *  parse shape we did not expect hide a real leak). */
function recordSize(rec: { o?: unknown }): number | null {
  return Array.isArray(rec.o) && typeof rec.o[1] === "number" ? rec.o[1] : null;
}

function walkVfs(
  nodes: unknown,
  segments: readonly string[],
  hits: Set<string>,
): void {
  if (!Array.isArray(nodes)) return;
  for (const node of nodes) {
    if (!node || typeof node !== "object") continue;
    const rec = node as {
      Dir?: { n?: unknown; e?: unknown };
      File?: { n?: unknown; o?: unknown };
    };
    if (rec.Dir) {
      const name = typeof rec.Dir.n === "string" ? rec.Dir.n : "";
      // The project's own `node_modules/.bin` — not one inside a package.
      if (
        name === ".bin" && segments.at(-1) === "node_modules" &&
        !segments.includes(".deno")
      ) {
        hits.add(INSTALL_BIN_DIR);
        continue;
      }
      walkVfs(rec.Dir.e, [...segments, name], hits);
    } else if (rec.File) {
      const name = typeof rec.File.n === "string" ? rec.File.n : "";
      if (
        INSTALL_STATE_FILES.includes(name) && segments.at(-1) === ".deno" &&
        segments.at(-2) === "node_modules"
      ) {
        hits.add(`node_modules/.deno/${name}`);
        continue;
      }
      if (!isBuildToolBasename(name)) continue;
      // A tool is an installed package (or aio's tool cache beside them). The
      // app's own `src/tsc.js` is the app's program, whatever it is called.
      if (!segments.includes("node_modules")) continue;
      const size = recordSize(rec.File);
      if (size !== null && size < BUILD_TOOL_MIN_BYTES) continue; // a shim, not the tool
      hits.add(packageOfPath(segments) ?? name);
    }
  }
}

function hitsOf(tree: unknown[]): string[] {
  const hits = new Set<string>();
  walkVfs(tree, [], hits);
  return [...hits].sort();
}

/** Which build tools the VFS in `bytes` embeds. Pure; the in-memory form of
 *  {@link scanArtifactForBuildTools}, for tests. Throws
 *  {@link ArtifactUnreadable} when `bytes` hold no readable tree. */
// aio-ok: a test-only seam — the in-memory form of scanArtifactForBuildTools.
export function buildToolHitsIn(bytes: Uint8Array): string[] {
  return hitsOf(treeIn(bytes).tree);
}

/** The file tree in `bytes`, and where the files' own bytes begin: deno writes
 *  them right after the tree, behind a length prefix of their own. */
function treeIn(bytes: Uint8Array): { tree: unknown[]; dataAt: number } {
  let candidates = 0;
  for (
    let i = bytes.indexOf(OPEN, LEN_BYTES);
    i >= 0;
    i = bytes.indexOf(OPEN, i + 1)
  ) {
    if (!markerAt(bytes, i)) continue;
    candidates++;
    const len = declaredLength(bytes.subarray(i - LEN_BYTES, i));
    if (len < 0 || i + len > bytes.length) continue;
    const tree = parseTree(bytes.subarray(i, i + len));
    if (tree) return { tree, dataAt: i + len + LEN_BYTES };
  }
  throw new ArtifactUnreadable(candidates);
}

/** Every `package.json` of an embedded npm package: the package's name and
 *  where the file's bytes are (`[offset, length]` into the file data). The
 *  one at `.deno/<entry>/node_modules/<name>/package.json` — a `package.json`
 *  deeper inside a package describes something else. */
function packageJsonRecords(
  nodes: unknown,
  segments: readonly string[] = [],
): Array<{ name: string; at: [number, number] | null }> {
  if (!Array.isArray(nodes)) return [];
  return nodes.flatMap((node) => {
    const rec = (node ?? {}) as {
      Dir?: { n?: unknown; e?: unknown };
      File?: { n?: unknown; o?: unknown };
    };
    if (rec.Dir) {
      return packageJsonRecords(rec.Dir.e, [...segments, String(rec.Dir.n)]);
    }
    if (rec.File?.n !== "package.json") return [];
    const i = segments.lastIndexOf(".deno");
    const name = i < 0 ? null : denoEntryPackage(segments[i + 1] ?? "");
    if (
      !name || segments[i + 2] !== "node_modules" ||
      segments.slice(i + 3).join("/") !== name
    ) return [];
    const o = rec.File.o;
    return [{
      name,
      at: Array.isArray(o) && typeof o[0] === "number" &&
          typeof o[1] === "number"
        ? [o[0], o[1]]
        : null,
    }];
  });
}

/** The packages in `records` that do not install on `sys`, each
 *  `package.json` read through `read`. One that cannot be read as JSON means
 *  this is not the layout the audit knows — unreadable, never "clean". */
async function foreignAmong(
  records: ReturnType<typeof packageJsonRecords>,
  sys: NpmSystem,
  read: (offset: number, length: number) => Promise<Uint8Array | null>,
): Promise<string[]> {
  const hits = new Set<string>();
  for (const { name, at } of records) {
    const bytes = at && await read(at[0], at[1]);
    let pkg: unknown;
    try {
      pkg = JSON.parse(new TextDecoder().decode(bytes ?? new Uint8Array()));
    } catch {
      throw new ArtifactUnreadable(1); // aio-ok: rethrown as the audit's own "cannot read" — see the doc comment
    }
    if (!runsOn((pkg ?? {}) as Record<string, unknown>, sys)) hits.add(name);
  }
  return [...hits].sort();
}

/** Which embedded npm packages are built for ANOTHER system than `sys`. The
 *  in-memory form of {@link scanArtifactForForeignPackages}, for tests. */
// aio-ok: a test-only seam — the in-memory form of scanArtifactForForeignPackages.
export function foreignPackagesIn(
  bytes: Uint8Array,
  sys: NpmSystem,
): Promise<string[]> {
  const { tree, dataAt } = treeIn(bytes);
  return foreignAmong(
    packageJsonRecords(tree),
    sys,
    (o, n) => Promise.resolve(bytes.subarray(dataAt + o, dataAt + o + n)),
  );
}

/** Read exactly `into.length` bytes at `offset`; false at a short read. */
async function readAt(
  file: Deno.FsFile,
  offset: number,
  into: Uint8Array,
): Promise<boolean> {
  await file.seek(offset, Deno.SeekMode.Start);
  for (let got = 0; got < into.length;) {
    const n = await file.read(into.subarray(got));
    if (n === null) return false;
    got += n;
  }
  return true;
}

/** Which build tools an artifact on disk embeds, read from its VFS tree.
 *  Streams, one pass: markers are found chunk by chunk, and only a candidate
 *  whose length prefix fits the file is ever read — never the whole ~550 MB
 *  PE at once. Throws {@link ArtifactUnreadable} when no tree can be read. */
export async function scanArtifactForBuildTools(
  path: string,
  chunkSize = 8 * 1024 * 1024,
): Promise<string[]> {
  return hitsOf((await treeOfFile(path, chunkSize)).tree);
}

/** Which npm packages an artifact on disk embeds that are built for another
 *  system than `sys` — a Windows exe carrying a Linux `.node`, a glibc binary
 *  carrying the musl build. Decided by each embedded package's own
 *  `package.json`, read out of the artifact ({@link runsOn} — the rule the
 *  build excludes by). Throws {@link ArtifactUnreadable} like the tool scan. */
export async function scanArtifactForForeignPackages(
  path: string,
  sys: NpmSystem,
  chunkSize = 8 * 1024 * 1024,
): Promise<string[]> {
  const { tree, dataAt } = await treeOfFile(path, chunkSize);
  const file = await Deno.open(path, { read: true });
  try {
    return await foreignAmong(
      packageJsonRecords(tree),
      sys,
      async (o, n) => {
        const into = new Uint8Array(n);
        return await readAt(file, dataAt + o, into) ? into : null;
      },
    );
  } finally {
    file.close();
  }
}

/** Every file path an artifact on disk embeds, sorted — what two builds of
 *  the same sources are compared by. An EMPTY directory is listed too, with a
 *  trailing `/`: it is embedded, and a list of files alone cannot show it. */
// aio-ok: a test-only seam — the artifact E2E compares two builds' lists.
export async function embeddedFilesOf(path: string): Promise<string[]> {
  const out: string[] = [];
  const walk = (nodes: unknown, at: string) => {
    for (const node of Array.isArray(nodes) ? nodes : []) {
      const rec = (node ?? {}) as Record<string, { n?: unknown; e?: unknown }>;
      const [kind, v] = Object.entries(rec)[0] ?? [];
      if (!v) continue;
      if (kind !== "Dir") out.push(`${at}${v.n}`);
      else if (Array.isArray(v.e) && v.e.length) walk(v.e, `${at}${v.n}/`);
      else out.push(`${at}${v.n}/`);
    }
  };
  walk((await treeOfFile(path, 8 * 1024 * 1024)).tree, "");
  return out.sort();
}

/** The file tree of an artifact on disk and where its file data begins. */
async function treeOfFile(
  path: string,
  chunkSize: number,
): Promise<{ tree: unknown[]; dataAt: number }> {
  const overlap = Math.max(...START_MARKERS.map((m) => m.length)) - 1;
  const size = (await Deno.stat(path)).size;
  const scan = await Deno.open(path, { read: true });
  const probe = await Deno.open(path, { read: true });
  try {
    const prefix = new Uint8Array(LEN_BYTES);
    const buf = new Uint8Array(chunkSize);
    let window = new Uint8Array(0);
    let base = 0; // the file offset of window[0]
    let next = LEN_BYTES; // the file offset the search resumes at
    let candidates = 0;
    while (true) {
      const n = await scan.read(buf);
      if (n === null) break;
      // The last `overlap` bytes are kept: a marker may straddle the seam, so
      // a `[` there is decided with the next chunk (or now, at end of file).
      const keep = window.subarray(Math.max(0, window.length - overlap));
      base += window.length - keep.length;
      const grown = new Uint8Array(keep.length + n);
      grown.set(keep, 0);
      grown.set(buf.subarray(0, n), keep.length);
      window = grown;
      const limit = base + window.length >= size
        ? window.length
        : window.length - overlap;
      for (
        let i = window.indexOf(OPEN, Math.max(0, next - base));
        i >= 0 && i < limit;
        i = window.indexOf(OPEN, i + 1)
      ) {
        if (!markerAt(window, i)) continue;
        candidates++;
        const at = base + i;
        if (!(await readAt(probe, at - LEN_BYTES, prefix))) continue;
        const len = declaredLength(prefix);
        if (len < 0 || at + len > size) continue;
        const json = new Uint8Array(len);
        if (!(await readAt(probe, at, json))) continue;
        const tree = parseTree(json);
        if (tree) return { tree, dataAt: at + len + LEN_BYTES };
      }
      next = Math.max(next, base + limit);
    }
    throw new ArtifactUnreadable(candidates);
  } finally {
    scan.close();
    probe.close();
  }
}

/** Where `deno compile --output <out>` put the binary: `<out>` itself, or
 *  `<out>.exe` — deno appends the suffix for a Windows target when the name
 *  lacks it (an Electron staging build names it bare). */
async function compiledPath(out: string): Promise<string> {
  if (/\.exe$/i.test(out)) return out;
  const there = (p: string) => Deno.stat(p).then(() => true, () => false);
  return !(await there(out)) && await there(`${out}.exe`) ? `${out}.exe` : out;
}

/** Warn when a compiled artifact still carries a build tool's files. Dead
 *  weight in the binary, and the fix is usually already applied
 *  (`DEV_ONLY_PACKAGES` in `build-compile.ts`) — so a hit means the exclusion
 *  silently stopped working, which is exactly the failure a release gate must
 *  not have to guess at. An app that named the package (or its family:
 *  `esbuild` covers `@esbuild/linux-x64`) in `build.keepPackages` asked for
 *  it, and is not warned.
 *
 *  Advisory — it never fails a build. But an audit that could not read the
 *  artifact SAYS so: silence here used to mean both "clean" and "blind". */
export async function warnBuildToolsIn(
  bin: string,
  keepPackages: readonly string[],
  /** The platform the binary is for (a `PLATFORMS` name; default: the host):
   *  a native package of another system in it is named too. */
  platform: string = hostPlatform(),
): Promise<void> {
  let hits: string[];
  let foreign: string[];
  try {
    const path = await compiledPath(bin);
    hits = await scanArtifactForBuildTools(path);
    foreign = await scanArtifactForForeignPackages(
      path,
      npmSystemOf(PLATFORMS[platform] ?? PLATFORMS[hostPlatform()]!),
    );
  } catch (e) {
    console.warn(
      `${HEY} the build-tool audit could not read ${basename(bin)}: ${
        e instanceof Error ? e.message : e
      }. The artifact itself is untouched — but nothing checked whether it ` +
        `still carries a build tool (typescript, esbuild, appimagetool).`,
    );
    return;
  }
  // Only the package's exact name asks for another system's build — keeping
  // `esbuild` asks for the one that runs.
  const others = foreign.filter((p) => !keepPackages.includes(p));
  if (others.length) {
    console.warn(
      `${HEY} ${basename(bin)} embeds packages built for another system ` +
        `than ${platform} (${others.join(", ")}) — they cannot run in it and ` +
        `only make it larger. This is a packaging bug.`,
    );
  }
  const leaks = hits.filter((h) =>
    !foreign.includes(h) && !keepPackages.includes(h) &&
    !keepPackages.includes(needlePackage(h))
  );
  if (!leaks.length) return;
  console.warn(
    `${HEY} ${basename(bin)} still embeds build-tool files (${
      leaks.join(", ")
    }) — the binary is larger than it needs to be. If the app does not load ` +
      `the tool at runtime, this is a packaging bug; if it does, name the ` +
      `package in deno.json "build": { "keepPackages": ["…"] }.`,
  );
}
