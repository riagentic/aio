// A binary runs on ONE system, and a native npm package is built for one.
//
// What is installed in `node_modules` is the host's native packages, plus
// whatever earlier builds for other platforms left there — and `deno compile`
// embeds what is installed. So a Windows exe built on Linux carried the Linux
// `.node` beside its own, a kept `esbuild` shipped the host's 10 MB binary in
// every cross build, and the same command run twice gave two different
// artifacts. Which package is "the target's" is each package's own claim
// (`os` / `cpu` / `libc` in its package.json, the rule npm installs by): one
// decider, read by the build's exclude list and by the audit of the result.
import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  type NpmSystem,
  npmSystemOf,
  PLATFORMS,
  runsOn,
} from "../src/build/platforms.ts";
import {
  excludedEntries,
  foreignEntries,
  importedForeign,
  siblingLinkExcludes,
} from "../src/build/build-compile.ts";
import {
  ArtifactUnreadable,
  foreignPackagesIn,
  warnBuildToolsIn,
} from "../src/build/artifact-audit.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { artifact } from "./vfs-fixture.ts";

const LINUX: NpmSystem = { os: "linux", cpu: "x64", libc: "glibc" };
const WINDOWS: NpmSystem = { os: "win32", cpu: "x64" };

Deno.test("foreign natives: a platform is the npm system its binary runs on", () => {
  assertEquals(
    Object.fromEntries(
      Object.entries(PLATFORMS).map(([name, p]) => [name, npmSystemOf(p)]),
    ),
    {
      linux: LINUX,
      "linux-arm64": { os: "linux", cpu: "arm64", libc: "glibc" },
      windows: WINDOWS,
      macos: { os: "darwin", cpu: "x64" },
      "macos-arm64": { os: "darwin", cpu: "arm64" },
    },
  );
});

Deno.test("foreign natives: a package runs where its own package.json says — os, cpu and libc", () => {
  const table: Array<[string, Record<string, unknown>, boolean, boolean]> = [
    // what, package.json, on linux/x64/glibc, on win32/x64
    ["states nothing", {}, true, true],
    ["empty lists", { os: [], cpu: [] }, true, true],
    ["the linux build", { os: ["linux"], cpu: ["x64"] }, true, false],
    ["the windows build", { os: ["win32"], cpu: ["x64"] }, false, true],
    ["same os, other cpu", { os: ["linux"], cpu: ["arm64"] }, false, false],
    ["cpu only", { cpu: ["x64"] }, true, true],
    ["cpu only, another", { cpu: ["wasm32"] }, false, false],
    ["two systems", { os: ["linux", "win32"] }, true, true],
    ["a refusal", { os: ["!win32"] }, true, false],
    ["a refusal beside names", { os: ["linux", "!linux"] }, false, false],
    ["any", { os: ["any"], cpu: "any" }, true, true],
    ["a bare string", { os: "linux" }, true, false],
    // libc is a question on Linux only.
    ["glibc", { os: ["linux"], libc: ["glibc"] }, true, false],
    ["musl", { os: ["linux"], cpu: ["x64"], libc: ["musl"] }, false, false],
    ["libc without os", { libc: ["musl"] }, false, true],
    // Not a list of names: states nothing.
    ["junk", { os: 7, cpu: [null], libc: {} }, true, true],
  ];
  assertEquals(
    table.map(([what, pkg]) => [
      what,
      runsOn(pkg, LINUX),
      runsOn(pkg, WINDOWS),
    ]),
    table.map(([what, , linux, windows]) => [what, linux, windows]),
  );
});

