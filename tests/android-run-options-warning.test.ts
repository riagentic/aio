// A packaged (local) APK never runs the app's entry module: the bundle entry
// (`makeEntryCode`) imports App.tsx only, so nothing passed to `aio.run({...})`
// reaches the phone. The android build used to print the opposite ("ui.theme,
// ui.layout, ui.dir and ui.lang do [reach it], applied at boot"). These pin
// both halves: the bundle really leaves the entry out, and the build names
// each option the app sets.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import * as esbuild from "esbuild";
import { bundleClient } from "../src/build/client-bundle.ts";
import { stopEsbuildService } from "../src/build/esbuild-shared.ts";
import {
  androidRunOptionsWarning,
  scanRunOptions,
} from "../src/build/android-run-options.ts";
import { _writeLocalAssets } from "../src/build/build-android.ts";
import type { BuildConfig } from "../src/build/build-config.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const REPO = new URL("../", import.meta.url).pathname;

Deno.test("android bundle: the app entry module is not in the APK bundle", async () => {
  // The premise of the warning. If a future build DOES bake the entry in,
  // this fails — and the warning must then shrink to what is still lost.
  const root = await tempDir("aio-android-entry-");
  try {
    await Deno.mkdir(join(root, "src"));
    await Deno.writeTextFile(
      join(root, "src", "app.ts"),
      `import { aio } from "aio";\nawait aio.run({ ui: { theme: "auto" } });\n`,
    );
    await Deno.writeTextFile(
      join(root, "src", "App.tsx"),
      `export default function App() { return null; }\n`,
    );
    const b = await bundleClient({
      esbuild,
      root,
      appDir: join(root, "src"),
      uiEntry: "App.tsx",
      doAndroid: true,
      imports: {},
      shares: [],
      frameworkSrcDir: join(REPO, "src"),
    });
    assert(b.ok, b.errors.join("\n"));
    const inputs = Object.keys(b.inputs);
    assert(inputs.some((k) => k.endsWith("src/App.tsx")), inputs.join(","));
    assertEquals(inputs.filter((k) => k.endsWith("src/app.ts")), []);
  } finally {
    await dropTempDir(root);
    await stopEsbuildService(() => esbuild.stop());
  }
});

Deno.test("android run options: scan reads top-level and ui keys, ignoring comments and strings", () => {
  const s = scanRunOptions(`
    // aio.run({ port: 1 }) in a comment is not the call
    const label = "aio.run({ bogus: 1 })";
    await aio.run({
      ui: { theme: "auto", lang: 'ar', dir: "rtl" },
      persist: false,
      "cellDefaults": { persist: "none" },
      async onStart(app) { if (x) { y(); } },
      onError: (e) => log(e, "{"),
      port: 8080,
      localFirst,
    });
  `);
  assertEquals(s.found, true);
  assertEquals(s.keys, [
    "ui",
    "persist",
    "cellDefaults",
    "onStart",
    "onError",
    "port",
    "localFirst",
  ]);
  assertEquals(s.uiKeys, ["theme", "lang", "dir"]);
  assertEquals(s.opaque, false);
  assertEquals(scanRunOptions(`aio.run({ ...base, port: 1 })`).opaque, true);
  assertEquals(scanRunOptions(`aio.run(config)`).opaque, true);
  assertEquals(scanRunOptions(`aio.run()`).keys.length, 0);
  assertEquals(scanRunOptions(`export const x = 1;`).found, false);
});

Deno.test("android run options: the warning names every option the app sets", () => {
  const w = androidRunOptionsWarning(
    `await aio.run({ ui: { theme: "auto", lang: "ar" }, persist: false, onStart() {}, port: 9 });`,
    "src/app.ts",
  );
  assert(w, "an app that sets options must be warned");
  assertStringIncludes(w.headline, "never runs src/app.ts");
  for (const k of ["ui.theme", "ui.lang", "persist", "onStart", "port"]) {
    assertStringIncludes(w.body, k);
  }
  assertStringIncludes(w.fix, "--android --remote");
  // Nothing set → nothing to say.
  assertEquals(
    androidRunOptionsWarning(`await aio.run();`, "src/app.ts"),
    null,
  );
  assertEquals(
    androidRunOptionsWarning(`await aio.run({});`, "src/app.ts"),
    null,
  );
});

Deno.test("android build: the local-assets step warns about the scaffold's ui.theme", async () => {
  const root = await tempDir("aio-android-warn-");
  const orig = console.warn;
  const said: string[] = [];
  console.warn = (...a: unknown[]) => said.push(a.map(String).join(" "));
  try {
    await Deno.mkdir(join(root, "src"));
    await Deno.writeTextFile(
      join(root, "src", "app.ts"),
      `import "./cell.ts";\nimport { aio } from "aio";\n\nawait aio.run({ ui: { theme: "auto" } });\n`,
    );
    const dist = join(root, "dist"), assets = join(root, "assets");
    await Deno.mkdir(dist);
    await Deno.mkdir(assets);
    await Deno.writeTextFile(join(dist, "app.js"), "");
    await _writeLocalAssets(
      {
        root,
        dist,
        configEntry: "src/app.ts",
        binaryName: "scaffold",
        appTitle: undefined,
      } as unknown as BuildConfig,
      assets,
    );
  } finally {
    console.warn = orig;
    await dropTempDir(root);
  }
  assertEquals(said.length, 1, said.join("\n"));
  assertStringIncludes(said.join("\n"), "ui.theme");
  assertStringIncludes(said.join("\n"), "src/style.css");
});

Deno.test("android run options: a regex literal holding a quote does not hide the call", () => {
  // `/"/` read as a string opener swallowed everything up to the next `"` —
  // `aio.run(` included — and the build said nothing about what the APK lost.
  const s = scanRunOptions(
    `const unquote = (t: string) => t.replace(/"/g, "");\n` +
      `const esc = /[{'\`]/;\n` +
      `await aio.run({ ui: { theme: "auto" }, onStart() {} });\n` +
      `const half = a / b / c;\n`,
  );
  assertEquals(s.found, true);
  assertEquals(s.keys, ["ui", "onStart"]);
  assertEquals(s.uiKeys, ["theme"]);
  assertEquals(s.opaque, false);
});

Deno.test("android run options: an aliased aio import is still read", () => {
  // `import { aio as app }` → `app.run({...})` is the same call; the scan
  // matched only the literal `aio.` and the APK warning stayed silent.
  const aliased = scanRunOptions(
    `import { cell, aio as app } from "aio";\n` +
      `await app.run({ persist: false, ui: { theme: "full" } });\n`,
  );
  assertEquals(aliased, {
    found: true,
    keys: ["persist", "ui"],
    uiKeys: ["theme"],
    opaque: false,
  });
  // A namespace import keeps the `aio.run(` text and was always read.
  assertEquals(
    scanRunOptions(
      `import * as x from "aio";\nawait x.aio.run({ persist: false });\n`,
    )
      .keys,
    ["persist"],
  );
  // An unrelated `.run(` is still not the call.
  assertEquals(scanRunOptions(`task.run({ persist: false });\n`).found, false);
});
