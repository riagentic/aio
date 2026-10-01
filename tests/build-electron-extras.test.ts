// Task2 Step C — the optional Chromium extras (DXIL compiler, software Vulkan)
// are opt-IN, because every one is used by some app: a 3D app's hardware path,
// a VM's software fallback. This pins both halves: the default keeps them, the
// opt-in removes exactly the documented set and nothing a baseline needs.
import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  chromiumExtrasStripped,
  OPTIONAL_CHROMIUM_EXTRAS,
  stripOptionalChromiumExtras,
} from "../src/build/electron-strip.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

Deno.test("strip: removes only the optional extras, keeps the baseline", async () => {
  const tmp = await tempDir("chromium-strip-");
  try {
    // A stand-in for a real win32-x64 tree: the optional set plus files that
    // must never be touched.
    const baseline = [
      "electron.exe",
      "d3dcompiler_47.dll",
      "ffmpeg.dll",
      "icudtl.dat",
      "resources.pak",
      "LICENSES.chromium.html",
      "locales/en-US.pak",
    ];
    for (const name of [...OPTIONAL_CHROMIUM_EXTRAS, ...baseline]) {
      const p = join(tmp, name);
      await Deno.mkdir(join(p, ".."), { recursive: true });
      await Deno.writeTextFile(p, "x");
    }
    const removed = stripOptionalChromiumExtras(tmp);
    assertEquals(
      [...removed].sort(),
      [
        "dxcompiler.dll",
        "dxil.dll",
        "libvk_swiftshader.so",
        "libvulkan.so.1",
        "vk_swiftshader.dll",
        "vk_swiftshader_icd.json",
        "vulkan-1.dll",
      ],
    );
    for (const name of baseline) {
      assertEquals(
        await Deno.stat(join(tmp, name)).then(() => true),
        true,
        `${name} must survive`,
      );
    }
    // Idempotent: a second pass removes nothing and does not throw.
    assertEquals(stripOptionalChromiumExtras(tmp), []);
  } finally {
    await dropTempDir(tmp);
  }
});

Deno.test("strip: build.chromiumExtras is keep by default, strip on request", async () => {
  const tmp = await tempDir("chromium-decl-");
  try {
    assertEquals(await chromiumExtrasStripped(tmp), false); // absent
    await Deno.writeTextFile(
      join(tmp, "deno.json"),
      JSON.stringify({ build: { chromiumExtras: "keep" } }),
    );
    assertEquals(await chromiumExtrasStripped(tmp), false);
    await Deno.writeTextFile(
      join(tmp, "deno.json"),
      JSON.stringify({ build: { chromiumExtras: "strip" } }),
    );
    assertEquals(await chromiumExtrasStripped(tmp), true);
    await Deno.writeTextFile(
      join(tmp, "deno.json"),
      JSON.stringify({ build: { chromiumExtras: "stripped" } }),
    );
    await assertRejects(
      () => chromiumExtrasStripped(tmp),
      Error,
      '"keep" (the default) or "strip"',
    );
  } finally {
    await dropTempDir(tmp);
  }
});
