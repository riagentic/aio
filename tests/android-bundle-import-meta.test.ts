// The Android bundle is a classic script, and a classic script has no
// `import.meta` — esbuild turns it into `{}`. The framework reads
// `import.meta.url` on the dispatch path (`isRunningFromSource`), so from
// 1.0.0-beta to 1.0.4-beta every tap in every standalone APK threw. The
// emulator lane (`test:android`) proves the APK; this pins the cause in the
// ordinary suite, with no SDK: bundle the Android way, run its module scope.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import * as esbuild from "esbuild";
import { bundleClient } from "../src/build/client-bundle.ts";
import { stopEsbuildService } from "../src/build/esbuild-shared.ts";
import { evaluateBundle } from "../src/build/graph-eval.ts";
import { isRunningFromSource } from "../src/diagnostics/logger-types.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const REPO = new URL("../", import.meta.url).pathname;

Deno.test("android bundle: import.meta.url is a string and import.meta.main is false", async () => {
  const root = await tempDir("aio-android-meta-");
  try {
    await Deno.writeTextFile(
      join(root, "App.tsx"),
      `const url: unknown = import.meta.url;
if (typeof url !== "string") throw new Error("import.meta.url is " + typeof url);
if (import.meta.main !== false) throw new Error("import.meta.main is " + import.meta.main);
export default function App() { return null; }
`,
    );
    const b = await bundleClient({
      esbuild,
      root,
      appDir: root,
      uiEntry: "App.tsx",
      doAndroid: true,
      imports: {},
      shares: [],
      frameworkSrcDir: join(REPO, "src"),
    });
    assert(b.ok, b.errors.join("\n"));
    assertEquals(b.format, "iife");
    const run = await evaluateBundle(b.code, "iife");
    assert(run.ok, `the bundle's module scope threw: ${JSON.stringify(run)}`);
  } finally {
    await dropTempDir(root);
    // NOT a bare `esbuild.stop()`: that only sends the kill, and the native
    // child was still in the process table on every measured run. Under the
    // parallel suite its exit landed after this test ended — shard 4 failed
    // with a leaked child process and a leaked "wait for a subprocess to
    // exit" op, while the file alone stayed green.
    await stopEsbuildService(() => esbuild.stop());
  }
});

Deno.test("isRunningFromSource: true here, and never throws", () => {
  // From source, this module's URL is file:///… — and the function sits on
  // the dispatch path, so the classic-script case (url undefined) must answer
  // false rather than throw; the bundle test above covers that shape.
  assertEquals(isRunningFromSource(), true);
});
