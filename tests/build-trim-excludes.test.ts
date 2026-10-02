// Which packages stay OUT of a compiled binary, and what the build says when
// one of them is needed. A field report: `typescript` was "excluded" and
// shipped anyway — deno followed the sibling link a peer dependency leaves in
// `.deno/<dependent>/node_modules/` and re-embedded the whole compiler, so the
// binary was byte-for-byte the size it had with `build.keepPackages`. The
// exclude SET is a pure function here so every rule in it has a test that
// names it.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  denoEntryNameOf,
  denoEntryOfRel,
  type DenoInfoGraph,
  droppedDependencies,
  droppedWarnings,
  emptiedScopeDirs,
  excludedEntries,
  lateLinkExcludes,
  withDevExcluded,
} from "../src/build/build-compile.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { HEY } from "../src/diagnostics/fmt.ts";

const denoNmPackageNameOf = (e: string) =>
  e.slice(0, e.lastIndexOf("@")).replace("+", "/");

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
  await Deno.symlink(`.deno/${entry}/node_modules/${pkg}`, join(nm, pkg));
}

/** `myapp` depends on `lib`, and `lib` reaches `typescript` through the
 *  sibling link deno writes for a dependency OR a peer — `libPkg` is lib's
 *  package.json, which is the only place the two differ. Returns the link. */
async function libWithTypescript(
  nm: string,
  libPkg: Record<string, unknown>,
): Promise<string> {
  await denoEntryFile(nm, "lib@1.0.0", "lib", "index.js");
  await denoEntryFile(
    nm,
    "lib@1.0.0",
    "lib",
    "package.json",
    JSON.stringify({ name: "lib", version: "1.0.0", ...libPkg }),
  );
  await link(nm, "lib@1.0.0", "lib");
  await denoEntryFile(nm, "typescript@5.6.3", "typescript", "lib/tsc.js");
  const sibling = join(nm, ".deno", "lib@1.0.0", "node_modules", "typescript");
  await Deno.symlink("../../typescript@5.6.3/node_modules/typescript", sibling);
  return sibling;
}

/** One build: the excludes it passed, and what it warned / logged. */
async function built(
  nm: string,
  keepPackages: string[] = [],
  during: () => Promise<void> = () => Promise.resolve(),
): Promise<{ excluded: string[]; warns: string[]; logs: string[] }> {
  const warns: string[] = [], logs: string[] = [];
  const w = console.warn, l = console.log;
  console.warn = (...a: unknown[]) => warns.push(a.join(" "));
  console.log = (...a: unknown[]) => logs.push(a.join(" "));
  let excluded: string[] = [];
  try {
    await withDevExcluded(
      nm,
      async (e) => {
        excluded = e.flatMap((p) => p.split("/.deno/")[1] ?? []);
        await during();
        return true;
      },
      undefined,
      keepPackages,
    );
  } finally {
    console.warn = w;
    console.log = l;
  }
  return { excluded, warns, logs };
}

Deno.test("excludes: a kept package's sibling link into a dropped one is held aside, then restored", async () => {
  const tmp = await tempDir("excl-sibling-");
  try {
    const nm = join(tmp, "node_modules");
    const sibling = await libWithTypescript(nm, {
      peerDependencies: { typescript: ">=4.8.4" },
    });
    let linkedDuring = true;
    const { excluded } = await built(nm, [], async () => {
      linkedDuring = await exists(sibling);
    });
    // …and, on every build, deno's own install state under `.deno`.
    const state = [".setup-cache.bin", ".deno.lock"];
    assertEquals(excluded, [
      "typescript@5.6.3",
      "node_modules/typescript",
      "lib@1.0.0/node_modules/typescript",
      ...state,
    ]);
    assert(!linkedDuring, "deno follows the link and re-embeds the package");
    assertEquals(
      await Deno.readLink(sibling),
      "../../typescript@5.6.3/node_modules/typescript",
    );

    // Asked for by name: neither dropped nor unlinked.
    const kept = await built(nm, ["typescript"], async () => {
      linkedDuring = await exists(sibling);
    });
    assertEquals(kept.excluded, state);
    assert(linkedDuring);
  } finally {
    await dropTempDir(tmp);
  }
});

