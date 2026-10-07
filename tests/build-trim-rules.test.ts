// The compile-window trim (§4) — WHAT may be held aside. A field report: a
// library keeps runtime code in `_esm/actions/test/`, the trim took any
// directory named `test` at any depth, and the binary booted, passed its
// `--version` smoke, and died `ERR_MODULE_NOT_FOUND` on first use. The name
// alone is not evidence; these pin the rule that replaced it, and each guard
// the rule leans on (recovery is `build-trim-recovery.test.ts`, the exclude
// set `build-trim-excludes.test.ts`).
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  collectTrim,
  isTrimmedDir,
  isTrimmedFile,
  reachedDenoRels,
  withDevExcluded,
} from "../src/build/build-compile.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { linkDir, linkFile } from "./symlink-helper.ts";

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
async function link(nm: string, entry: string, pkg: string): Promise<void> {
  await Deno.mkdir(join(nm, pkg, ".."), { recursive: true });
  await linkDir(`.deno/${entry}/node_modules/${pkg}`, join(nm, pkg));
}

/** Which of `paths` exist DURING the compile window. */
async function seenDuring(
  nm: string,
  paths: string[],
  keepPackages: string[] = [],
): Promise<boolean[]> {
  let seen: boolean[] = [];
  await withDevExcluded(
    nm,
    async () => {
      seen = await Promise.all(paths.map(exists));
      return true;
    },
    undefined,
    keepPackages,
  );
  return seen;
}

Deno.test("trim: a license or notice is never docs; a .d.ts is never trimmed", () => {
  for (const n of ["index.js.map", "README.md", "CHANGELOG.markdown"]) {
    assert(isTrimmedFile(n), n);
  }
  for (
    const n of [
      "LICENSE.md",
      "License.markdown",
      "LICENCE.md",
      "LICENSE-MIT.md",
      "NOTICE.md",
      "COPYING.md",
      "AUTHORS.md",
      "PATENTS.md",
      "index.d.ts",
      "index.js",
    ]
  ) assert(!isTrimmedFile(n), n);
});

Deno.test("trim: test/tests only directly under a package root, __tests__ anywhere, never a package root", () => {
  const yes = [
    "immer@10.2.0/node_modules/immer/test",
    "immer@10.2.0/node_modules/immer/tests",
    "@noble+curves@1.4.0/node_modules/@noble/curves/test",
    "immer@10.2.0/node_modules/immer/__tests__",
    "immer@10.2.0/node_modules/immer/src/deep/__tests__",
    // a package bundled inside another keeps its own suite the same way
    "a@1.0.0/node_modules/a/node_modules/b/test",
  ];
  const no = [
    // runtime code in a directory that happens to be called `test`
    "viem@2.21.0/node_modules/viem/_esm/actions/test",
    "viem@2.21.0/node_modules/viem/_cjs/tests",
    // packages NAMED like a trim dir
    "test@3.3.0/node_modules/test",
    "@playwright+test@1.50.0/node_modules/@playwright/test",
    "tests@1.0.0/node_modules/tests",
    "__tests__@1.0.0/node_modules/__tests__",
    "a@1.0.0/node_modules/a/node_modules/test",
    "a@1.0.0/node_modules/a/node_modules/@scope/test",
    // not a trim dir at all
    "immer@10.2.0/node_modules/immer/dist",
    "immer@10.2.0/node_modules/immer/testing",
  ];
  for (const r of yes) assert(isTrimmedDir(r), `must trim ${r}`);
  for (const r of no) assert(!isTrimmedDir(r), `must keep ${r}`);
});

Deno.test("trim: a package named test, a scoped one, and runtime code under …/test/ survive the window", async () => {
  const tmp = await tempDir("trim-rule-");
  try {
    const nm = join(tmp, "node_modules");
    const kept = [
      await denoEntryFile(nm, "test@3.3.0", "test", "index.js"),
      await denoEntryFile(
        nm,
        "@playwright+test@1.50.0",
        "@playwright/test",
        "index.js",
      ),
      await denoEntryFile(nm, "viem@2.21.0", "viem", "_esm/actions/test/a.js"),
      await denoEntryFile(nm, "viem@2.21.0", "viem", "_esm/index.js"),
      await denoEntryFile(nm, "viem@2.21.0", "viem", "LICENSE.md"),
      await denoEntryFile(nm, "viem@2.21.0", "viem", "_types/index.d.ts"),
    ];
    const gone = [
      await denoEntryFile(nm, "viem@2.21.0", "viem", "test/fixture.bin"),
      await denoEntryFile(nm, "viem@2.21.0", "viem", "_esm/__tests__/a.js"),
      await denoEntryFile(nm, "viem@2.21.0", "viem", "_esm/index.js.map"),
      await denoEntryFile(nm, "viem@2.21.0", "viem", "README.md"),
    ];
    await link(nm, "test@3.3.0", "test");
    await link(nm, "@playwright+test@1.50.0", "@playwright/test");
    await link(nm, "viem@2.21.0", "viem");

    const seen = await seenDuring(nm, [...kept, ...gone]);
    assertEquals(seen, [
      ...kept.map(() => true),
      ...gone.map(() => false),
    ]);
    for (const p of [...kept, ...gone]) assert(await exists(p), p);
  } finally {
    await dropTempDir(tmp);
  }
});

