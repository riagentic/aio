// What the two compile paths hand to the compile — observed, not read off the
// source. `buildCli` and `runDenoCompile` each wire the same four things: the
// module graph into the exclude set, the `cli` rule that keeps unreached
// packages, the exclude for a link deno writes mid-compile, and the audit of
// the finished artifact. Each was a line that could be deleted with every
// test green.
//
// The REAL functions run here; only `deno` itself is stood in for (a script
// first on PATH): `deno info` answers with a fixed graph, `deno compile`
// records its argv and writes a file where the binary would be.
import {
  assert,
  assertEquals,
  assertMatch,
  assertStringIncludes,
} from "@std/assert";
import { DELIMITER, join } from "@std/path";
import { buildCli } from "../src/build/build-cli.ts";
import { runDenoCompile } from "../src/build/build-compile.ts";
import type { BuildConfig } from "../src/build/build-config.ts";
import {
  hostPlatform,
  npmSystemOf,
  PLATFORMS,
} from "../src/build/platforms.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { EXE, writeProgram } from "./fake-program-helper.ts";
import { linkDir } from "./symlink-helper.ts";
import { artifact } from "./vfs-fixture.ts";

// A cross target: the artifact is not run here (the stand-in is not a binary).
const PLATFORM = Deno.build.target === PLATFORMS["linux-arm64"]!.triple
  ? "linux"
  : "linux-arm64";

const WIN = "@esbuild+win32-x64@0.24.2";
/** deno's own install state under `.deno`, left out of every binary. */
const INSTALL_STATE = [".deno.lock", ".setup-cache.bin"];

/** A project whose node_modules holds `lib` (imported), `three` and `tsx`
 *  (installed, not imported; `tsx` needs esbuild) and `esbuild`; the graph
 *  also names esbuild's Windows package, which is not installed. */
async function project(
  tmp: string,
  build: Record<string, unknown> = {},
): Promise<{ root: string; nm: string }> {
  const root = join(tmp, "app");
  const nm = join(root, "node_modules");
  const pkg = async (
    entry: string,
    name: string,
    json: Record<string, unknown> = {},
  ) => {
    const dir = join(nm, ".deno", entry, "node_modules", name);
    await Deno.mkdir(dir, { recursive: true });
    await Deno.writeTextFile(
      join(dir, "package.json"),
      JSON.stringify({ name, ...json }),
    );
    await linkDir(`.deno/${entry}/node_modules/${name}`, join(nm, name));
  };
  await pkg("lib@1.0.0", "lib");
  await pkg("three@0.170.0", "three");
  await pkg("esbuild@0.24.2", "esbuild");
  await pkg("tsx@4.0.0", "tsx", { dependencies: { esbuild: "~0.24.0" } });
  await linkDir(
    "../../esbuild@0.24.2/node_modules/esbuild",
    join(nm, ".deno", "tsx@4.0.0", "node_modules", "esbuild"),
  );
  await Deno.writeTextFile(join(root, "main.ts"), "console.log(1);\n");
  await Deno.writeTextFile(
    join(root, "deno.json"),
    JSON.stringify({ build: { minify: false, ...build } }),
  );
  return { root, nm };
}

const NEED = "get-tsconfig@4.0.0";

function graph(
  root: string,
  nm: string,
  reached: string[],
  more: Record<string, string> = {},
): string {
  const at = (entry: string, name: string) => ({
    dependencies: entry.startsWith("tsx@") ? ["esbuild@0.24.2"] : [],
    localPath: join(nm, ".deno", entry, "node_modules", name),
  });
  return JSON.stringify({
    modules: [
      { kind: "esm", local: join(root, "main.ts") },
      ...reached.map((npmPackage) => ({ kind: "npm", npmPackage })),
    ],
    npmPackages: {
      "lib@1.0.0": at("lib@1.0.0", "lib"),
      "three@0.170.0": at("three@0.170.0", "three"),
      "tsx@4.0.0": at("tsx@4.0.0", "tsx"),
      "esbuild@0.24.2": at("esbuild@0.24.2", "esbuild"),
      "@esbuild/win32-x64@0.24.2": at(WIN, "@esbuild/win32-x64"),
      ...Object.fromEntries(
        Object.entries(more).map(([e, name]) => [e, at(e, name)]),
      ),
    },
  });
}

/** What the stand-in `deno` does with its arguments (`F`: the files the test
 *  reads back, prepended by {@linkcode compiledWith}). */
