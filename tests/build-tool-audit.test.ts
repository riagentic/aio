// Task2 Steps A/B — a compiled binary must not carry the TypeScript compiler,
// esbuild, or appimagetool; and the audit that says so reads the REAL VFS tree,
// not intent (a field report: it read basenames as if they were paths and
// so reported NONE while 165 MB of tools shipped).
//
// The end-to-end half of Step A is in `build-e2e.test.ts` (it builds a binary
// and scans it). This file pins the mechanism: the VFS-tree reader, the
// dev-closure classification that keeps `typescript` out even when it is only a
// peer dep (§3), the `build.keepPackages` escape hatch, the non-runtime trim
// (§4) and the tool-cache exclusion (§5).
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { join } from "@std/path";
import {
  ArtifactUnreadable,
  buildToolHitsIn,
  needlePackage,
  scanArtifactForBuildTools,
  warnBuildToolsIn,
} from "../src/build/artifact-audit.ts";
import {
  keepPackagesDeclared,
  withDevExcluded,
} from "../src/build/build-compile.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { linkDir, linkText } from "./symlink-helper.ts";

const exists = (p: string) => Deno.lstat(p).then(() => true).catch(() => false);

/** Write `<nm>/.deno/<entry>/node_modules/<pkg>/<rel>`. */
async function denoEntryFile(
  nm: string,
  entry: string,
  pkg: string,
  rel: string,
  body = "x",
): Promise<string> {
  const p = join(nm, ".deno", entry, "node_modules", pkg, rel);
  await Deno.mkdir(join(p, ".."), { recursive: true });
  await Deno.writeTextFile(p, body);
  return p;
}

/** Link `node_modules/<name>` at the `.deno` entry, the way deno install does. */
async function link(
  nm: string,
  name: string,
  entry: string,
  pkg: string,
): Promise<void> {
  await Deno.mkdir(join(nm, name, ".."), { recursive: true });
  await linkDir(`.deno/${entry}/node_modules/${pkg}`, join(nm, name));
}

/** A tree the way deno writes it into a binary: the JSON behind its own
 *  8-byte little-endian length — the one thing that tells the real tree from
 *  text that merely looks like its first bytes. */
function vfs(tree: string, before = "", after = ""): Uint8Array {
  const enc = new TextEncoder();
  const [pre, json, post] = [before, tree, after].map((t) => enc.encode(t));
  const out = new Uint8Array(pre!.length + 8 + json!.length + post!.length);
  out.set(pre!, 0);
  new DataView(out.buffer).setBigUint64(
    pre!.length,
    BigInt(json!.length),
    true,
  );
  out.set(json!, pre!.length + 8);
  out.set(post!, pre!.length + 8 + json!.length);
  return out;
}

const TSC = '{"File":{"n":"tsc","o":[0,23653616]}}';
/** A tree that carries the compiler. */
const LEAKY = `[{"Dir":{"n":"node_modules","e":[{"Dir":{"n":".deno","e":[` +
  `{"Dir":{"n":"typescript@6.0.3","e":[${TSC}]}}]}}]}}]`;