Deno.test("excludes: a hard dependency OR a required peer on a dropped package warns, naming the package, the dependent and the fix", async () => {
  const tmp = await tempDir("excl-warn-");
  try {
    for (
      const [libPkg, expect] of [
        [{ dependencies: { typescript: "^5" } }, "lib depends on typescript"],
        // 1.0.16 kept a peer; a library that LOADS it now dies at first use,
        // so this is said as loudly as the hard dependency.
        [
          { peerDependencies: { typescript: ">=4.8.4" } },
          "typescript is a required peer of lib",
        ],
        [{
          peerDependencies: { typescript: ">=4.8.4" },
          peerDependenciesMeta: { typescript: { optional: true } },
        }, null],
        [{ optionalDependencies: { typescript: "^5" } }, null],
      ] as const
    ) {
      const nm = join(tmp, Object.keys(libPkg).join("+"), "node_modules");
      await libWithTypescript(nm, libPkg);
      const { warns, logs } = await built(nm);
      const fix = 'deno.json "build": { "keepPackages": ["typescript"] }';
      // Never a plain line: a log scrolls past where a warning is read.
      assertEquals(logs.filter((l) => l.includes("keepPackages")), []);
      if (expect) {
        assertEquals(warns.length, 1, warns.join("\n"));
        assert(warns[0]!.startsWith(HEY), warns[0]);
        assertStringIncludes(warns[0]!, expect);
        assertStringIncludes(warns[0]!, fix);
      } else {
        assertEquals(warns, []);
      }
      // Named in build.keepPackages: kept, so there is nothing to say.
      const kept = await built(nm, ["typescript"]);
      assertEquals(kept.warns, []);
      assertEquals(kept.logs.filter((l) => l.includes("keepPackages")), []);
    }
  } finally {
    await dropTempDir(tmp);
  }
});

Deno.test("excludes: only a KEPT, REACHED dependent's need for a build-only package is asked about", async () => {
  const tmp = await tempDir("excl-dropped-");
  try {
    const nm = join(tmp, "node_modules");
    const denoDir = join(nm, ".deno");
    await libWithTypescript(nm, {
      dependencies: { typescript: "^5", "@types/foo": "^1" },
    });
    // esbuild needs its platform package — both are dropped, nobody is told.
    await denoEntryFile(
      nm,
      "esbuild@0.24.2",
      "esbuild",
      "package.json",
      JSON.stringify({ dependencies: { "@esbuild/linux-x64": "0.24.2" } }),
    );
    const graph = new Map<string, Set<string>>([
      ["lib@1.0.0", new Set(["typescript@5.6.3", "@types+foo@1.0.0"])],
      ["esbuild@0.24.2", new Set(["@esbuild+linux-x64@0.24.2"])],
    ]);
    const excluded = new Set([
      "typescript@5.6.3",
      "@types+foo@1.0.0", // left out as unreached — not a build tool
      "esbuild@0.24.2",
      "@esbuild+linux-x64@0.24.2",
    ]);
    const asked = async (reached?: string[]) =>
      Object.fromEntries(
        await droppedDependencies(
          denoDir,
          graph,
          excluded,
          reached && new Set(reached),
        ),
      );
    const byLib = { typescript: { hard: ["lib"], peer: [] } };
    assertEquals(await asked(), byLib);
    assertEquals(await asked(["lib@1.0.0"]), byLib);
    // A `cli` build embeds packages its binary never loads: what THEY need
    // is not said.
    assertEquals(await asked([]), {});
  } finally {
    await dropTempDir(tmp);
  }
});