const STAND_IN = String.raw`
const exists = (p) => {
  try {
    Deno.lstatSync(p);
    return true;
  } catch {
    return false;
  }
};
const SEP = Deno.build.os === "windows" ? "\\" : "/";
const base = (p) => p.split(/[\\/]/).pop();
const log = (line) =>
  Deno.writeTextFileSync(F.callsFile, line + "\n", { append: true });
function copyTree(from, to) {
  const st = Deno.lstatSync(from);
  if (st.isSymlink) {
    if (exists(to)) return;
    Deno.symlinkSync(Deno.readLinkSync(from), to, {
      type: Deno.build.os === "windows" ? "junction" : "dir",
    });
  } else if (st.isDirectory) {
    Deno.mkdirSync(to, { recursive: true });
    for (const e of Deno.readDirSync(from)) {
      copyTree(from + SEP + e.name, to + SEP + e.name);
    }
  } else Deno.copyFileSync(from, to);
}
const args = Deno.args;
switch (args[0]) {
  case "info": {
    // One graph per root when the test wrote graph.json.<root's name>.
    const own = F.graphFile + "." + base(args[2] ?? "");
    console.log(Deno.readTextFileSync(exists(own) ? own : F.graphFile));
    break;
  }
  case "install": {
    // The lock it was handed: logged by where it is, kept as it was read,
    // then written to — the way deno records what it resolved.
    let lock = "", line = "install";
    for (const a of args) {
      if (a === "install") continue;
      if (a.startsWith("--lock=")) {
        lock = a.slice(7);
        line += lock.startsWith(Deno.cwd() + SEP)
          ? " --lock=IN-PROJECT"
          : " --lock=COPY";
      } else line += " " + a;
    }
    log(line);
    if (lock) {
      // (A project with no lock yet hands over a path with nothing at it.)
      if (exists(lock)) Deno.copyFileSync(lock, F.seenLock);
      Deno.writeTextFileSync(lock, "resolved\n", { append: true });
    }
    if (exists(F.failFile)) {
      console.error("Download https://registry.example/x.tgz");
      console.error("error: no network");
      console.error("    0: dns error");
      Deno.exit(1);
    }
    // What installing for another system brings: packages the tree lacked.
    if (exists(F.lateDir)) {
      copyTree(F.lateDir, [Deno.cwd(), "node_modules", ".deno"].join(SEP));
    }
    break;
  }
  case "compile": {
    log("compile");
    Deno.writeTextFileSync(F.argvFile, args.join("\n") + "\n");
    args.forEach((a, i) => {
      if (args[i - 1] !== "-o") return;
      if (exists(F.binFile)) Deno.copyFileSync(F.binFile, a);
      else Deno.writeTextFileSync(a, "not a deno binary");
    });
    break;
  }
  default:
    console.error("unexpected: deno " + args.join(" "));
    Deno.exit(1);
}
`;

/** Run `build` with the stand-in `deno` first on PATH. Returns the `.deno`
 *  paths the compile was told to exclude, and what the build warned. */
async function compiledWith(
  tmp: string,
  graphJson: string,
  build: () => Promise<unknown>,
): Promise<
  { excluded: string[]; paths: string[]; warns: string[]; calls: string[] }