Deno.test("artifact audit: reads the VFS tree by basename, attributes the package", () => {
  const tree = '[{"Dir":{"n":"node_modules","e":[' +
    '{"Dir":{"n":".deno","e":[' +
    '{"Dir":{"n":"typescript@6.0.3","e":[' +
    '{"File":{"n":"tsc","o":[0,23653616]}},' +
    '{"File":{"n":"_tsc.js","o":[0,5950000]}},' +
    // deno's tiny bin shim must NOT read as the compiler.
    '{"File":{"n":"tsc.js","o":[0,45]}}]}},' +
    '{"Dir":{"n":"@typescript+typescript-darwin-arm64@7.0.2","e":[' +
    '{"Dir":{"n":"lib","e":[{"File":{"n":"tsc","o":[0,23500000]}}]}}]}},' +
    '{"Dir":{"n":"@esbuild+linux-x64@0.24.2","e":[' +
    '{"File":{"n":"esbuild","o":[0,10182808]}}]}},' +
    // An entry WITH peers: the package is what precedes the first version.
    '{"Dir":{"n":"@scope+tool@1.0.0_typescript@6.0.3","e":[' +
    '{"File":{"n":"esbuild.wasm","o":[0,9000000]}}]}}' +
    "]}}," +
    '{"Dir":{"n":".cache","e":[{"File":{"n":"appimagetool","o":[0,15092216]}}]}}' +
    "]}}," +
    // The app's OWN file of that name is its program, not a leaked tool.
    '{"Dir":{"n":"src","e":[{"File":{"n":"tsc.js","o":[0,90000]}}]}}]';
  assertEquals(buildToolHitsIn(vfs(tree)), [
    "@esbuild/linux-x64",
    "@scope/tool",
    "@typescript/typescript-darwin-arm64",
    "appimagetool",
    "typescript",
  ]);

  // A tree with no build tool reports nothing…
  const clean = '[{"File":{"n":"app.ts","o":[0,10]}},' +
    '{"Dir":{"n":"src","e":[{"File":{"n":"index.js","o":[0,20]}}]}}]';
  assertEquals(buildToolHitsIn(vfs(clean)), []);
  // …a match under the threshold is a deno shim, not the tool…
  assertEquals(
    buildToolHitsIn(
      vfs(
        '[{"Dir":{"n":"node_modules","e":[{"Dir":{"n":"typescript@6.0.3","e":[{"File":{"n":"tsc","o":[0,45]}}]}}]}}]',
      ),
    ),
    [],
  );
  // …and a root that starts with a symlink is still the tree.
  assertEquals(
    buildToolHitsIn(
      vfs(`[{"Symlink":{"n":"a","p":["x"]}},${LEAKY.slice(1)}`),
    ),
    ["typescript"],
  );
});

Deno.test("artifact audit: deno's own install state in a binary is a hit — the launchers, the installer's cache and lock", () => {
  const dir = (n: string, e: string) => `{"Dir":{"n":"${n}","e":[${e}]}}`;
  const file = (n: string) => `{"File":{"n":"${n}","o":[0,9]}}`;
  const tree = (nm: string, src = "") =>
    `[${dir("node_modules", nm)}${src && `,${dir("src", src)}`}]`;
  // The launchers are links: the directory itself is the hit.
  assertEquals(
    buildToolHitsIn(
      vfs(tree(
        dir(".bin", '{"Symlink":{"n":"electron","p":["x"]}}') + "," +
          dir(".deno", `${file(".setup-cache.bin")},${file(".deno.lock")}`),
      )),
    ),
    [
      "node_modules/.bin",
      "node_modules/.deno/.deno.lock",
      "node_modules/.deno/.setup-cache.bin",
    ],
  );
  // Only THERE: a package's own `.bin`, a lock inside a package, the app's
  // own files of those names are not deno's install state.
  assertEquals(
    buildToolHitsIn(
      vfs(tree(
        dir(
          ".deno",
          dir(
            "lib@1.0.0",
            dir(
              "node_modules",
              `${dir(".bin", file("y"))},${
                dir("lib", `${dir(".bin", file("x"))}`)
              }`,
            ) +
              "," + file(".deno.lock"),
          ),
        ),
        `${dir(".bin", file("run"))},${file(".setup-cache.bin")}`,
      )),
    ),
    [],
  );
});

Deno.test("artifact audit: the versioned appimagetool name is a tool too", () => {
  const t = '[{"Dir":{"n":"node_modules","e":[{"Dir":{"n":".cache","e":' +
    '[{"File":{"n":"appimagetool-x86_64-1.9.1","o":[0,15092216]}}]}}]}}]';
  assertEquals(buildToolHitsIn(vfs(t)), ["appimagetool-x86_64-1.9.1"]);
  assertEquals(needlePackage("appimagetool-x86_64-1.9.1"), "appimagetool");
});

Deno.test("artifact audit: needle → package, so keepPackages silences its own", () => {
  assertEquals(needlePackage("tsc"), "typescript");
  assertEquals(needlePackage("_tsc.js"), "typescript");
  assertEquals(needlePackage("tsserver"), "typescript");
  assertEquals(needlePackage("typescript"), "typescript");
  assertEquals(
    needlePackage("@typescript/typescript-darwin-arm64"),
    "typescript",
  );
  assertEquals(needlePackage("esbuild"), "esbuild");
  assertEquals(needlePackage("@esbuild/linux-x64"), "esbuild");
  assertEquals(needlePackage("appimagetool"), "appimagetool");
  // A hit with no known package maps to itself (nothing is silently unfilterable).
  assertEquals(needlePackage("something-else"), "something-else");
});