Deno.test("excludes: a package the app KEEPS by name, and what it needs, is asked though the graph reaches neither", async () => {
  // The documented reason for build.keepPackages: `tsx` loaded by a computed
  // specifier. It ships with its `get-tsconfig`; the build tools the two
  // need do not — and that has to be said.
  const tmp = await tempDir("excl-kept-unreached-");
  try {
    const nm = join(tmp, "node_modules");
    const pkg = (entry: string, name: string, tool: string) =>
      denoEntryFile(
        nm,
        entry,
        name,
        "package.json",
        JSON.stringify({ dependencies: { [tool]: "*" } }),
      );
    await pkg("tsx@4.19.2", "tsx", "esbuild");
    await pkg("get-tsconfig@4.14.3", "get-tsconfig", "typescript");
    await pkg("other@1.0.0", "other", "typescript");
    const nmGraph = new Map<string, Set<string>>([
      ["tsx@4.19.2", new Set(["esbuild@0.23.1", "get-tsconfig@4.14.3"])],
      ["get-tsconfig@4.14.3", new Set(["typescript@5.6.3"])],
      ["other@1.0.0", new Set(["typescript@5.6.3"])], // embedded, never loaded
      ["esbuild@0.23.1", new Set()],
      ["typescript@5.6.3", new Set()],
    ]);
    const asked = async (keep: string[], reached: string[] = []) => {
      const { excluded, needed } = excludedEntries({
        nmGraph,
        devRoots: [],
        keepRoots: ["tsx@4.19.2", "other@1.0.0"],
        keep: new Set(keep),
      });
      return Object.fromEntries(
        await droppedDependencies(
          join(nm, ".deno"),
          nmGraph,
          excluded,
          new Set([...reached, ...needed]),
        ),
      );
    };
    const byTsx = { esbuild: { hard: ["tsx"], peer: [] } };
    assertEquals(await asked(["tsx"]), {
      ...byTsx,
      typescript: { hard: ["get-tsconfig"], peer: [] },
    });
    assertEquals(await asked([]), {}, "embedded, never loaded: not asked");
    assertEquals(await asked([], ["tsx@4.19.2"]), byTsx);
    assertEquals(await asked(["immer"]), {}, "another name kept");
  } finally {
    await dropTempDir(tmp);
  }
});

Deno.test("excludes: one warning per package — a package the app imports itself is not named twice", () => {
  const graphs: DenoInfoGraph[] = [{
    modules: [
      {
        specifier: "file:///p/src/app.ts",
        dependencies: [{ specifier: "npm:typescript@5.6.3" }],
      },
      { kind: "npm", npmPackage: "typescript@5.6.3" },
    ],
    npmPackages: { "typescript@5.6.3": { dependencies: [] } },
  }];
  const dropped = new Map([["typescript", { hard: ["lib"], peer: [] }]]);
  const o = {
    devRoots: ["typescript@5.6.3"],
    keep: new Set<string>(),
    buildDirHref: "file:///aio/src/build/",
  };
  const both = droppedWarnings({ ...o, graphs, dropped });
  assertEquals(both.length, 1, both.join("\n"));
  assertStringIncludes(both[0]!, "typescript is reachable from the binary");
  // No graph (or one that does not import it): the dependent's word stands.
  const one = droppedWarnings({ ...o, dropped });
  assertEquals(one.length, 1);
  assertStringIncludes(one[0]!, "lib depends on typescript");
});

Deno.test("excludes: a link's .deno entry is found on a Windows host too (backslash paths)", () => {
  assertEquals(
    denoEntryOfRel("typescript@5.6.3/node_modules/typescript"),
    "typescript@5.6.3",
  );
  assertEquals(
    denoEntryOfRel("typescript@5.6.3\\node_modules\\typescript"),
    "typescript@5.6.3",
  );
  assertEquals(
    denoEntryOfRel("@scope+pkg@1.0.0\\node_modules\\@scope\\pkg"),
    "@scope+pkg@1.0.0",
  );
  // The flat fallback dir is not a package entry.
  assertEquals(denoEntryOfRel("node_modules\\typescript"), null);
  assertEquals(denoEntryOfRel("node_modules/typescript"), null);
});

