// Task2 Step C — the optional Chromium extras (DXIL compiler, software Vulkan)
// are opt-IN, because every one is used by some app: a 3D app's hardware path,
// a VM's software fallback. This pins both halves: the default keeps them, the
// opt-in removes exactly the documented set and nothing a baseline needs.
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { join } from "@std/path";
import {
  applyChromiumExtrasStrip,
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
    // The env form strips, whatever the declaration says: a bad value beside
    // it is a warning, not a refusal (build-electron-extras-frozen.test.ts).
    const before = Deno.env.get("AIO_STRIP_CHROMIUM");
    Deno.env.set("AIO_STRIP_CHROMIUM", "1");
    try {
      assertEquals(await chromiumExtrasStripped(tmp), true);
      await Deno.writeTextFile(
        join(tmp, "deno.json"),
        JSON.stringify({ build: { chromiumExtras: "keep" } }),
      );
      assertEquals(await chromiumExtrasStripped(tmp), true);
    } finally {
      if (before === undefined) Deno.env.delete("AIO_STRIP_CHROMIUM");
      else Deno.env.set("AIO_STRIP_CHROMIUM", before);
    }
  } finally {
    await dropTempDir(tmp);
  }
});

Deno.test("strip: the Electron build reads build.chromiumExtras on every platform, before it looks at the OS", async () => {
  // `os !== "darwin" && await chromiumExtrasStripped(root)` never ran the
  // validator for a macOS build: `"chromiumExtras": "stripped"` built fine on
  // a Mac, silently, and was refused the first time the app was built for
  // Windows. Now the Mac build names it too (a warning there).
  const src = await Deno.readTextFile(
    new URL("../src/build/build-electron.ts", import.meta.url),
  );
  const calls = [...src.matchAll(/.*chromiumExtrasStripped\(.*/g)].map((m) =>
    m[0].trim()
  );
  assertEquals(calls, [
    "const stripExtras = await chromiumExtrasStripped(root, os);",
  ]);
});

Deno.test("strip: a macOS bundle is left whole, and the build line names where the request came from", async () => {
  const tmp = await tempDir("chromium-apply-");
  const before = Deno.env.get("AIO_STRIP_CHROMIUM");
  try {
    const extra = join(tmp, "libvulkan.so.1");
    for (
      const [env, by] of [
        [false, 'build.chromiumExtras: "strip"'],
        // The env form asks whatever the declaration says — `"keep"`, or a
        // typo: the line must not claim the declaration said "strip".
        [true, "AIO_STRIP_CHROMIUM=1"],
      ] as const
    ) {
      if (env) Deno.env.set("AIO_STRIP_CHROMIUM", "1");
      else Deno.env.delete("AIO_STRIP_CHROMIUM");
      const other = by.startsWith("AIO") ? "build.chromiumExtras" : "AIO_STRIP";

      await Deno.writeTextFile(extra, "x");
      const mac = applyChromiumExtrasStrip(tmp, "darwin");
      assert((await Deno.stat(extra)).isFile, "nothing leaves a macOS bundle");
      assertStringIncludes(mac, `strip requested (${by})`);
      assertStringIncludes(mac, "not applied to a macOS bundle");
      assert(!mac.includes(other), mac);

      const linux = applyChromiumExtrasStrip(tmp, "linux");
      await assertRejects(() => Deno.stat(extra), Deno.errors.NotFound);
      assertStringIncludes(linux, `libvulkan.so.1 (${by})`);
      assert(!linux.includes(other), linux);
      const again = applyChromiumExtrasStrip(tmp, "linux");
      assertStringIncludes(again, `(${by}) — nothing optional was present`);
    }
    // The call site: only on a strip decision, with the build's platform.
    const src = await Deno.readTextFile(
      new URL("../src/build/build-electron.ts", import.meta.url),
    );
    assertEquals(
      [...src.matchAll(/.*applyChromiumExtrasStrip\(.*/g)].map((m) =>
        m[0].trim()
      ),
      [
        "if (stripExtras) console.log(applyChromiumExtrasStrip(electronDst, os));",
      ],
    );
  } finally {
    if (before === undefined) Deno.env.delete("AIO_STRIP_CHROMIUM");
    else Deno.env.set("AIO_STRIP_CHROMIUM", before);
    await dropTempDir(tmp);
  }
});
