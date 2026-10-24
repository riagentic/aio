// updates-tree.ts — update an unpacked (.zip) install file by file.
//
// A `.zip` install no longer has the archive its manifest hashes, and the
// archive cannot be re-made from the files (deflate is not reproducible), so
// the single-file patch (updates-patch.ts) cannot start from it. Keeping the
// archive as a base was the other way: one more archive of disk per install,
// for a poor patch — measured on an Electron app with one line of its UI
// changed, a zstd patch of the WHOLE zip was 33.3 MB of 174.8 MB (the deflated
// server binary differs from its first changed byte on), while the two files
// that changed, patched one by one, were 27 KB.
//
// A tree patch is the new release's file list — path, size, SHA-256, exec bit
// — and, per file, how to make it from what is installed: the same file, a
// zstd frame against the installed file at that path, or a frame of its own.
// The patch file's SHA-256 is in the manifest's signed patch list, so the list
// it carries is as trusted as the release's digest. Every file made is checked
// against it before anything is swapped; ANY miss is said in one line by the
// caller, which downloads the whole release instead.

import { createHash } from "node:crypto";
import { dirname, join } from "@std/path";
import { downloadArtifact, fileSha256, MB } from "./updates-check.ts";
import { forget } from "./updates-owned.ts";
import { _patchDeps, applyPatch, memoryShort } from "./updates-patch.ts";
import { zstdBlocks } from "./updates-zstd.ts";
import {
  type ReleasePatch,
  type ShipManifest,
  usablePatches,
} from "../build/ship.ts";

const MAGIC = "aio-tree-patch 1\n";

/** One file of the new release, and how it is made. `len`: the bytes of its
 *  zstd frame (`patch`, `new`). */
export type TreeFile = {
  path: string;
  size: number;
  sha256: string;
  exec?: boolean;
  op: "same" | "patch" | "new";
  len?: number;
};

export type TreeHeader = { files: TreeFile[]; dirs: string[] };

/** The patch file: the magic line, the header as one JSON line, then each
 *  `patch`/`new` file's frame in list order. Pure. */
export function encodeTreePatch(
  header: TreeHeader,
  frames: Uint8Array[],
): Uint8Array {
  const head = new TextEncoder().encode(MAGIC + JSON.stringify(header) + "\n");
  const out = new Uint8Array(
    frames.reduce((n, f) => n + f.length, head.length),
  );
  out.set(head);
  let at = head.length;
  for (const f of frames) {
    out.set(f, at);
    at += f.length;
  }
  return out;
}

export function isTreePatch(bytes: Uint8Array): boolean {
  const m = new TextEncoder().encode(MAGIC);
  // aio-ok(utf16-bytes): both are Uint8Arrays — .length is bytes
  return bytes.length >= m.length && m.every((b, i) => bytes[i] === b);
}

/** Why `p` cannot name a file inside the install, or null: relative, `/`
 *  separated, no `.`/`..`/empty segment, no `\` or `:` (a Windows drive or
 *  stream). Pure. */
function badPath(p: unknown): string | null {
  if (typeof p !== "string" || p.length === 0) return "an empty path";
  if (/[\\:\0]/.test(p) || p.startsWith("/")) return `the path "${p}"`;
  // aio-ok: path-split — a patch-manifest path, `/`-separated on every OS
  if (p.split("/").some((s) => s === "" || s === "." || s === "..")) {
    return `the path "${p}"`;
  }
  return null;
}

/** The header and each file's frame, or a throw naming what is wrong. Paths
 *  are checked, case-blind duplicates refused (one file on Windows). Pure. */