Deno.test("foreign natives: the entries on disk that are another system's are found by their package.json", async () => {
  const tmp = await tempDir("foreign-natives-");
  try {
    const pkg = async (entry: string, name: string, json: unknown) => {
      const dir = join(tmp, entry, "node_modules", name);
      await Deno.mkdir(dir, { recursive: true });
      await Deno.writeTextFile(
        join(dir, "package.json"),
        typeof json === "string" ? json : JSON.stringify(json),
      );
      return entry;
    };
    const entries = [
      await pkg("lib@1.0.0", "lib", {}),
      await pkg("@n+x-linux-x64-gnu@1.0.0", "@n/x-linux-x64-gnu", {
        os: ["linux"],
        cpu: ["x64"],
        libc: ["glibc"],
      }),
      await pkg("@n+x-linux-x64-musl@1.0.0", "@n/x-linux-x64-musl", {
        os: ["linux"],
        cpu: ["x64"],
        libc: ["musl"],
      }),
      await pkg("@n+x-win32-x64@1.0.0", "@n/x-win32-x64", { os: ["win32"] }),
      // Says nothing readable: left alone, never guessed at by its name.
      await pkg("broken-win32@1.0.0", "broken-win32", "{ not json"),
      "absent-darwin@1.0.0",
    ];
    assertEquals(
      [...await foreignEntries(tmp, entries, LINUX)].sort(),
      ["@n+x-linux-x64-musl@1.0.0", "@n+x-win32-x64@1.0.0"],
    );
    assertEquals(
      [...await foreignEntries(tmp, entries, WINDOWS)].sort(),
      ["@n+x-linux-x64-gnu@1.0.0", "@n+x-linux-x64-musl@1.0.0"],
    );
  } finally {
    await dropTempDir(tmp);
  }
});

Deno.test("foreign natives: another system's package is left out even where the app keeps the family — only its exact name brings it back", () => {
  const HOST = "@esbuild+linux-x64@0.24.2";
  const TARGET = "@esbuild+win32-x64@0.24.2";
  const NAT = "@n+x-linux-x64-gnu@1.0.0";
  const nmGraph = new Map<string, Set<string>>([
    ["lib@1.0.0", new Set([NAT])],
    [NAT, new Set()],
    ["esbuild@0.24.2", new Set([HOST, TARGET])],
    [HOST, new Set()],
    [TARGET, new Set()],
  ]);
  const left = (keep: string[], foreign: string[] | undefined) =>
    [
      ...excludedEntries({
        nmGraph,
        devRoots: [],
        keepRoots: ["lib@1.0.0", "esbuild@0.24.2"],
        keep: new Set(keep),
        foreign: foreign && new Set(foreign),
      }).excluded,
    ].sort();
  const tools = [HOST, TARGET, "esbuild@0.24.2"].sort();
  // No metadata read: only the name rules — the runtime package stays.
  assertEquals(left([], undefined), tools);
  // A runtime dependency's native for the host, in a Windows build.
  assertEquals(left([], [HOST, NAT]), [...tools, NAT].sort());
  // `esbuild` kept: it ships with the TARGET's binary, not the host's.
  assertEquals(left(["esbuild"], [HOST, NAT]), [HOST, NAT].sort());
  // Named exactly: the app asked for that file, whatever it is built for.
  assertEquals(left(["esbuild", "@esbuild/linux-x64"], [HOST, NAT]), [NAT]);
  assertEquals(left(["@n/x-linux-x64-gnu"], [HOST, NAT]), tools);
});

Deno.test("foreign natives: a kept package's own link to a left-out or removed package is excluded by path", () => {
  const nmGraph = new Map<string, Set<string>>([
    [
      "lib@1.0.0",
      new Set(["nat-linux@1.0.0", "nat-darwin@1.0.0", "dep@1.0.0"]),
    ],
    ["@s+tool@1.0.0", new Set(["@s+tool-linux@1.0.0"])],
    ["nat-linux@1.0.0", new Set()],
    ["@s+tool-linux@1.0.0", new Set(["dep@1.0.0"])],
    ["dep@1.0.0", new Set()],
  ]);
  const excluded = new Set(["nat-linux@1.0.0", "@s+tool-linux@1.0.0"]);
  // An excluded package's own links are not walked; a kept one's link into
  // an excluded package is named.
  assertEquals(siblingLinkExcludes(excluded, nmGraph), [
    "@s+tool@1.0.0/node_modules/@s/tool-linux",
    "lib@1.0.0/node_modules/nat-linux",
  ]);
  // With what is installed known, a link left dangling by an earlier install
  // for another system (`nat-darwin` is not on disk) goes too.
  assertEquals(
    siblingLinkExcludes(excluded, nmGraph, new Set(nmGraph.keys())),
    [
      "@s+tool@1.0.0/node_modules/@s/tool-linux",
      "lib@1.0.0/node_modules/nat-darwin",
      "lib@1.0.0/node_modules/nat-linux",
    ],
  );
});