Deno.test("excludes: the link deno writes DURING a cross compile for an excluded package is excluded too — installed or not", () => {
  const WIN = "@esbuild+win32-x64@0.24.2";
  const onDisk = new Map<string, unknown>([
    ["esbuild@0.24.2", 0],
    ["@esbuild+linux-x64@0.24.2", 0],
    ["three@0.170.0", 0],
  ]);
  // The target platform's packages: deno installs them mid-compile and links
  // them into `.deno/node_modules/`, then follows the link.
  assertEquals(
    lateLinkExcludes(new Set(["esbuild@0.24.2", WIN, DARWIN]), onDisk),
    [
      "node_modules/@esbuild/win32-x64",
      "node_modules/@typescript/typescript-darwin-arm64",
      "node_modules/esbuild",
    ],
  );
  // The SECOND cross build of a project: the first one left the platform
  // package installed, its link is held aside — and the compile writes it
  // again. Every Windows and macOS build after the first carried 10 MB of
  // esbuild because only the absent packages were named.
  assertEquals(
    lateLinkExcludes(
      new Set(["esbuild@0.24.2", WIN]),
      new Map([...onDisk, [WIN, 0]]),
    ),
    ["node_modules/@esbuild/win32-x64", "node_modules/esbuild"],
  );
  // Another version of a package that is KEPT: the flat link may be the kept
  // one's, so it is left alone. Two excluded versions name the link once.
  assertEquals(lateLinkExcludes(new Set(["three@0.160.0"]), onDisk), []);
  assertEquals(
    lateLinkExcludes(new Set(["three@0.160.0", "three@0.170.0"]), onDisk),
    ["node_modules/three"],
  );
});

// ── the exclude set, rule by rule ───────────────────────────────────────────
const nmGraph = new Map<string, Set<string>>([
  ["lib@1.0.0", new Set(["typescript@5.6.3"])],
  ["typescript@5.6.3", new Set()],
  ["three@0.170.0", new Set()],
]);
const base = { nmGraph, devRoots: [], keepRoots: ["lib@1.0.0"] };
const local = (entry: string, pkg: string) =>
  `/p/node_modules/.deno/${entry}/node_modules/${pkg}`;
/** `myapp` imports `lib`; `three` and the darwin compiler are in the lockfile
 *  only — the latter not even on disk (deno links it during a cross compile). */
const graphs: DenoInfoGraph[] = [{
  modules: [{ kind: "npm", npmPackage: "lib@1.0.0" }],
  npmPackages: {
    "lib@1.0.0": { dependencies: [], localPath: local("lib@1.0.0", "lib") },
    "three@0.170.0": {
      dependencies: [],
      localPath: local("three@0.170.0", "three"),
    },
    "@typescript/typescript-darwin-arm64@7.0.2": {
      dependencies: [],
      localPath: local(
        "@typescript+typescript-darwin-arm64@7.0.2",
        "@typescript/typescript-darwin-arm64",
      ),
    },
  },
}];
const DARWIN = "@typescript+typescript-darwin-arm64@7.0.2";
const set = (o: Parameters<typeof excludedEntries>[0]) =>
  [...excludedEntries(o).excluded].sort();

Deno.test("excludes: a build-only package with no top-level link is dropped by NAME — unless kept", () => {
  assertEquals(set({ ...base, keep: new Set() }), ["typescript@5.6.3"]);
  assertEquals(set({ ...base, keep: new Set(["typescript"]) }), []);
});

Deno.test("excludes: what no root reaches is dropped — unless kept, or the caller keeps the unreached", () => {
  const keep = new Set<string>();
  assertEquals(set({ ...base, keep, graphs }), [
    DARWIN,
    "three@0.170.0",
    "typescript@5.6.3",
  ]);
  assertEquals(set({ ...base, keep: new Set(["three"]), graphs }), [
    DARWIN,
    "typescript@5.6.3",
  ]);
  // The `cli` targets: the graph is read for its name rules only.
  assertEquals(set({ ...base, keep, graphs, keepUnreached: true }), [
    DARWIN,
    "typescript@5.6.3",
  ]);
});