export function decodeTreePatch(
  bytes: Uint8Array,
): { header: TreeHeader; frames: Map<string, Uint8Array> } {
  if (!isTreePatch(bytes)) throw new Error("it is not a tree patch");
  const start = new TextEncoder().encode(MAGIC).length;
  const nl = bytes.indexOf(10, start);
  if (nl < 0) throw new Error("the tree patch has no header");
  const header = JSON.parse(
    new TextDecoder().decode(bytes.subarray(start, nl)),
  ) as TreeHeader;
  if (!Array.isArray(header?.files) || !Array.isArray(header?.dirs)) {
    throw new Error("the tree patch's header is malformed");
  }
  const seen = new Set<string>();
  const frames = new Map<string, Uint8Array>();
  let at = nl + 1;
  for (const p of [...header.dirs, ...header.files.map((f) => f.path)]) {
    const why = badPath(p);
    if (why) throw new Error(`the tree patch names ${why}`);
    if (seen.has(p.toLowerCase())) {
      throw new Error(`the tree patch names "${p}" twice`);
    }
    seen.add(p.toLowerCase());
  }
  for (const f of header.files) {
    if (
      !Number.isInteger(f.size) || f.size < 0 ||
      !/^[0-9a-f]{64}$/.test(String(f.sha256)) ||
      !["same", "patch", "new"].includes(f.op)
    ) {
      throw new Error(`the tree patch's entry for "${f.path}" is malformed`);
    }
    if (f.op === "same") continue;
    if (!Number.isInteger(f.len) || f.len! <= 0 || at + f.len! > bytes.length) {
      throw new Error(`the tree patch's frame for "${f.path}" is cut short`);
    }
    frames.set(f.path, bytes.subarray(at, at + f.len!));
    at += f.len!;
  }
  if (at !== bytes.length) throw new Error("bytes follow the tree patch");
  return { header, frames };
}

const hexOf = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** The `size` bytes one ordinary (history-free) zstd frame makes. */
async function unframe(frame: Uint8Array, size: number): Promise<Uint8Array> {
  const out = new Uint8Array(size);
  const blocks = zstdBlocks(frame, out, 0);
  for (let n = 1;; n++) {
    const step = blocks.next();
    if (step.done) {
      if (step.value !== size) {
        throw new Error(`a frame made ${step.value} bytes, not ${size}`);
      }
      return out;
    }
    if (n % 64 === 0) await new Promise((r) => setTimeout(r, 0));
  }
}

/** Fill the empty folder `staged` with the release `patch` describes, made
 *  from the install at `installed`. Throws on the first file that is not
 *  exactly what the patch says (size and SHA-256), on a base file that is
 *  missing, and when memory is short for a file's patch. */
export async function applyTreePatch(
  installed: string,
  patch: Uint8Array,
  staged: string,
): Promise<void> {
  const { header, frames } = decodeTreePatch(patch);
  // aio-ok: path-split — manifest paths are `/`-separated; join() makes the OS path
  const at = (root: string, p: string) => join(root, ...p.split("/"));
  for (const d of header.dirs) {
    await Deno.mkdir(at(staged, d), { recursive: true });
  }
  for (const f of header.files) {
    const out = at(staged, f.path);
    const base = at(installed, f.path);
    await Deno.mkdir(dirname(out), { recursive: true });
    let sha: string;
    if (f.op === "same") {
      await Deno.copyFile(base, out);
      sha = await fileSha256(out);
    } else {
      const frame = frames.get(f.path)!;
      const baseSize = f.op === "patch" ? (await Deno.stat(base)).size : 0;
      const free = _patchDeps.availableMemory();
      const short = free === null
        ? null
        : memoryShort(baseSize + f.size + frame.length, free);
      if (short) throw new Error(`${f.path}: ${short}`);
      const bytes = f.op === "patch"
        ? await applyPatch(base, frame, f.size)
        : await unframe(frame, f.size);
      sha = hexOf(bytes);
      await Deno.writeFile(out, bytes);
    }
    if (sha !== f.sha256) {
      throw new Error(
        `${f.path} made from the patch is not the release's (sha256 ` +
          `${sha.slice(0, 12)}…, expected ${f.sha256.slice(0, 12)}…)`,
      );
    }
    if (Deno.build.os !== "windows") {
      await Deno.chmod(out, f.exec ? 0o755 : 0o644);
    }
  }
}

/** The patch that starts from the install, or why none is used: the one whose
 *  `from` is the digest on record; with no digest on record (an install
 *  unpacked by hand), the one patch the release carries — what it makes is
 *  checked file by file either way. Over half the release: not worth it.
 *  Pure. */
export function pickTreePatch(
  patches: ReleasePatch[],
  installed: string | undefined,
  fullSize: number,
): { patch: ReleasePatch } | { why: string } {
  const patch = installed
    ? patches.find((p) => p.from.toLowerCase() === installed.toLowerCase())
    : patches.length === 1
    ? patches[0]
    : undefined;
  if (!patch) {
    return {
      why: installed
        ? `none of its ${patches.length} starts from the build installed ` +
          `here (${installed.slice(0, 12)}…)`
        : `the installed build's digest is not on record, and the release ` +
          `carries ${patches.length} patches to choose from`,
    };
  }
  if (patch.size * 2 > fullSize) {
    return {
      why: `the patch is ${MB(patch.size)}, over half of the whole ` +
        `release (${MB(fullSize)})`,
    };
  }
  return { patch };
}