Deno.test("trim: a build.keepPackages package is left whole", async () => {
  const tmp = await tempDir("trim-keep-");
  try {
    const nm = join(tmp, "node_modules");
    const a = [
      await denoEntryFile(nm, "a@1.0.0", "a", "test/helper.js"),
      await denoEntryFile(nm, "a@1.0.0", "a", "index.js.map"),
    ];
    const b = await denoEntryFile(nm, "b@1.0.0", "b", "index.js.map");
    await link(nm, "a@1.0.0", "a");
    await link(nm, "b@1.0.0", "b");
    assertEquals(await seenDuring(nm, [...a, b], ["a"]), [true, true, false]);
    assertEquals(await seenDuring(nm, [...a, b]), [false, false, false]);
  } finally {
    await dropTempDir(tmp);
  }
});

Deno.test("trim: an excluded package is not walked — its files never move", async () => {
  const tmp = await tempDir("trim-skiptop-");
  try {
    const nm = join(tmp, "node_modules");
    await denoEntryFile(nm, "immer@10.2.0", "immer", "index.js");
    await link(nm, "immer@10.2.0", "immer");
    // typescript is `--exclude`d whole; moving its docs out would only churn
    // thousands of renames for a directory deno never reads.
    const md = await denoEntryFile(
      nm,
      "typescript@5.6.3",
      "typescript",
      "README.md",
    );
    assertEquals(await seenDuring(nm, [md]), [true]);
  } finally {
    await dropTempDir(tmp);
  }
});

Deno.test("trim: AIO_SKIP_TRIM=1 holds nothing aside", async () => {
  const tmp = await tempDir("trim-skip-");
  try {
    const nm = join(tmp, "node_modules");
    const map = await denoEntryFile(nm, "a@1.0.0", "a", "index.js.map");
    await link(nm, "a@1.0.0", "a");
    Deno.env.set("AIO_SKIP_TRIM", "1");
    assertEquals(await seenDuring(nm, [map]), [true]);
    Deno.env.delete("AIO_SKIP_TRIM");
    assertEquals(await seenDuring(nm, [map]), [false]);
  } finally {
    Deno.env.delete("AIO_SKIP_TRIM");
    await dropTempDir(tmp);
  }
});

Deno.test("trim: a symlink is neither moved nor followed", async () => {
  const tmp = await tempDir("trim-symlink-");
  try {
    const nm = join(tmp, "node_modules");
    const outside = join(tmp, "outside");
    await Deno.mkdir(join(outside, "test"), { recursive: true });
    await Deno.writeTextFile(join(outside, "README.md"), "outside");
    await Deno.writeTextFile(join(outside, "test", "a.js"), "outside");
    await denoEntryFile(nm, "a@1.0.0", "a", "index.js");
    const pkg = join(nm, ".deno", "a@1.0.0", "node_modules");
    await linkDir(outside, join(pkg, "linked"));
    await linkFile(join(outside, "README.md"), join(pkg, "a", "R.md"));
    await linkDir(join(outside, "test"), join(pkg, "a", "test"));
    await link(nm, "a@1.0.0", "a");
    assertEquals(
      await seenDuring(nm, [
        join(outside, "README.md"),
        join(outside, "test", "a.js"),
        join(pkg, "a", "R.md"),
        join(pkg, "a", "test"),
      ]),
      [true, true, true, true],
    );
  } finally {
    await dropTempDir(tmp);
  }
});

Deno.test("trim: the mirror is OUTSIDE node_modules (deno embeds node_modules whole)", async () => {
  const tmp = await tempDir("trim-mirror-");
  try {
    const nm = join(tmp, "node_modules");
    await denoEntryFile(nm, "a@1.0.0", "a", "only-this-one.js.map");
    await link(nm, "a@1.0.0", "a");
    const find = async (dir: string): Promise<string[]> => {
      const out: string[] = [];
      for await (const e of Deno.readDir(dir)) {
        const p = join(dir, e.name);
        if (e.isDirectory) out.push(...await find(p));
        else if (e.name === "only-this-one.js.map") out.push(p);
      }
      return out;
    };
    let inNm: string[] = [], inAio: string[] = [];
    await withDevExcluded(nm, async () => {
      inNm = await find(nm);
      inAio = await find(join(tmp, ".aio"));
      return true;
    });
    assertEquals(inNm, []);
    assertEquals(inAio.length, 1);
  } finally {
    await dropTempDir(tmp);
  }
});

