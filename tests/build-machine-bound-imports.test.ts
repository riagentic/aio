// An import-map value that is an ABSOLUTE path or a `file:` URL builds a
// binary that only runs on the build machine. Measured on Deno 2.9.7: the
// module is embedded, yet the binary loads it from that disk path at run time
// — move the folder and it dies with `Module not found`. The same module named
// by a RELATIVE value ("../aio/mod.ts", "./dep/aio/mod.ts") runs from
// anywhere. The build said ✓ and nothing else. It now warns (not refuses: the
// artifact does run where it was built), naming the key, the value and the
// relative spelling that fixes it.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  isMachineBoundSpecifier,
  machineBoundImports,
  machineBoundWarning,
  warnMachineBoundImports,
} from "../src/build/machine-bound-imports.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

Deno.test("machine-bound imports: absolute paths and file: URLs are flagged, portable specifiers are not", () => {
  for (
    const v of [
      "/home/x/aio/mod.ts",
      "file:///home/x/aio/mod.ts",
      "FILE:///home/x/aio/",
      "C:\\aio\\mod.ts",
      "c:/aio/mod.ts",
      "\\\\srv\\share\\mod.ts",
    ]
  ) assert(isMachineBoundSpecifier(v), v);
  for (
    const v of [
      "./dep/aio/mod.ts",
      "../../mod.ts",
      "jsr:@riagentic/aio@1.0.0",
      "npm:immer@10.2.0",
      "https://deno.land/x/y.ts",
      "node:fs",
      "src/x.ts",
    ]
  ) assert(!isMachineBoundSpecifier(v), v);
});

Deno.test("machine-bound imports: every imports/scopes value is found with its relative fix", () => {
  const found = machineBoundImports({
    imports: {
      "aio": "/home/x/aio/mod.ts",
      "aio/": "file:///home/x/aio/src/",
      "own": "/home/x/app/src/own.ts",
      "ok": "./dep/aio/mod.ts",
      "immer": "npm:immer@10.2.0",
    },
    scopes: { "./vendor/": { "dep": "/opt/dep/mod.ts", "fine": "../x.ts" } },
  }, "/home/x/app");
  assertEquals(found, [
    {
      key: 'imports["aio"]',
      value: "/home/x/aio/mod.ts",
      suggest: "../aio/mod.ts",
    },
    {
      key: 'imports["aio/"]',
      value: "file:///home/x/aio/src/",
      suggest: "../aio/src/",
    },
    {
      key: 'imports["own"]',
      value: "/home/x/app/src/own.ts",
      suggest: "./src/own.ts",
    },
    {
      key: 'scopes["./vendor/"]["dep"]',
      value: "/opt/dep/mod.ts",
      suggest: "../../../opt/dep/mod.ts",
    },
  ]);
  assertEquals(machineBoundImports({}, "/a"), []);
  assertEquals(machineBoundImports({ imports: ["/x"] }, "/a"), []);
  assertEquals(machineBoundWarning([], "deno.json"), null);
});

Deno.test("machine-bound imports: the warning names key, value, the fix and the am create layout", () => {
  const w = machineBoundWarning(
    machineBoundImports(
      { imports: { aio: "/home/x/aio/mod.ts" } },
      "/home/x/app",
    ),
    "deno.json",
  );
  assert(w);
  const text = w.join("\n");
  for (
    const s of [
      "deno.json",
      'imports["aio"]',
      '"/home/x/aio/mod.ts"',
      '"../aio/mod.ts"',
      "Module not found",
      "./dep/aio/",
      "am create",
    ]
  ) assertStringIncludes(text, s);
});

/** Capture stderr for one async call. */
async function warned(fn: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const o = console.warn;
  console.warn = (...a: unknown[]) => lines.push(a.join(" "));
  try {
    await fn();
  } finally {
    console.warn = o;
  }
  // The block renderer wraps long lines — assert on words, not layout.
  return lines.join("\n").replace(/\s+/g, " ").trim();
}

Deno.test("machine-bound imports: warnMachineBoundImports reads deno.json and an external importMap", async () => {
  const dir = await tempDir("aio-machine-bound-");
  try {
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      `{ // JSONC, as Deno reads it
  "imports": { "aio": "${dir}/fw/mod.ts", "ok": "./dep/aio/mod.ts" },
  "importMap": "./maps/import_map.json" }`,
    );
    await Deno.mkdir(join(dir, "maps"));
    await Deno.writeTextFile(
      join(dir, "maps", "import_map.json"),
      JSON.stringify({ imports: { dep: `file://${dir}/dep/mod.ts` } }),
    );
    const out = await warned(() => warnMachineBoundImports(dir));
    assertStringIncludes(out, `imports["aio"] = "${dir}/fw/mod.ts"`);
    assertStringIncludes(out, `"./fw/mod.ts"`);
    assertStringIncludes(out, `imports["dep"] = "file://${dir}/dep/mod.ts"`);
    assertStringIncludes(out, `"../dep/mod.ts"`); // relative to the MAP file
    assert(!out.includes(`"ok"`), out);

    // A clean app says nothing.
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({ imports: { aio: "./dep/aio/mod.ts" } }),
    );
    assertEquals(await warned(() => warnMachineBoundImports(dir)), "");
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("machine-bound imports: every deno compile path runs the check", async () => {
  // Structural: the failure is one forgotten compile site, and a real compile
  // per target is a ~1 min test (the artifact-level half is in
  // build-e2e-machine-bound-imports.test.ts, AIO_BUILD_E2E=1).
  const root = new URL("../", import.meta.url);
  for (const f of ["src/build/build-compile.ts", "src/build/build-cli.ts"]) {
    const src = await Deno.readTextFile(new URL(f, root));
    assert(
      /await warnMachineBoundImports\(root\)/.test(src),
      `${f} compiles without the machine-bound import check`,
    );
  }
});