Deno.test("excludes: a package kept by name keeps everything it needs to run — except a build tool, and what only that needs", () => {
  // `tsx`, loaded by a computed specifier: no root reaches it or its
  // dependencies. Kept alone, it could not load (`get-tsconfig` not found).
  const tree = new Map<string, Set<string>>([
    ["lib@1.0.0", new Set()],
    ["tsx@4.19.2", new Set(["esbuild@0.23.1", "get-tsconfig@4.14.3"])],
    ["get-tsconfig@4.14.3", new Set(["resolve-pkg-maps@1.0.0"])],
    ["resolve-pkg-maps@1.0.0", new Set(["get-tsconfig@4.14.3"])], // a cycle
    ["esbuild@0.23.1", new Set(["tool-helper@1.0.0"])],
    ["tool-helper@1.0.0", new Set()],
    ["three@0.170.0", new Set()],
  ]);
  const reachLib: DenoInfoGraph[] = [{
    modules: [{ kind: "npm", npmPackage: "lib@1.0.0" }],
    npmPackages: Object.fromEntries(
      [...tree.keys()].map((e) => [e, {
        dependencies: [],
        localPath: local(e, e.slice(0, e.lastIndexOf("@"))),
      }]),
    ),
  }];
  const dropped = (keep: string[]) =>
    [
      ...excludedEntries({
        nmGraph: tree,
        devRoots: [],
        keepRoots: ["lib@1.0.0", "tsx@4.19.2"],
        keep: new Set(keep),
        graphs: reachLib,
      }).excluded,
    ].sort();
  // The build tool stays out by name (and is warned about); the package only
  // IT needs is not pulled back in through it.
  const tool = ["esbuild@0.23.1", "three@0.170.0", "tool-helper@1.0.0"];
  assertEquals(dropped(["tsx"]), tool);
  assertEquals(
    dropped([]),
    [...tool, "get-tsconfig@4.14.3", "resolve-pkg-maps@1.0.0", "tsx@4.19.2"]
      .sort(),
  );
  // Named too, the tool comes back with what it needs.
  assertEquals(dropped(["tsx", "esbuild"]), ["three@0.170.0"]);
});