Deno.test("artifact audit: streams a real file, even across a chunk seam", async () => {
  const tmp = await tempDir("artifact-audit-");
  try {
    const pad = "A".repeat(20);
    const p = join(tmp, "blob.bin");
    await Deno.writeFile(p, vfs(LEAKY, pad, pad));
    // Every chunk size puts the marker, the prefix and the tree on a seam.
    for (const chunk of [1, 5, 16, 17, 64, 1 << 20]) {
      assertEquals(await scanArtifactForBuildTools(p, chunk), ["typescript"]);
    }
    const clean = join(tmp, "clean.bin");
    await Deno.writeFile(
      clean,
      vfs('[{"Dir":{"n":"src","e":[{"File":{"n":"app.js"}}]}}]', "", pad),
    );
    assertEquals(await scanArtifactForBuildTools(clean, 5), []);
  } finally {
    await dropTempDir(tmp);
  }
});

Deno.test("artifact audit: text that LOOKS like the tree, embedded ahead of it, does not blind the audit", async () => {
  // What a binary carries ahead of its tree when a module's source is embedded
  // un-minified (aio as a remote import): a doc comment spelling the marker —
  // this audit's own, once — and, worse, a complete tree-shaped literal (a
  // test fixture). The first was found first, failed to parse, and the audit
  // answered "clean" for a binary carrying the compiler.
  const lookalikes = ' *     [{"Dir":{"n":"node_modules","e":[\n' +
    ' *         {"Dir":{"n":".deno","e":[ … ]}} ]}}\n' +
    'const fixture = \'[{"File":{"n":"app.ts","o":[0,10]}}]\';\n';
  assertEquals(buildToolHitsIn(vfs(LEAKY, lookalikes)), ["typescript"]);
  const tmp = await tempDir("artifact-audit-");
  try {
    const p = join(tmp, "remote.bin");
    await Deno.writeFile(p, vfs(LEAKY, lookalikes, "tail"));
    for (const chunk of [7, 1 << 20]) {
      assertEquals(await scanArtifactForBuildTools(p, chunk), ["typescript"]);
    }
  } finally {
    await dropTempDir(tmp);
  }
  // …and the module's own source no longer spells a marker anywhere.
  const own = await Deno.readTextFile(
    new URL("../src/build/artifact-audit.ts", import.meta.url),
  );
  for (const kind of ["Dir", "File", "Symlink"]) {
    assert(
      !own.includes(`[{"${kind}":{"n":"`),
      `artifact-audit.ts spells the ${kind} tree marker — it is embedded in ` +
        `binaries and would be found there`,
    );
  }
});