> {
  const bin = join(tmp, "bin");
  const argvFile = join(tmp, "argv");
  const callsFile = join(tmp, "calls");
  await Deno.writeTextFile(callsFile, "");
  await Deno.writeTextFile(argvFile, "");
  const failFile = join(tmp, "install-fails");
  const seenLock = join(tmp, "seen-lock");
  const lateDir = join(tmp, "installed-late");
  const binFile = join(tmp, "artifact.bin");
  const graphFile = join(tmp, "graph.json");
  await Deno.mkdir(bin, { recursive: true });
  await Deno.writeTextFile(graphFile, graphJson);
  // The stand-in `deno`: a program on PATH that hands its arguments to
  // `STAND_IN` below, run by the real deno. (It was a shell script — `case`,
  // `cp -R`, `basename` — which Windows cannot run.)
  const standIn = join(tmp, "stand-in-deno.ts");
  await Deno.writeTextFile(
    standIn,
    `const F = ${
      JSON.stringify({
        graphFile,
        callsFile,
        argvFile,
        failFile,
        seenLock,
        lateDir,
        binFile,
      })
    };\n${STAND_IN}`,
  );
  // Once per `tmp` — a second build in it runs the same program. Written
  // again, the write itself failed on Windows now and then (os error 1224, a
  // "user-mapped section": 1 in 1800 on a loaded machine, clearing by itself
  // within a second): a program that has just run cannot be overwritten the
  // moment its exit is reported.
  const fake = join(bin, `deno${EXE}`);
  if (!await Deno.stat(fake).then(() => true, () => false)) {
    await writeProgram(
      fake,
      `#!/bin/sh\nexec "${Deno.execPath()}" run -A --no-config "${standIn}" "$@"\n`,
    );
  }
  const path = Deno.env.get("PATH") ?? "";
  const warn = console.warn, log = console.log, exit = Deno.exit;
  const warns: string[] = [];
  class Exit extends Error {}
  Deno.env.set("PATH", bin + DELIMITER + path);
  console.warn = (...a: unknown[]) => warns.push(a.join(" "));
  console.log = () => {};
  Deno.exit = (code?: number) => {
    throw new Exit(String(code));
  };
  try {
    await build();
  } catch (e) {
    // `buildCli` ends in `Deno.exit(0)`.
    if (!(e instanceof Exit) || e.message !== "0") throw e;
  } finally {
    Deno.env.set("PATH", path);
    console.warn = warn;
    console.log = log;
    Deno.exit = exit;
  }
  // No argv: the build stopped before the compile.
  const argv = (await Deno.readTextFile(argvFile).catch(() => "")).trim()
    .split("\n");
  const paths = argv.filter((_, i) => argv[i - 1] === "--exclude");
  // (`/`-spelled on every OS: what the tests below compare against.)
  const excluded = paths.flatMap((a) =>
    a.replaceAll("\\", "/").split("/.deno/")[1] ?? []
  );
  const calls = (await Deno.readTextFile(callsFile)).trim().split("\n");
  return { excluded: excluded.sort(), paths, warns, calls };
}

const cfg = (root: string, tmp: string) =>
  ({
    root,
    dist: join(root, "dist"),
    binaryName: "app",
    configEntry: "main.ts",
    doElectron: false,
    doHeadless: false,
    doCli: false,
    doRemote: false,
    outDir: join(tmp, "out"),
    platform: PLATFORM,
    targetTriple: PLATFORMS[PLATFORM]!.triple,
  }) as BuildConfig;

const audited = (warns: string[]) =>
  warns.filter((w) => w.includes("the build-tool audit could not read"));

Deno.test({
  name:
    "compile wiring: the app build excludes by graph, excludes the mid-compile link, and audits the artifact",
  async fn() {
    const tmp = await tempDir("compile-wiring-app-");
    try {
      const { root, nm } = await project(tmp);
      const { excluded, paths, warns } = await compiledWith(
        tmp,
        graph(root, nm, ["lib@1.0.0"]),
        async () => assert(await runDenoCompile(cfg(root, tmp))),
      );
      // deno's launchers: the compile writes them again and follows each
      // into a package this list leaves out.
      assert(paths.includes(join(nm, ".bin")), paths.join("\n"));
      assertEquals(excluded, [
        ...INSTALL_STATE,
        WIN,
        "esbuild@0.24.2",
        "node_modules/@esbuild/win32-x64",
        "node_modules/esbuild",
        "node_modules/three",
        "node_modules/tsx",
        "three@0.170.0",
        "tsx@4.0.0",
      ]);
      // `tsx` is left out whole here, so its own link to esbuild is not named.
      // The stand-in artifact is no binary — and the audit says it looked.
      assertEquals(audited(warns).length, 1, warns.join("\n"));
      assertStringIncludes(audited(warns)[0]!, `app-${PLATFORM}`);
      assertEquals(warns.length, 1, warns.join("\n"));

      // The NEXT build of the same project: the cross compile left the
      // platform package installed and linked. The compile writes that link
      // again after it was held aside, so it has to be named just the same.
      const win = join(nm, ".deno", WIN, "node_modules", "@esbuild");
      await Deno.mkdir(join(win, "win32-x64"), { recursive: true });
      await Deno.mkdir(join(nm, ".deno", "node_modules", "@esbuild"), {
        recursive: true,
      });
      await linkDir(
        `../../${WIN}/node_modules/@esbuild/win32-x64`,
        join(nm, ".deno", "node_modules", "@esbuild", "win32-x64"),
      );
      const again = await compiledWith(
        tmp,
        graph(root, nm, ["lib@1.0.0"]),
        async () => assert(await runDenoCompile(cfg(root, tmp))),
      );
      // …and with its only entry left out, the scope directory goes too:
      // embedded empty otherwise.
      assertEquals(
        again.excluded,
        [...excluded, "node_modules/@esbuild"].sort(),
      );
    } finally {
      await dropTempDir(tmp);
    }
  },
});

