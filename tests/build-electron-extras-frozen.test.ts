// `build.chromiumExtras` with a value that is neither "keep" nor "strip".
//
// The value is named on every desktop build — but two builds never depended
// on it, and built with it before it was checked for them: one run with
// `AIO_STRIP_CHROMIUM=1` (the env form decides) and a macOS one (nothing is
// stripped from a bundle). Those warn, say which setting wins, and build. A
// Windows or Linux build with no env form still refuses, as it always did.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { chromiumExtrasStripped } from "../src/build/electron-strip.ts";
import { HEY } from "../src/diagnostics/fmt.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

/** One decision: what it returned (or threw), and what it warned. */
async function decided(
  root: string,
  os: string,
  env: boolean,
): Promise<{ strip: boolean | Error; warns: string[] }> {
  const before = Deno.env.get("AIO_STRIP_CHROMIUM");
  const warn = console.warn;
  const warns: string[] = [];
  console.warn = (...a: unknown[]) => warns.push(a.join(" "));
  if (env) Deno.env.set("AIO_STRIP_CHROMIUM", "1");
  else Deno.env.delete("AIO_STRIP_CHROMIUM");
  try {
    return { strip: await chromiumExtrasStripped(root, os), warns };
  } catch (e) {
    return { strip: e as Error, warns };
  } finally {
    console.warn = warn;
    if (before === undefined) Deno.env.delete("AIO_STRIP_CHROMIUM");
    else Deno.env.set("AIO_STRIP_CHROMIUM", before);
  }
}

Deno.test("strip: a bad build.chromiumExtras warns and builds where the value never decided anything; it still stops a Windows/Linux build", async () => {
  const tmp = await tempDir("chromium-frozen-");
  try {
    await Deno.writeTextFile(
      join(tmp, "deno.json"),
      JSON.stringify({ build: { chromiumExtras: "stripped" } }),
    );
    const named = 'build.chromiumExtras is "stripped"';

    // AIO_STRIP_CHROMIUM=1: built on 1.0.16 (stripped) — builds, and says so.
    for (const os of ["linux", "windows"]) {
      const { strip, warns } = await decided(tmp, os, true);
      assertEquals(strip, true, os);
      assertEquals(warns.length, 1, warns.join("\n"));
      assert(warns[0]!.startsWith(HEY), warns[0]);
      assertStringIncludes(warns[0]!, named);
      assertStringIncludes(warns[0]!, "AIO_STRIP_CHROMIUM=1 decides");
    }

    // macOS: built on 1.0.16 (the value was not read) — builds, and says so.
    for (const env of [false, true]) {
      const { strip, warns } = await decided(tmp, "darwin", env);
      assertEquals(strip, env);
      assertEquals(warns.length, 1, warns.join("\n"));
      assert(warns[0]!.startsWith(HEY), warns[0]);
      assertStringIncludes(warns[0]!, named);
      assertStringIncludes(warns[0]!, "macOS bundle keeps its runtime whole");
    }

    // Windows / Linux with no env form: refused, as before.
    for (const os of ["linux", "windows"]) {
      const { strip, warns } = await decided(tmp, os, false);
      assert(strip instanceof Error, os);
      assertStringIncludes(strip.message, '"keep" (the default) or "strip"');
      assertEquals(warns, []);
    }

    // A deno.json that cannot be read declares nothing: the env form still
    // decides, and the warning says which way it went.
    await Deno.writeTextFile(join(tmp, "deno.json"), "{ not json");
    for (
      const [env, went] of [
        [true, "stripped (AIO_STRIP_CHROMIUM=1)"],
        [false, "kept"],
      ] as const
    ) {
      const { strip, warns } = await decided(tmp, "linux", env);
      assertEquals(strip, env);
      assertEquals(warns.length, 1, warns.join("\n"));
      assertStringIncludes(warns[0]!, "deno.json could not be read");
      assert(warns[0]!.endsWith(`Chromium extras ${went}`), warns[0]);
    }

    // A valid value never warns, on any of them.
    await Deno.writeTextFile(
      join(tmp, "deno.json"),
      JSON.stringify({ build: { chromiumExtras: "strip" } }),
    );
    for (const os of ["linux", "windows", "darwin"]) {
      assertEquals(await decided(tmp, os, false), { strip: true, warns: [] });
    }
  } finally {
    await dropTempDir(tmp);
  }
});

Deno.test("strip: the Electron build hands its platform to the decider — a macOS build with a bad value goes on", async () => {
  // The call site: without the platform the decider cannot tell a macOS
  // build from a Windows one, and refuses both.
  const tmp = await tempDir("chromium-frozen-os-");
  try {
    await Deno.writeTextFile(
      join(tmp, "deno.json"),
      JSON.stringify({ build: { chromiumExtras: "stripped" } }),
    );
    const noOs = await decided(tmp, undefined as unknown as string, false);
    assert(noOs.strip instanceof Error, "no platform: the strict answer");
    const src = await Deno.readTextFile(
      new URL("../src/build/build-electron.ts", import.meta.url),
    );
    assertEquals(
      [...src.matchAll(/chromiumExtrasStripped\(([^)]*)\)/g)].map((m) => m[1]),
      ["root, os"],
    );
  } finally {
    await dropTempDir(tmp);
  }
});