Deno.test("trim: nothing the module graph loads is held aside, whatever its name", async () => {
  const tmp = await tempDir("trim-reached-");
  try {
    const deno = join(tmp, "node_modules", ".deno");
    const nm = join(tmp, "node_modules");
    const run = await denoEntryFile(nm, "x@1.0.0", "x", "test/run.js");
    const doc = await denoEntryFile(nm, "x@1.0.0", "x", "GUIDE.md");
    await denoEntryFile(nm, "x@1.0.0", "x", "tests/fixture.bin");
    await denoEntryFile(nm, "x@1.0.0", "x", "OTHER.md");

    const reached = reachedDenoRels([{
      modules: [
        { kind: "esm", local: run },
        { kind: "esm", local: doc },
        { kind: "esm", local: join(tmp, "main.ts") }, // not under .deno
        { kind: "npm", npmPackage: "x@1.0.0" }, // no file
      ],
    }], deno);
    assertEquals(reached, [
      "x@1.0.0/node_modules/x/test/run.js",
      "x@1.0.0/node_modules/x/GUIDE.md",
    ]);
    assertEquals(
      (await collectTrim(deno, [], "", undefined, reached)).sort(),
      ["x@1.0.0/node_modules/x/OTHER.md", "x@1.0.0/node_modules/x/tests"],
    );
    // …and without the graph both go (the guard is what kept them).
    assertEquals((await collectTrim(deno, [])).length, 4);
  } finally {
    await dropTempDir(tmp);
  }
});

Deno.test("trim: a test directory its OWN package names is not held aside — a literal require/import, package.json exports; a computed path is not seen", async () => {
  const tmp = await tempDir("trim-own-refs-");
  try {
    const nm = join(tmp, "node_modules");
    const put = (pkg: string, rel: string, body = "x") =>
      denoEntryFile(nm, `${pkg}@1.0.0`, pkg, rel, body);
    // CJS: the graph has ONE entry for the package, and no file of it.
    await put("a", "index.js", `module.exports = require("./test/helper.js");`);
    await put("b", "lib/deep/x.mjs", `import h from "../../tests/h.mjs";`);
    await put(
      "c",
      "package.json",
      JSON.stringify({
        name: "c",
        exports: { "./testing": { default: "./test/index.js" } },
      }),
    );
    await put("f", "src/index.js", "const fx = import(`./__tests__/${n}.js`)");
    const kept = [
      await put("a", "test/helper.js"),
      await put("b", "tests/h.mjs"),
      await put("c", "test/index.js"),
      await put("f", "src/__tests__/fx.js"),
    ];
    // Named only by a path built at run time, or only by the suite itself:
    // nothing a build can read says the package loads it.
    await put("d", "index.js", `exports.load = (n) => require("./te" + n);`);
    await put("e", "index.js", `module.exports = 1;`);
    await put("e", "test/a.js", `require("./b.js"); require("../test/b.js");`);
    const gone = [
      await put("d", "test/h.js"),
      await put("e", "test/b.js"),
      // …and a kept directory is walked like any other: its docs still go.
      await put("a", "test/README.md"),
    ];
    for (const p of "abcdef") await link(nm, `${p}@1.0.0`, p);

    assertEquals(await seenDuring(nm, [...kept, ...gone]), [
      ...kept.map(() => true),
      ...gone.map(() => false),
    ]);
    for (const p of [...kept, ...gone]) assert(await exists(p), p);
  } finally {
    await dropTempDir(tmp);
  }
});

Deno.test("trim: a file the app imports from INSIDE an npm package is reached — the graph names it by specifier, not by path", async () => {
  const tmp = await tempDir("trim-npm-subpath-");
  try {
    const deno = join(tmp, "node_modules", ".deno");
    const nm = join(tmp, "node_modules");
    await denoEntryFile(nm, "x@1.0.0", "x", "test/run.js");
    await denoEntryFile(nm, "@s+y@2.0.0", "@s/y", "tests/fixture.bin");
    const reached = reachedDenoRels([{
      modules: [
        {
          kind: "npm",
          specifier: "npm:/x@1.0.0/test/run.js",
          npmPackage: "x@1.0.0",
        },
        // the package itself: no file named
        { kind: "npm", specifier: "npm:/@s/y@2.0.0", npmPackage: "@s/y@2.0.0" },
      ],
      npmPackages: {
        "x@1.0.0": { localPath: join(deno, "x@1.0.0", "node_modules", "x") },
        "@s/y@2.0.0": {
          localPath: join(deno, "@s+y@2.0.0", "node_modules", "@s", "y"),
        },
      },
    }], deno);
    assertEquals(reached, ["x@1.0.0/node_modules/x/test/run.js"]);
    assertEquals(await collectTrim(deno, [], "", undefined, reached), [
      "@s+y@2.0.0/node_modules/@s/y/tests",
    ]);
  } finally {
    await dropTempDir(tmp);
  }
});