Deno.test("artifact audit: an artifact it cannot read is UNREADABLE, never clean — and the build says so", async () => {
  const enc = new TextEncoder();
  // No tree at all; a tree cut short; a tree with no length in front of it.
  for (
    const bytes of [
      enc.encode("ELF.... tsc esbuild appimagetool"),
      vfs(LEAKY).subarray(0, 60),
      enc.encode("padding!" + LEAKY),
    ]
  ) {
    assertThrows(() => buildToolHitsIn(bytes), ArtifactUnreadable);
  }
  const tmp = await tempDir("artifact-audit-");
  const warned: string[] = [];
  const realWarn = console.warn;
  console.warn = (...a: unknown[]) => void warned.push(a.join(" "));
  try {
    const cut = join(tmp, "cut.bin");
    await Deno.writeFile(cut, vfs(LEAKY, "pad").subarray(0, 60));
    await assertRejects(
      () => scanArtifactForBuildTools(cut, 16),
      ArtifactUnreadable,
      "none complete",
    );
    await assertRejects(
      () => scanArtifactForBuildTools(join(tmp, "missing.bin")),
      Deno.errors.NotFound,
    );
    await warnBuildToolsIn(cut, []);
    assertEquals(warned.length, 1);
    assertStringIncludes(warned[0]!, "audit could not read cut.bin");

    // A readable artifact: a leak is named, a kept package is not — by its
    // family name or by its own.
    const leaky = join(tmp, "leaky.bin");
    await Deno.writeFile(
      leaky,
      vfs(
        '[{"Dir":{"n":"node_modules","e":[{"Dir":{"n":".deno","e":[' +
          '{"Dir":{"n":"@esbuild+linux-x64@0.24.2","e":[' +
          '{"File":{"n":"esbuild","o":[0,10182808]}}]}}]}}]}}]',
      ),
    );
    warned.length = 0;
    await warnBuildToolsIn(leaky, []);
    assertEquals(warned.length, 1);
    assertStringIncludes(warned[0]!, "still embeds build-tool files");
    assertStringIncludes(warned[0]!, "@esbuild/linux-x64");
    // A Windows target: `deno compile --output app` writes `app.exe`. The
    // audit reads that file — it warned "could not read app" on every Windows
    // desktop build.
    await Deno.copyFile(leaky, join(tmp, "win.exe"));
    warned.length = 0;
    await warnBuildToolsIn(join(tmp, "win"), []);
    assertEquals(warned.length, 1);
    assertStringIncludes(warned[0]!, "still embeds build-tool files");
    warned.length = 0;
    await warnBuildToolsIn(leaky, ["esbuild"]);
    await warnBuildToolsIn(leaky, ["@esbuild/linux-x64"]);
    assertEquals(warned, []);
  } finally {
    console.warn = realWarn;
    await dropTempDir(tmp);
  }
});

Deno.test("dev closure drops a peer typescript with NO top-level symlink (§3)", async () => {
  const tmp = await tempDir("peer-ts-");
  try {
    const nm = join(tmp, "node_modules");
    // A real dependency, linked…
    await denoEntryFile(nm, "immer@10.2.0", "immer", "index.js");
    await link(nm, "immer", "immer@10.2.0", "immer");
    // …and `typescript` + its platform package, present on disk but reached only
    // as PEER deps: NO `node_modules/typescript` symlink (a field report).
    await denoEntryFile(nm, "typescript@6.0.3", "typescript", "lib/tsc");
    await denoEntryFile(
      nm,
      "@typescript+typescript-darwin-arm64@7.0.2",
      "@typescript/typescript-darwin-arm64",
      "lib/tsc",
    );
    await denoEntryFile(nm, "esbuild@0.24.2", "esbuild", "bin/esbuild");
    // What "a peer of immer" IS on disk: the sibling link deno writes into the
    // dependent's own node_modules. Without it this fixture proved the exclude
    // LIST and nothing about the binary — deno follows the link and re-embeds
    // the package the list names.
    const sibling = join(nm, ".deno/immer@10.2.0/node_modules/typescript");
    const siblingTarget = "../../typescript@6.0.3/node_modules/typescript";
    await linkDir(siblingTarget, sibling);

    let excluded: string[] = [];
    let linkedDuring = true;
    await withDevExcluded(nm, async (e) => {
      excluded = e;
      linkedDuring = await exists(sibling);
      return true;
    });
    assert(
      !linkedDuring,
      "the peer's sibling link must be aside for the compile",
    );
    assertEquals(
      await Deno.readLink(sibling),
      linkText(siblingTarget, sibling),
      "…and back after",
    );
    for (
      const entry of [
        "typescript@6.0.3",
        "@typescript+typescript-darwin-arm64@7.0.2",
        "esbuild@0.24.2",
      ]
    ) {
      assert(
        excluded.some((e) => e.endsWith(entry)),
        `${entry} must be dropped by name, got: ${excluded.join(", ")}`,
      );
    }
    assert(
      !excluded.some((e) => e.endsWith("immer@10.2.0")),
      "a real dependency must never be excluded",
    );
  } finally {
    await dropTempDir(tmp);
  }
});