Deno.test({
  name:
    "compile wiring: the cli build reads the graph but keeps unreached packages, and audits the artifact",
  async fn() {
    const tmp = await tempDir("compile-wiring-cli-");
    try {
      const { root, nm } = await project(tmp);
      const cli = { ...cfg(root, tmp), doCli: true };
      const { excluded, paths, warns } = await compiledWith(
        tmp,
        graph(root, nm, ["lib@1.0.0"]),
        () => buildCli(cli),
      );
      assert(paths.includes(join(nm, ".bin")), paths.join("\n"));
      // `three` and `tsx` stay in; the graph's name rules still apply.
      assertEquals(excluded, [
        ...INSTALL_STATE,
        WIN,
        "esbuild@0.24.2",
        "node_modules/@esbuild/win32-x64",
        "node_modules/esbuild",
        // `tsx` stays in: its own link to the left-out esbuild, by path.
        "tsx@4.0.0/node_modules/esbuild",
      ]);
      assertEquals(audited(warns).length, 1, warns.join("\n"));
      // `tsx` needs esbuild, but this binary never loads `tsx`: not said.
      assertEquals(warns.length, 1, warns.join("\n"));

      // …and said once the binary does reach it.
      const reaching = await compiledWith(
        tmp,
        graph(root, nm, ["lib@1.0.0", "tsx@4.0.0"]),
        () => buildCli(cli),
      );
      const needs = reaching.warns.filter((w) =>
        w.includes("tsx depends on esbuild")
      );
      assertEquals(needs.length, 1, reaching.warns.join("\n"));
      assertStringIncludes(needs[0]!, '"keepPackages": ["esbuild"]');
    } finally {
      await dropTempDir(tmp);
    }
  },
});

Deno.test({
  name:
    "compile wiring: a module under a compile.include DIRECTORY is a graph root — the package only it imports stays in the binary",
  async fn() {
    const tmp = await tempDir("compile-wiring-include-dir-");
    try {
      const { root, nm } = await project(tmp);
      await Deno.writeTextFile(
        join(root, "deno.json"),
        JSON.stringify({
          build: { minify: false },
          compile: { include: ["plugins"] },
        }),
      );
      await Deno.mkdir(join(root, "plugins", "deep"), { recursive: true });
      await Deno.writeTextFile(
        join(root, "plugins", "deep", "a.ts"),
        `import "three";\n`,
      );
      // The entry reaches `lib` alone; the plugin — loaded by a path the
      // entry's graph cannot see, which is why it is included — needs `three`.
      await Deno.writeTextFile(
        join(tmp, "graph.json.a.ts"),
        graph(root, nm, ["three@0.170.0"]),
      );
      const { excluded } = await compiledWith(
        tmp,
        graph(root, nm, ["lib@1.0.0"]),
        async () => assert(await runDenoCompile(cfg(root, tmp))),
      );
      assert(!excluded.includes("three@0.170.0"), excluded.join("\n"));
      assert(!excluded.includes("node_modules/three"), excluded.join("\n"));
      // …and what neither root reaches is still left out.
      assert(excluded.includes("tsx@4.0.0"), excluded.join("\n"));
    } finally {
      await dropTempDir(tmp);
    }
  },
});

const needsEsbuild = (warns: string[], by = "tsx depends") =>
  warns.filter((w) => w.includes(`${by} on esbuild`));

