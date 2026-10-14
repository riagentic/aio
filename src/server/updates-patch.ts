// updates-patch.ts — make a release's artifact from the one installed here.
//
// A release may carry patches (`ShipManifest.patches`): zstd frames that turn
// ONE earlier artifact into the new one. Two builds a commit apart differ by
// kilobytes where the whole artifact is a hundred megabytes.
//
// A patch is never a second thing to trust. What it produces goes through the
// same door as a download (`downloadArtifact({ bytes })`): counted against the
// manifest's size, digested against the manifest's signed `sha256`, and
// verified again before the swap. A wrong patch, a wrong starting file or a
// bug in the decoder all end the same way — the bytes are not the release,
// and the whole release is downloaded instead.
//
// Only an install that IS one file can start a patch (a compiled binary, an
// AppImage). An unpacked directory (a `.zip` or `.app` install) no longer has
// the archive its manifest hashes, and re-packing it byte for byte is not
// possible — those download every release whole.

import { dirname } from "@std/path";
import {
  type ReleasePatch,
  type ShipManifest,
  usablePatches,
} from "../build/ship.ts";
import { downloadArtifact, fileSha256, MB } from "./updates-check.ts";
import { forget } from "./updates-owned.ts";
import { zstdBlocks } from "./updates-zstd.ts";

/** Replaceable by a test. @internal */
export const _patchDeps = {
  /** Bytes of memory free, or null when the app may not ask (no
   *  `--allow-sys`). Unknown is not a refusal: an allocation that fails is
   *  caught like every other miss.
   *
   *  The larger of `available` and `free`: Deno on Windows reports
   *  `available: 0` and only `free` (measured, 2.9.7 on Windows 11 — every
   *  patch was refused there for "0 bytes free"); on Linux and macOS
   *  `available` is the true figure and never below `free`. */
  availableMemory: (): number | null => {
    try {
      const m = Deno.systemMemoryInfo();
      return Math.max(m.available, m.free);
    } catch {
      return null; // aio-ok: not allowed to ask — see above
    }
  },
};

/** The patch that starts from the installed artifact (`installed`: its
 *  SHA-256), or why none is used. A patch over half the release's size is not
 *  worth the memory applying it takes. Pure. */
export function pickPatch(
  patches: ReleasePatch[],
  installed: string,
  fullSize: number,
): { patch: ReleasePatch } | { why: string } {
  const patch = patches.find((p) =>
    p.from.toLowerCase() === installed.toLowerCase()
  );
  if (!patch) {
    return {
      why: `none of its ${patches.length} starts from the build installed ` +
        `here (${installed.slice(0, 12)}…)`,
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

/** Why `available` bytes of memory are too few to apply a patch that needs
 *  `need`, or null. A quarter is left over: the app is running too. Pure. */
export function memoryShort(need: number, available: number): string | null {
  return available >= need * 1.25
    ? null
    : `applying it needs ${MB(need)} of memory and ${MB(available)} is free`;
}

/** Apply `patch` to the file `from`: the `size` bytes it makes. The file and
 *  the output share one buffer (see updates-zstd.ts); other work runs between
 *  blocks. Throws when the patch does not make exactly `size` bytes. */
export async function applyPatch(
  from: string,
  patch: Uint8Array,
  size: number,
): Promise<Uint8Array> {
  using file = await Deno.open(from, { read: true });
  const base = (await file.stat()).size;
  const buf = new Uint8Array(base + size);
  for (let at = 0; at < base;) {
    const n = await file.read(buf.subarray(at, base));
    if (n === null) throw new Error(`${from} ended at ${at} of ${base} bytes`);
    at += n;
  }
  const blocks = zstdBlocks(patch, buf, base);
  for (let n = 1;; n++) {
    const step = blocks.next();
    if (step.done) {
      if (step.value !== buf.length) {
        throw new Error(
          `the patch made ${step.value - base} bytes, not ${size}`,
        );
      }
      return buf.subarray(base);
    }
    // 64 blocks are at most 8 MiB of output: a few milliseconds.
    if (n % 64 === 0) await new Promise((r) => setTimeout(r, 0));
  }
}

/** The artifact of release `manifest` (whose claims already verified), made
 *  from the file installed at `installed` and a downloaded patch.
 *
 *  `null`: the release carries no patches. `why`: it does, and none could be
 *  used — said once by the caller, which downloads the whole release. Never
 *  throws, and never decides what gets installed: the caller checks the bytes
 *  against the manifest. */
export async function artifactFromPatch(opts: {
  manifest: ShipManifest;
  /** The manifest's own URL — a patch's `url` is relative to it. */
  manifestUrl: string;
  installed: string;
  dataDir: string;
}): Promise<
  { bytes: Uint8Array; patch: ReleasePatch } | { why: string } | null
> {
  const m = opts.manifest;
  if (m.patches === undefined) return null;
  try {
    const usable = await usablePatches(m);
    if (usable.reason) return { why: usable.reason };
    const base = await Deno.stat(opts.installed);
    if (!base.isFile) return { why: "what is installed here is not one file" };
    const pick = pickPatch(
      usable.patches,
      await fileSha256(opts.installed),
      m.size,
    );
    if ("why" in pick) return pick;
    const { patch } = pick;
    const free = _patchDeps.availableMemory();
    const short = free === null
      ? null
      : memoryShort(base.size + m.size + patch.size, free);
    if (short) return { why: short };
    const got = await downloadArtifact({
      url: new URL(patch.url, opts.manifestUrl).href,
      dest: `${opts.installed}.patch-${m.version}`,
      expectSha256: patch.sha256,
      expectSize: patch.size,
      owner: opts.dataDir,
      keepStaged: true,
    });
    if (!got.ok) return { why: got.error };
    const stage = dirname(got.path);
    try {
      return {
        bytes: await applyPatch(
          opts.installed,
          await Deno.readFile(got.path),
          m.size,
        ),
        patch,
      };
    } finally {
      await Deno.remove(stage, { recursive: true });
      forget(opts.dataDir, stage);
    }
  } catch (e) {
    return { why: e instanceof Error ? e.message : String(e) };
  }
}