Deno.test("dev closure holds non-runtime files aside and restores them (§4)", async () => {
  const tmp = await tempDir("trim-");
  try {
    const nm = join(tmp, "node_modules");
    const map = await denoEntryFile(
      nm,
      "immer@10.2.0",
      "immer",
      "dist/index.js.map",
    );
    const decl = await denoEntryFile(
      nm,
      "immer@10.2.0",
      "immer",
      "dist/index.d.ts",
    );
    const fixture = await denoEntryFile(
      nm,
      "immer@10.2.0",
      "immer",
      "test/fixtures/proving_key.bin",
      "FIXTURE",
    );
    await link(nm, "immer", "immer@10.2.0", "immer");

    let sawTrimmed = false;
    await withDevExcluded(nm, async () => {
      sawTrimmed = !(await exists(map)) && !(await exists(fixture));
      return true;
    });
    assert(sawTrimmed, "maps and fixtures must be gone during the compile");
    // Restored afterwards — and `.d.ts` was never touched (the compile checks).
    assert(await exists(map), "the map must come back");
    assert(await exists(fixture), "the fixture dir must come back");
    assert(await exists(decl), "a .d.ts must never be trimmed");
  } finally {
    await dropTempDir(tmp);
  }
});

Deno.test("dev closure excludes aio's own node_modules/.cache (§5)", async () => {
  const tmp = await tempDir("toolcache-");
  try {
    const nm = join(tmp, "node_modules");
    await denoEntryFile(nm, "immer@10.2.0", "immer", "index.js");
    await link(nm, "immer", "immer@10.2.0", "immer");
    const stale = join(nm, ".cache", "appimagetool");
    await Deno.mkdir(join(stale, ".."), { recursive: true });
    await Deno.writeTextFile(stale, "STALE-TOOL");

    let excluded: string[] = [];
    await withDevExcluded(nm, (e) => {
      excluded = e;
      return Promise.resolve(true);
    });
    assert(
      excluded.some((e) => e.endsWith(join(".cache"))),
      `the tool cache must be excluded, got: ${excluded.join(", ")}`,
    );
    assert(
      !(await exists(stale)),
      "the legacy bare appimagetool is removed on sight",
    );
  } finally {
    await dropTempDir(tmp);
  }
});

Deno.test("dev closure restores a mirror left by a KILLED build (§4)", async () => {
  const tmp = await tempDir("trim-crash-");
  try {
    const nm = join(tmp, "node_modules");
    await Deno.mkdir(join(nm, ".deno"), { recursive: true });
    // A build that died mid-window: the file is under .aio/trim, the journal
    // still names it, and `.deno` is missing it. The rel is relative to
    // `node_modules/.deno` (as `collectTrim` produces).
    const rel = "immer@10.2.0/node_modules/immer/dist/index.js.map";
    const mirrorFile = join(tmp, ".aio", "trim", rel);
    await Deno.mkdir(join(mirrorFile, ".."), { recursive: true });
    await Deno.writeTextFile(mirrorFile, "MAP");
    await Deno.writeTextFile(
      join(tmp, ".aio", "trim-journal.json"),
      JSON.stringify([rel]),
    );
    const target = join(nm, ".deno", rel);
    assert(!(await exists(target)), "precondition: the file was moved out");

    await withDevExcluded(nm, () => Promise.resolve(true));
    assert(await exists(target), "the next build must put it back");
    assert(
      !(await exists(join(tmp, ".aio", "trim-journal.json"))),
      "the journal is consumed",
    );
  } finally {
    await dropTempDir(tmp);
  }
});

Deno.test("build.keepPackages: absent → [], valid parsed, bad shapes refused", async () => {
  const tmp = await tempDir("keep-decl-");
  try {
    assertEquals(await keepPackagesDeclared(tmp), []);

    await Deno.writeTextFile(
      join(tmp, "deno.json"),
      JSON.stringify({ build: { keepPackages: ["typescript", " esbuild "] } }),
    );
    assertEquals(await keepPackagesDeclared(tmp), ["typescript", "esbuild"]);

    await Deno.writeTextFile(
      join(tmp, "deno.json"),
      JSON.stringify({ build: { keepPackages: "typescript" } }),
    );
    await assertRejects(
      () => keepPackagesDeclared(tmp),
      Error,
      "must be an array",
    );

    await Deno.writeTextFile(
      join(tmp, "deno.json"),
      JSON.stringify({ build: { keepPackages: [""] } }),
    );
    await assertRejects(
      () => keepPackagesDeclared(tmp),
      Error,
      "non-empty package name",
    );
  } finally {
    await dropTempDir(tmp);
  }
});