Deno.test({
  name:
    "compile wiring: a package kept by name is asked what it needs though the graph never reaches it — app and cli",
  async fn() {
    const tmp = await tempDir("compile-wiring-kept-");
    try {
      // The second name is esbuild's Windows package: deno lists it in the
      // graph and has not linked it. It is installed, as far as a name goes.
      const { root, nm } = await project(tmp, {
        keepPackages: ["tsx", "@esbuild/win32-x64"],
      });
      // What `tsx` needs to run, linked beside it the way deno installs it.
      const need = join(nm, ".deno", NEED, "node_modules", "get-tsconfig");
      await Deno.mkdir(need, { recursive: true });
      await Deno.writeTextFile(
        join(need, "package.json"),
        JSON.stringify({ dependencies: { esbuild: "~0.24.0" } }),
      );
      await linkDir(
        "../../esbuild@0.24.2/node_modules/esbuild",
        join(nm, ".deno", NEED, "node_modules", "esbuild"),
      );
      await linkDir(
        `../../${NEED}/node_modules/get-tsconfig`,
        join(nm, ".deno", "tsx@4.0.0", "node_modules", "get-tsconfig"),
      );
      const g = graph(root, nm, ["lib@1.0.0"], { [NEED]: "get-tsconfig" });
      const app = await compiledWith(
        tmp,
        g,
        async () => assert(await runDenoCompile(cfg(root, tmp))),
      );
      assert(!app.excluded.includes("tsx@4.0.0"), app.excluded.join(" "));
      assert(!app.excluded.includes(WIN), app.excluded.join(" "));
      assertEquals(
        app.warns.filter((w) => w.includes("build.keepPackages names")),
        [],
      );
      // Kept means able to run: its ordinary dependency ships with it…
      assert(!app.excluded.includes(NEED), app.excluded.join(" "));
      // …an unrelated unreached package still does not.
      assert(app.excluded.includes("three@0.170.0"), app.excluded.join(" "));
      assert(app.excluded.includes("esbuild@0.24.2"), app.excluded.join(" "));
      // Both are loaded where the graph cannot see: both are asked.
      const both = "get-tsconfig, tsx depend";
      assertEquals(
        needsEsbuild(app.warns, both).length,
        1,
        app.warns.join("\n"),
      );
      const cli = await compiledWith(
        tmp,
        g,
        () => buildCli({ ...cfg(root, tmp), doCli: true }),
      );
      assertEquals(
        needsEsbuild(cli.warns, both).length,
        1,
        cli.warns.join("\n"),
      );
    } finally {
      await dropTempDir(tmp);
    }
  },
});

Deno.test({
  name:
    "compile wiring: a graph that cannot be mapped narrows nothing — every embedded dependent is asked",
  async fn() {
    const tmp = await tempDir("compile-wiring-unmapped-");
    try {
      const { root, nm } = await project(tmp);
      // `ghost` is reached but is neither in npmPackages nor on disk.
      const { excluded, warns } = await compiledWith(
        tmp,
        graph(root, nm, ["lib@1.0.0", "ghost@1.0.0"]),
        async () => assert(await runDenoCompile(cfg(root, tmp))),
      );
      assertEquals(
        warns.filter((w) => w.includes("could not map")).length,
        1,
        warns.join("\n"),
      );
      assert(!excluded.includes("tsx@4.0.0"), excluded.join(" "));
      // `tsx` is embedded and the graph cannot say it is never loaded.
      assertEquals(needsEsbuild(warns).length, 1, warns.join("\n"));
    } finally {
      await dropTempDir(tmp);
    }
  },
});

// ── a native package is the target's, or it is left out ────────────────────

/** `npm`'s names for a platform of the table. */
const sysOf = (platform: string) => npmSystemOf(PLATFORMS[platform]!);

