/**
 * @module
 * Optional Chromium/Electron runtime extras — the files aio's locale trim
 * (electron-locales.ts) does NOT touch.
 *
 * ## Why this is opt-IN, not a default
 *
 * Electron ships these files because SOME app uses each one:
 *
 *   - `dxcompiler.dll` / `dxil.dll` — the DXIL shader compiler, used on
 *     Windows by WebGPU (`navigator.gpu`) and some D3D12 paths (~27 MB).
 *   - `vk_swiftshader.dll` / `libvk_swiftshader.so` (+ its `_icd.json`) — a
 *     SOFTWARE Vulkan implementation, used by GPU-less VMs, headless CI and
 *     any machine with no usable driver (~5-8 MB).
 *   - `vulkan-1.dll` / `libvulkan.so.1` — the Vulkan LOADER. Not a fallback:
 *     it is how Chromium reaches ANY Vulkan driver, the machine's own GPU
 *     included (~1 MB).
 *
 * Nothing on this list is provably unused by every aio app, so removing it by
 * default would trade a size number for a class of "works on my machine"
 * failures — a 3D app losing hardware acceleration, or a VM losing its
 * software fallback. Stripping removes ALL of Vulkan, hardware and software:
 * without the loader there is no Vulkan path at all, and Chromium is left
 * with its OpenGL/Direct3D (ANGLE) ones. `build.chromiumExtras: "strip"` (or `AIO_STRIP_CHROMIUM=1`)
 * is the explicit opt-in for an app whose owner KNOWS it never renders GPU
 * content; the default keeps the runtime exactly as Electron shipped it.
 * (a field report.)
 *
 * `d3dcompiler_47.dll` (WebGL/D3D11), `ffmpeg` (media), `icudtl.dat` (i18n)
 * and every license file are never candidates — they are a baseline, not an
 * extra.
 */
import { join } from "@std/path";
import { readDenoJson } from "../server/deno-json.ts";
import { HEY, NO, OK } from "../diagnostics/fmt.ts";

/** Basenames removed on a flat `electron/` layout (Windows, Linux) when the
 *  opt-in is on. Kept in one place so the removal and its test cannot drift. */
export const OPTIONAL_CHROMIUM_EXTRAS: readonly string[] = [
  "dxcompiler.dll",
  "dxil.dll",
  "vk_swiftshader.dll",
  "vk_swiftshader_icd.json",
  "libvk_swiftshader.so",
  "vulkan-1.dll",
  "libvulkan.so.1",
];

/** Remove the {@link OPTIONAL_CHROMIUM_EXTRAS} directly inside `dir`.
 *  Returns the basenames actually removed. A missing file is a no-op — the
 *  layout differs between Electron versions and that is not a build error. */
export function stripOptionalChromiumExtras(dir: string): string[] {
  const removed: string[] = [];
  for (const name of OPTIONAL_CHROMIUM_EXTRAS) {
    try {
      Deno.removeSync(join(dir, name));
      removed.push(name);
    } catch {
      // aio-ok: absent is the normal case for a platform that has no such file
      // (dxcompiler is Windows-only, libvk_swiftshader is Linux-only); the
      // caller reports what WAS removed, and nothing is assumed.
    }
  }
  return removed;
}

/** Carry out a strip the build decided on ({@link chromiumExtrasStripped}) in
 *  the staged runtime `dir`, and return the line the build prints. A macOS
 *  bundle is left whole: the listed files are Windows and Linux ones. The
 *  line names where the request came from — with `AIO_STRIP_CHROMIUM=1` the
 *  declared value may be `"keep"`, absent, or not a value at all. */
export function applyChromiumExtrasStrip(dir: string, os: string): string {
  const by = Deno.env.get("AIO_STRIP_CHROMIUM") === "1"
    ? "AIO_STRIP_CHROMIUM=1"
    : 'build.chromiumExtras: "strip"';
  if (os === "darwin") {
    return `Chromium extras strip requested (${by}) — not applied to a ` +
      `macOS bundle (the listed files are Windows/Linux ones); its runtime ` +
      `is kept whole`;
  }
  const removed = stripOptionalChromiumExtras(dir);
  return removed.length
    ? `${OK} stripped ${removed.length} optional Chromium extra(s): ${
      removed.join(", ")
    } (${by})`
    : `${OK} Chromium extras strip requested (${by}) — nothing optional ` +
      `was present`;
}

/** Should the optional Chromium extras be removed? `true` when
 *  `build.chromiumExtras: "strip"` or `AIO_STRIP_CHROMIUM=1`; `false` for the
 *  default `"keep"`/absent. Any other value is refused by name — a typo'd
 *  `"stripped"` must not silently keep 35 MB the author thought was gone.
 *
 *  Two builds do not depend on the declared value, and built before the
 *  declaration was checked for them: one with `AIO_STRIP_CHROMIUM=1` (the env
 *  form decides) and a macOS one (`os` — nothing is stripped from its bundle
 *  either way). There the bad value is a warning that says which setting
 *  wins, and the build goes on. */
export async function chromiumExtrasStripped(
  root: string,
  os?: string,
): Promise<boolean> {
  const env = Deno.env.get("AIO_STRIP_CHROMIUM") === "1";
  let cfg: { build?: { chromiumExtras?: unknown } } | undefined;
  try {
    cfg = (await readDenoJson(root))?.config as
      | { build?: { chromiumExtras?: unknown } }
      | undefined;
  } catch (e) {
    console.warn(
      `${HEY} deno.json could not be read (${
        e instanceof Error ? e.message : e
      }) — Chromium extras ${env ? "stripped (AIO_STRIP_CHROMIUM=1)" : "kept"}`,
    );
    return env;
  }
  const v = cfg?.build?.chromiumExtras;
  if (v === undefined || v === "keep") return env;
  if (v === "strip") return true;
  const bad = `deno.json build.chromiumExtras is ${
    JSON.stringify(v)
  } — it must be "keep" (the default) or "strip".`;
  if (os === "darwin") {
    console.warn(
      `${HEY} ${bad} A macOS bundle keeps its runtime whole either way, so ` +
        `this build goes on — a Windows or Linux build refuses the value.`,
    );
    return env;
  }
  if (env) {
    console.warn(
      `${HEY} ${bad} AIO_STRIP_CHROMIUM=1 decides this build: the extras ` +
        `are stripped.`,
    );
    return true;
  }
  throw new Error(`${NO} ${bad}`);
}