Deno.test("foreign natives: a package the APP imports that cannot run on the target is named — one only a dependency reaches is not", () => {
  const dep = (written: string, isDynamic?: boolean) => ({
    specifier: written,
    code: { specifier: `npm:${written}@1.0.0` },
    ...(isDynamic ? { isDynamic } : {}),
  });
  const npm = (id: string) => ({
    kind: "npm",
    specifier: `npm:/${id}`,
    npmPackage: id,
  });
  const graph = {
    modules: [
      {
        kind: "esm",
        specifier: "file:///app/src/app.ts",
        dependencies: [
          dep("wrap"),
          dep("@n/x-linux-x64-gnu"),
          dep("late", true),
        ],
      },
      {
        kind: "esm",
        specifier: "file:///app/src/more.ts",
        dependencies: [dep("@n/x-linux-x64-gnu", true), dep("kept-native")],
      },
      ...["wrap", "@n/x-linux-x64-gnu", "late", "kept-native"]
        .map((n) => npm(`${n}@1.0.0`)),
    ],
    npmPackages: {
      // The wrapper lists every system's native; no module names them.
      "wrap@1.0.0": { dependencies: ["wrap-linux@1.0.0", "wrap-win32@1.0.0"] },
      "wrap-linux@1.0.0": {},
      "wrap-win32@1.0.0": {},
      "@n/x-linux-x64-gnu@1.0.0": {
        localPath:
          "/app/node_modules/.deno/@n+x-linux-x64-gnu@1.0.0/node_modules/@n/x-linux-x64-gnu",
      },
      "late@1.0.0": {},
      "kept-native@1.0.0": {},
    },
  };
  const foreign = new Set([
    "wrap-linux@1.0.0",
    "@n+x-linux-x64-gnu@1.0.0",
    "late@1.0.0",
    "kept-native@1.0.0",
  ]);
  assertEquals(importedForeign([graph], foreign, new Set(["kept-native"])), [
    // Imported statically by one module (and dynamically by another).
    { pkg: "@n/x-linux-x64-gnu", static: true },
    // Only ever behind an `import()`.
    { pkg: "late", static: false },
  ]);
  // Nothing is another system's: nothing is said.
  assertEquals(importedForeign([graph], new Set(), new Set()), []);
});

Deno.test("foreign natives: the audit reads each embedded package.json out of the artifact and names another system's package", async () => {
  const packages = {
    "lib@1.0.0": `{"name":"lib"}`,
    "@n+x-win32-x64@1.0.0": `{"os":["win32"],"cpu":["x64"]}`,
    "@n+x-linux-x64-gnu@1.0.0": `{"os":["linux"],"cpu":["x64"]}`,
    "@n+x-linux-x64-musl@1.0.0": `{"os":["linux"],"libc":["musl"]}`,
  };
  const bytes = artifact(packages);
  assertEquals(await foreignPackagesIn(bytes, WINDOWS), [
    "@n/x-linux-x64-gnu",
    "@n/x-linux-x64-musl",
  ]);
  assertEquals(await foreignPackagesIn(bytes, LINUX), [
    "@n/x-linux-x64-musl",
    "@n/x-win32-x64",
  ]);
  // A package.json that is not JSON where one must be: this is not the
  // layout the audit knows, which is never "clean".
  await assertRejects(
    () => foreignPackagesIn(artifact({ "lib@1.0.0": "\u0000\u0001" }), LINUX),
    ArtifactUnreadable,
  );

  // …and the build says it, about the file it just made.
  const tmp = await tempDir("foreign-natives-audit-");
  const warned: string[] = [];
  const warn = console.warn;
  console.warn = (...a: unknown[]) => void warned.push(a.join(" "));
  try {
    const bin = join(tmp, "app.exe");
    await Deno.writeFile(bin, bytes);
    await warnBuildToolsIn(bin, [], "windows");
    assertEquals(warned.length, 1, warned.join("\n"));
    assertStringIncludes(warned[0]!, "built for another system than windows");
    assertStringIncludes(warned[0]!, "@n/x-linux-x64-gnu, @n/x-linux-x64-musl");
    // Keeping the family is not asking for the host's build of it…
    warned.length = 0;
    await warnBuildToolsIn(bin, ["@n/x"], "windows");
    assertEquals(warned.length, 1);
    // …the exact name is.
    warned.length = 0;
    await warnBuildToolsIn(
      bin,
      ["@n/x-linux-x64-gnu", "@n/x-linux-x64-musl"],
      "windows",
    );
    assertEquals(warned, []);
  } finally {
    console.warn = warn;
    await dropTempDir(tmp);
  }
});