Deno.test({
  name:
    "compile wiring: a cross build installs the target's packages first — for the entry's graph, against a COPY of the lock — and leaves the host's native out",
  async fn() {
    const tmp = await tempDir("compile-wiring-native-");
    try {
      const { root, nm } = await project(tmp);
      const native = async (entry: string, name: string, sys: unknown) => {
        const dir = join(nm, ".deno", entry, "node_modules", name);
        await Deno.mkdir(dir, { recursive: true });
        await Deno.writeTextFile(
          join(dir, "package.json"),
          JSON.stringify({ name, ...sys as Record<string, unknown> }),
        );
        // `lib` is what loads it: linked beside it, the way deno installs.
        await linkDir(
          `../../${entry}/node_modules/${name}`,
          join(nm, ".deno", "lib@1.0.0", "node_modules", name),
        );
      };
      const LOCK = `{"version":"5","specifiers":{}}\n`;
      await Deno.writeTextFile(join(root, "deno.lock"), LOCK);
      const lock = () => Deno.readTextFile(join(root, "deno.lock"));
      const installed = () =>
        [...Deno.readDirSync(join(nm, ".deno"))].map((e) => e.name).sort();
      const [host, target] = [sysOf(hostPlatform()), sysOf(PLATFORM)];
      await native("nat-host@1.0.0", "nat-host", {
        os: [host.os],
        cpu: [host.cpu],
      });
      await native("nat-target@1.0.0", "nat-target", {
        os: [target.os],
        cpu: [target.cpu],
      });
      // Left behind by an earlier build for a third system: the link only.
      await linkDir(
        "../../nat-gone@1.0.0/node_modules/nat-gone",
        join(nm, ".deno", "lib@1.0.0", "node_modules", "nat-gone"),
      );
      const g = graph(root, nm, ["lib@1.0.0"], {
        "nat-host@1.0.0": "nat-host",
        "nat-target@1.0.0": "nat-target",
      });
      // What the install adds: the target's packages — one of them
      // for a libc the binary is not built against.
      const late = join(
        tmp,
        "installed-late",
        "nat-late@1.0.0",
        "node_modules",
      );
      await Deno.mkdir(join(late, "nat-late"), { recursive: true });
      await Deno.writeTextFile(
        join(late, "nat-late", "package.json"),
        JSON.stringify({ os: [target.os], cpu: ["s390x"] }),
      );
      // The compile's output, for the audit that follows it: a binary that
      // carries the host's native after all.
      await Deno.writeFile(
        join(tmp, "artifact.bin"),
        artifact({
          "nat-host@1.0.0": JSON.stringify({ os: [host.os], cpu: [host.cpu] }),
          "nat-target@1.0.0": JSON.stringify({ os: [target.os] }),
        }),
      );
      const reached = JSON.parse(g);
      reached.modules.push(
        { kind: "npm", npmPackage: "nat-host@1.0.0" },
        { kind: "npm", npmPackage: "nat-target@1.0.0" },
      );
      const built = await compiledWith(
        tmp,
        JSON.stringify(reached),
        async () => assert(await runDenoCompile(cfg(root, tmp))),
      );
      // Both are reached; one of them cannot run in this binary.
      assert(
        built.excluded.includes("nat-host@1.0.0"),
        built.excluded.join(" "),
      );
      assert(
        !built.excluded.includes("nat-target@1.0.0"),
        built.excluded.join(" "),
      );
      // …its links too, and the dangling one.
      for (const link of ["nat-host", "nat-gone"]) {
        assert(
          built.excluded.includes(`lib@1.0.0/node_modules/${link}`),
          built.excluded.join(" "),
        );
      }
      assert(
        !built.excluded.includes("lib@1.0.0/node_modules/nat-target"),
        built.excluded.join(" "),
      );
      // ONE install, before the compile, and nothing after it: it only adds,
      // so there is nothing of the host's to put back. Scoped to what the
      // binary's roots reach — a bare `deno install` resolves every
      // dependency the config declares and removes the host's packages.
      assertEquals(built.calls.length, 2, built.calls.join("\n"));
      assertMatch(
        built.calls[0]!,
        new RegExp(
          `^install --entrypoint main\\.ts( \\S+)* --os ${target.os} ` +
            `--arch ${target.cpu} --lock=COPY$`,
        ),
      );
      assertEquals(built.calls[1], "compile");
      // The lock it resolved against is the project's, byte for byte — and
      // what it wrote went to the copy.
      assertEquals(await Deno.readTextFile(join(tmp, "seen-lock")), LOCK);
      assertEquals(await lock(), LOCK);
      // Found only once it was installed.
      assert(
        built.excluded.includes("nat-late@1.0.0"),
        built.excluded.join(" "),
      );
      // The app's own modules name the host's native: said before the
      // compile, for the platform being built — the target's is not named.
      assertEquals(built.warns.length, 2, built.warns.join("\n"));
      assertStringIncludes(
        built.warns[0]!,
        `the app imports nat-host, which is built for another system than ${PLATFORM}`,
      );
      // The audit read the artifact FOR ITS PLATFORM.
      assertStringIncludes(
        built.warns[1]!,
        `built for another system than ${PLATFORM} (nat-host)`,
      );

      // The same through the cli build.
      const cli = await compiledWith(
        tmp,
        JSON.stringify(reached),
        () => buildCli({ ...cfg(root, tmp), doCli: true }),
      );
      assert(cli.excluded.includes("nat-host@1.0.0"), cli.excluded.join(" "));
      assertEquals(cli.calls, built.calls);
      assertEquals(
        cli.warns,
        built.warns.map((w) => w.replace("app-", "app-")),
      );

      // An install that fails STOPS the build, in deno's own words: no
      // compile, the lock as it was, and every package still installed.
      const before = installed();
      await Deno.writeTextFile(join(tmp, "install-fails"), "");
      const said: string[] = [];
      const error = console.error;
      console.error = (...a: unknown[]) => void said.push(a.join(" "));
      let ok: unknown;
      const offline = await compiledWith(
        tmp,
        JSON.stringify(reached),
        async () => ok = await runDenoCompile(cfg(root, tmp)),
      ).finally(() => console.error = error);
      assertEquals(ok, false);
      assertEquals(offline.calls.length, 1, offline.calls.join("\n"));
      assertEquals(offline.calls[0], built.calls[0]);
      const why = said.filter((m) => m.includes("could not be installed"));
      assertEquals(why.length, 1, said.join("\n"));
      assertStringIncludes(why[0]!, PLATFORM);
      assertStringIncludes(why[0]!, "error: no network");
      assertStringIncludes(why[0]!, "Nothing was built");
      assertEquals(await lock(), LOCK);
      assertEquals(installed(), before);

      // `"lock": false`: no lock is read, and none is started.
      await Deno.remove(join(tmp, "install-fails"));
      await Deno.remove(join(root, "deno.lock"));
      await Deno.writeTextFile(
        join(root, "deno.json"),
        JSON.stringify({ lock: false, build: { minify: false } }),
      );
      const unlocked = await compiledWith(
        tmp,
        JSON.stringify(reached),
        async () => assert(await runDenoCompile(cfg(root, tmp))),
      );
      assertMatch(unlocked.calls[0]!, / --no-lock$/);
      // A lock somewhere else, by name.
      const PINS = `{"version":"5","specifiers":{"npm:x@1":"1.0.0"}}\n`;
      await Deno.writeTextFile(join(root, "pins.lock"), PINS);
      await Deno.writeTextFile(
        join(root, "deno.json"),
        JSON.stringify({
          lock: { path: "pins.lock" },
          build: { minify: false },
        }),
      );
      const named = await compiledWith(
        tmp,
        JSON.stringify(reached),
        async () => assert(await runDenoCompile(cfg(root, tmp))),
      );
      assertMatch(named.calls[0]!, / --lock=COPY$/);
      assertEquals(await Deno.readTextFile(join(tmp, "seen-lock")), PINS);
      assertEquals(await Deno.readTextFile(join(root, "pins.lock")), PINS);
      assertEquals(
        [...Deno.readDirSync(root)].map((e) => e.name).sort().filter(
          (n) => n.endsWith(".lock"),
        ),
        ["pins.lock"],
      );
    } finally {
      await dropTempDir(tmp);
    }
  },
});