Deno.test("excludes: build.keepPackages wins over EVERY way a package is left out", () => {
  // One row per rule that leaves a package out; each names a package that
  // rule alone would drop. `under@1.0.0` has no top-level link and only the
  // dev-only `happy-dom` links to it — the row that was forgotten.
  const tree = new Map<string, Set<string>>([
    ["lib@1.0.0", new Set(["typescript@5.6.3"])],
    ["happy-dom@17.6.3", new Set(["under@1.0.0"])],
    ["under@1.0.0", new Set(["under-dep@1.0.0", "@types+node@24.0.0"])],
    ["under-dep@1.0.0", new Set()],
    // Types: linked like a dependency, loaded by nothing.
    ["@types+node@24.0.0", new Set(["undici-types@7.18.2"])],
    ["undici-types@7.18.2", new Set()],
    ["typescript@5.6.3", new Set()],
    ["three@0.170.0", new Set()],
  ]);
  const WIN = "@esbuild+win32-x64@0.24.2";
  const at = (e: string) => ({
    dependencies: [],
    localPath: local(e, denoNmPackageNameOf(e)),
  });
  const graphs: DenoInfoGraph[] = [{
    modules: [{ kind: "npm", npmPackage: "lib@1.0.0" }],
    npmPackages: {
      ...Object.fromEntries([...tree.keys()].map((e) => [e, at(e)])),
      "@esbuild/win32-x64@0.24.2": at(WIN), // named by deno, not on disk
    },
  }];
  const left = (keep: string[]) => {
    const excluded = excludedEntries({
      nmGraph: tree,
      devRoots: ["happy-dom@17.6.3"],
      keepRoots: ["lib@1.0.0"],
      keep: new Set(keep),
      graphs,
    }).excluded;
    return [...excluded, ...lateLinkExcludes(excluded, tree)].sort();
  };
  const all = [
    WIN,
    "@types+node@24.0.0",
    "happy-dom@17.6.3",
    "three@0.170.0",
    "typescript@5.6.3",
    "under-dep@1.0.0",
    "under@1.0.0",
    "undici-types@7.18.2",
  ].flatMap((e) => [e, `node_modules/${denoNmPackageNameOf(e)}`]).sort();
  assertEquals(left([]), all);
  // Each entry goes with the flat link deno may write for it mid-compile.
  const without = (...gone: string[]) =>
    all.filter((e) =>
      !gone.some((g) =>
        e === g || e === `node_modules/${denoNmPackageNameOf(g)}`
      )
    );
  assertEquals({
    "the dev-only walk": left(["under"]),
    "a build tool, by name": left(["typescript"]),
    "what no root reaches": left(["three"]),
    "a platform package deno has not linked, and its mid-compile link": left([
      "esbuild",
    ]),
    "the dev-only root itself": left(["happy-dom"]),
    "a types package, when it is the one named": left(["@types/node"]),
  }, {
    // …and what the kept package needs comes with it — never the `@types/*`
    // packages on the way, nor what only they need: nothing loads those.
    "the dev-only walk": without("under@1.0.0", "under-dep@1.0.0"),
    "a build tool, by name": without("typescript@5.6.3"),
    "what no root reaches": without("three@0.170.0"),
    "a platform package deno has not linked, and its mid-compile link": without(
      WIN,
    ),
    "the dev-only root itself": without(
      "happy-dom@17.6.3",
      "under@1.0.0",
      "under-dep@1.0.0",
    ),
    "a types package, when it is the one named": without(
      "@types+node@24.0.0",
      "undici-types@7.18.2",
    ),
  });
});

Deno.test("excludes: a build.keepPackages name no installed package answers to is said — once, naming the key and the name", async () => {
  const tmp = await tempDir("excl-kept-typo-");
  try {
    const nm = join(tmp, "node_modules");
    await libWithTypescript(nm, { peerDependencies: { typescript: "*" } });
    const typo = await built(nm, ["typescript", "typescirpt"]);
    assertEquals(typo.warns.length, 1, typo.warns.join("\n"));
    assert(typo.warns[0]!.startsWith(HEY), typo.warns[0]);
    assertStringIncludes(
      typo.warns[0]!,
      'build.keepPackages names "typescirpt"',
    );
    // No tree to look in (and nothing left out): nothing to say.
    const bare = join(tmp, "bare", "node_modules");
    assertEquals((await built(bare, ["typescirpt"])).warns, []);
  } finally {
    await dropTempDir(tmp);
  }
});

Deno.test("excludes: only a package kept BY NAME is left whole — what it needs is trimmed like any embedded package", async () => {
  const tmp = await tempDir("excl-kept-trim-");
  try {
    const nm = join(tmp, "node_modules");
    const own = await denoEntryFile(nm, "tsx@4.19.2", "tsx", "README.md");
    const dep = await denoEntryFile(
      nm,
      "get-tsconfig@4.14.3",
      "get-tsconfig",
      "README.md",
    );
    await link(nm, "tsx@4.19.2", "tsx");
    await Deno.mkdir(join(nm, ".deno", "tsx@4.19.2", "node_modules"), {
      recursive: true,
    });
    await Deno.symlink(
      "../../get-tsconfig@4.14.3/node_modules/get-tsconfig",
      join(nm, ".deno", "tsx@4.19.2", "node_modules", "get-tsconfig"),
    );
    let during: boolean[] = [];
    await built(nm, ["tsx"], async () => {
      during = [await exists(own), await exists(dep)];
    });
    assertEquals(during, [true, false]);
    assertEquals([await exists(own), await exists(dep)], [true, true]);
  } finally {
    await dropTempDir(tmp);
  }
});