/** Fill `staged` (made empty and on record by the caller) with release
 *  `manifest` (whose claims already verified), from the folder installed at
 *  `installed` and a downloaded tree patch.
 *
 *  `null`: the release carries no patches. `why`: it does, and none could be
 *  used — said once by the caller, which empties `staged` and downloads the
 *  whole release. Never throws. */
export async function treeFromPatch(opts: {
  manifest: ShipManifest;
  /** The manifest's own URL — a patch's `url` is relative to it. */
  manifestUrl: string;
  installed: string;
  /** The digest of the release installed here, when on record. */
  installedSha256: string | undefined;
  staged: string;
  dataDir: string;
}): Promise<{ patch: ReleasePatch } | { why: string } | null> {
  const m = opts.manifest;
  if (m.patches === undefined) return null;
  try {
    const usable = await usablePatches(m);
    if (usable.reason) return { why: usable.reason };
    const pick = pickTreePatch(usable.patches, opts.installedSha256, m.size);
    if ("why" in pick) return pick;
    const got = await downloadArtifact({
      url: new URL(pick.patch.url, opts.manifestUrl).href,
      dest: `${opts.installed}.patch-${m.version}`,
      expectSha256: pick.patch.sha256,
      expectSize: pick.patch.size,
      owner: opts.dataDir,
      keepStaged: true,
    });
    if (!got.ok) return { why: got.error };
    const stage = dirname(got.path);
    try {
      await applyTreePatch(
        opts.installed,
        await Deno.readFile(got.path),
        opts.staged,
      );
      return { patch: pick.patch };
    } finally {
      await Deno.remove(stage, { recursive: true });
      forget(opts.dataDir, stage);
    }
  } catch (e) {
    return { why: e instanceof Error ? e.message : String(e) };
  }
}

/** The tree patch that makes the unpacked release `newDir` from the unpacked
 *  release `oldDir`, written to `out`: each changed file a zstd
 *  `--patch-from` frame against its old self, each added one a frame of its
 *  own (`zstd` — run by the caller's `zstd(args)`). Throws on a symlink: a
 *  link cannot be checked by its digest. */
export async function makeTreePatch(
  oldDir: string,
  newDir: string,
  out: string,
  zstd: (args: string[]) => Promise<void>,
): Promise<void> {
  const files: TreeFile[] = [];
  const dirs: string[] = [];
  const frames: Uint8Array[] = [];
  const tmp = `${out}.frame`;
  const walk = async (rel: string[]) => {
    const entries = [...Deno.readDirSync(join(newDir, ...rel))]
      .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    if (entries.length === 0 && rel.length > 0) dirs.push(rel.join("/"));
    for (const e of entries) {
      const parts = [...rel, e.name];
      const path = parts.join("/");
      const now = join(newDir, ...parts);
      if (e.isSymlink) throw new Error(`${path} is a symlink`);
      if (e.isDirectory) {
        await walk(parts);
        continue;
      }
      const st = await Deno.stat(now);
      const sha256 = await fileSha256(now);
      const was = join(oldDir, ...parts);
      const old = await Deno.lstat(was).catch(() => null);
      const exec = st.mode !== null && (st.mode & 0o111) !== 0;
      const entry: TreeFile = {
        path,
        size: st.size,
        sha256,
        ...(exec ? { exec } : {}),
        op: "same",
      };
      if (!old?.isFile || await fileSha256(was) !== sha256) {
        entry.op = old?.isFile ? "patch" : "new";
        await zstd([
          "-19",
          ...(entry.op === "patch" ? [`--patch-from=${was}`] : []),
          now,
          "-o",
          tmp,
          "-f",
          "-q",
        ]);
        const frame = await Deno.readFile(tmp);
        entry.len = frame.length;
        frames.push(frame);
      }
      files.push(entry);
    }
  };
  try {
    await walk([]);
  } finally {
    await Deno.remove(tmp).catch((e) => {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
    });
  }
  await Deno.writeFile(out, encodeTreePatch({ files, dirs }, frames));
}
