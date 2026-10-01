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
 *   - `vk_swiftshader.dll` / `libvk_swiftshader.so` / `vulkan-1.dll` — a
 *     SOFTWARE Vulkan fallback, used by GPU-less VMs, headless CI and any
 *     machine with no usable driver (~6-9 MB).
 *
 * Nothing on this list is provably unused by every aio app, so removing it by
 * default would trade a size number for a class of "works on my machine"
 * failures — a 3D app losing hardware acceleration, or a VM losing its
 * software fallback. `build.chromiumExtras: "strip"` (or `AIO_STRIP_CHROMIUM=1`)
 * is the explicit opt-in for an app whose owner KNOWS it never renders GPU
 * content; the default keeps the runtime exactly as Electron shipped it.
 * (feedback/optimal-builds.md Task2 Step C.)
 *
 * `d3dcompiler_47.dll` (WebGL/D3D11), `ffmpeg` (media), `icudtl.dat` (i18n)
 * and every license file are never candidates — they are a baseline, not an
 * extra.
 */
import { join } from "@std/path";
import { readDenoJson } from "../server/deno-json.ts";
import { HEY, NO } from "../diagnostics/fmt.ts";

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

/** Should the optional Chromium extras be removed? `true` when
 *  `build.chromiumExtras: "strip"` or `AIO_STRIP_CHROMIUM=1`; `false` for the
 *  default `"keep"`/absent. Refused by name for any other value — a typo'd
 *  `"stripped"` must not silently keep 35 MB the author thought was gone. */
export async function chromiumExtrasStripped(root: string): Promise<boolean> {
  if (Deno.env.get("AIO_STRIP_CHROMIUM") === "1") return true;
  let cfg: { build?: { chromiumExtras?: unknown } } | undefined;
  try {
    cfg = (await readDenoJson(root))?.config as
      | { build?: { chromiumExtras?: unknown } }
      | undefined;
  } catch (e) {
    console.warn(
      `${HEY} deno.json could not be read (${
        e instanceof Error ? e.message : e
      }) — Chromium extras kept`,
    );
    return false;
  }
  const v = cfg?.build?.chromiumExtras;
  if (v === undefined || v === "keep") return false;
  if (v === "strip") return true;
  throw new Error(
    `${NO} deno.json build.chromiumExtras is ${
      JSON.stringify(v)
    } — it must be "keep" (the default) or "strip".`,
  );
}