Deno.test("excludes: a build-only package deno has not linked yet is excluded ahead of time — unless kept", () => {
  const keep = new Set<string>();
  assert(!nmGraph.has(DARWIN), "precondition: not on disk");
  assert(set({ ...base, keep, graphs }).includes(DARWIN));
  // `typescript` kept keeps its whole platform family.
  assertEquals(set({ ...base, keep: new Set(["typescript"]), graphs }), [
    "three@0.170.0",
  ]);
});

Deno.test("excludes: an unreadable or unmappable graph is said out loud, never guessed at", () => {
  const keep = new Set<string>();
  // no graph asked for: nothing to map, nothing to say
  assertEquals(excludedEntries({ ...base, keep }).unmapped, false);
  assertEquals(excludedEntries({ ...base, keep, graphs }).unmapped, false);
  // `deno info` failed
  const failed = excludedEntries({ ...base, keep, graphs: null });
  assertEquals(failed.unmapped, true);
  assertEquals([...failed.excluded], ["typescript@5.6.3"]);
  // a reached package with neither a localPath nor a `.deno` entry
  const odd: DenoInfoGraph[] = [{
    modules: [{ kind: "npm", npmPackage: "ghost@1.0.0" }],
    npmPackages: { "ghost@1.0.0": {}, "three@0.170.0": {} },
  }];
  const r = excludedEntries({ ...base, keep, graphs: odd });
  assertEquals(r.unmapped, true);
  assert(!r.excluded.has("three@0.170.0"), "nothing dropped on a guess");
  // …and a caller that keeps the unreached has nothing to map
  assertEquals(
    excludedEntries({ ...base, keep, graphs: null, keepUnreached: true })
      .unmapped,
    false,
  );
});

Deno.test("excludes: deno's own localPath names the directory, not the npm id", () => {
  // A peer-resolved id carries a suffix its directory does not.
  assertEquals(
    denoEntryNameOf(
      "@scope/pkg@5.5.1_typescript@6.0.3",
      local("@scope+pkg@5.5.1", "@scope/pkg"),
    ),
    "@scope+pkg@5.5.1",
  );
  assertEquals(denoEntryNameOf("@scope/pkg@5.5.1"), "@scope+pkg@5.5.1");
});

// Each entry of a scope left out alone, the compile still embeds the
// directory they were in — an empty `node_modules/@esbuild/` in the binary.
Deno.test("excludes: a scope directory whose every entry is left out is left out itself — one that keeps an entry is not", async () => {
  const tmp = await tempDir("excludes-scope-");
  try {
    for (
      const dir of [
        "node_modules/@esbuild/linux-x64",
        "node_modules/@esbuild/win32-x64",
        "node_modules/@n/kept",
        "node_modules/@n/gone",
        "lib@1.0.0/node_modules/@n/gone",
        "node_modules/plain",
      ]
    ) await Deno.mkdir(join(tmp, dir), { recursive: true });
    assertEquals(
      await emptiedScopeDirs(tmp, [
        "@esbuild+linux-x64@0.24.2",
        "node_modules/@esbuild/linux-x64",
        "node_modules/@esbuild/win32-x64",
        "node_modules/@n/gone",
        "lib@1.0.0/node_modules/@n/gone",
        "node_modules/plain",
        // Named, and not on disk: what the compile may put there is unknown.
        "node_modules/@late/x",
      ]),
      ["lib@1.0.0/node_modules/@n", "node_modules/@esbuild"],
    );
    // One entry short of all of them: the directory is not empty.
    assertEquals(
      await emptiedScopeDirs(tmp, ["node_modules/@esbuild/linux-x64"]),
      [],
    );
  } finally {
    await dropTempDir(tmp);
  }
});