Deno.test({
  name:
    "compile wiring: a host build installs nothing, and still leaves another system's native out",
  async fn() {
    const tmp = await tempDir("compile-wiring-native-host-");
    try {
      const { root, nm } = await project(tmp);
      const dir = join(
        nm,
        ".deno",
        "nat-other@1.0.0",
        "node_modules",
        "nat-other",
      );
      await Deno.mkdir(dir, { recursive: true });
      await Deno.writeTextFile(
        join(dir, "package.json"),
        JSON.stringify({ os: ["aix"], cpu: ["ppc64"] }),
      );
      await linkDir(
        "../../nat-other@1.0.0/node_modules/nat-other",
        join(nm, ".deno", "lib@1.0.0", "node_modules", "nat-other"),
      );
      const g = JSON.parse(
        graph(root, nm, ["lib@1.0.0"], { "nat-other@1.0.0": "nat-other" }),
      );
      g.modules.push({ kind: "npm", npmPackage: "nat-other@1.0.0" });
      const host = hostPlatform();
      const error = console.error;
      console.error = () => {};
      const built = await compiledWith(
        tmp,
        JSON.stringify(g),
        // The stand-in artifact is no program: the host smoke run refuses it
        // after the compile was handed its arguments.
        () =>
          runDenoCompile({
            ...cfg(root, tmp),
            platform: host,
            targetTriple: undefined,
          } as BuildConfig).catch(() => false),
      ).finally(() => console.error = error);
      assert(
        built.excluded.includes("nat-other@1.0.0"),
        built.excluded.join(" "),
      );
      assertEquals(built.calls, ["compile"]);
    } finally {
      await dropTempDir(tmp);
    }
  },
});
