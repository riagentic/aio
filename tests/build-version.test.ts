/**
 * THE app version: `major.minor.<commit count>`, derived from the code.
 *
 * One fact, one decider: `major.minor` is written by hand in deno.json, the
 * build number is the repository's commit count — so two builds of one commit
 * carry one version, a new commit bumps it, and a dirty tree is VISIBLY dirty
 * (`-dirty.<hash8>` over the dirty paths + contents) in the version and in
 * every artifact's file name. The resolver is pure over injected facts; the
 * naming grammar, the artifact recognition, the publish refusal and the update
 * decision are pinned here for every target kind.
 */
import {
  assert,
  assertEquals,
  assertMatch,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { join } from "@std/path";
import {
  artifactVersion,
  buildVersionFor,
  buildVersionNotes,
  contentHash8,
  installArtifactName,
  parseDeclaredVersion,
  readBuildStamp,
  readTreeFacts,
  resolveBuildVersion,
  resolveRuntimeVersion,
  stripVersionToken,
  type TreeFacts,
  unpublishableReason,
  versionedArtifactName,
  writeBuildStamp,
} from "../src/build/build-version.ts";
import { androidVersion } from "../src/build/build-android.ts";
import { compileArgs } from "../src/build/build-compile.ts";
import { isArtifactName, placedName } from "../src/testing/internal.ts";
import { compareVersions, decide } from "../src/server/updates-core.ts";
import { buildShipManifest } from "../src/build/ship.ts";
import { PLATFORMS } from "../src/build/platforms.ts";

const clean: TreeFacts = {
  repo: true,
  count: 345,
  commit: "abcdef12",
  hash: null,
};
const dirty: TreeFacts = { ...clean, hash: "9f3ac2b1" };
const nogit: TreeFacts = {
  repo: false,
  count: 0,
  commit: null,
  hash: "4e1d0c77",
};

// ── the resolver ────────────────────────────────────────────────────────────

Deno.test("build-version: a clean tree is major.minor.<commit count>", () => {
  assertEquals(resolveBuildVersion("1.2", clean), {
    version: "1.2.345",
    base: "1.2",
    build: 345,
    commit: "abcdef12",
    dirty: false,
    source: "derived",
  });
  // Deterministic: the same facts twice are the same version — pinned as
  // the literal, not as a self-comparison.
  const twice = resolveBuildVersion("1.2", clean).version;
  assertEquals(twice, "1.2.345");
  // A new commit bumps it — nothing else does.
  assertEquals(
    resolveBuildVersion("1.2", { ...clean, count: 346 }).version,
    "1.2.346",
  );
});

Deno.test("build-version: a dirty tree is visibly dirty, and orders BELOW the clean build", () => {
  const v = resolveBuildVersion("1.2", dirty);
  assertEquals(v.version, "1.2.345-dirty.9f3ac2b1");
  assertEquals(v.dirty, true);
  assertEquals(v.build, 345);
  // SemVer: a prerelease orders below the release of the same core — a dirty
  // build is never "newer" than the clean build of its count.
  assert(compareVersions("1.2.345-dirty.9f3ac2b1", "1.2.345") < 0);
  assert(compareVersions("1.2.345-dirty.9f3ac2b1", "1.2.344") > 0);
});

Deno.test("build-version: no repository → build 0, -nogit.<tree hash>", () => {
  const v = resolveBuildVersion("1.2", nogit);
  assertEquals(v, {
    version: "1.2.0-nogit.4e1d0c77",
    base: "1.2",
    build: 0,
    commit: null,
    dirty: false,
    source: "nogit",
  });
  const notes = buildVersionNotes(v);
  assertEquals(notes.length, 1);
  assertStringIncludes(notes[0]!, "no git repository");
  assertStringIncludes(notes[0]!, "git init");
});

Deno.test("build-version: no declared version defaults to 0.1, and says so once", () => {
  for (const declared of [undefined, "", "   "]) {
    const v = resolveBuildVersion(declared, clean);
    assertEquals(v.version, "0.1.345");
    assertEquals(v.source, "default");
    const notes = buildVersionNotes(v);
    assertEquals(notes.length, 1);
    assertStringIncludes(notes[0]!, '"version": "0.1"');
  }
  // …and a clean derived version has NOTHING to say.
  assertEquals(buildVersionNotes(resolveBuildVersion("1.2", clean)), []);
});

Deno.test("build-version: a three-part version is PINNED — verbatim, with the one-line note", () => {
  const v = resolveBuildVersion("1.0.0", dirty);
  assertEquals(v.version, "1.0.0");
  assertEquals(v.source, "pinned");
  assertEquals(v.base, "1.0");
  assertEquals(v.build, 0);
  assertEquals(v.dirty, true, "the manifest still records the dirty fact");
  assertEquals(buildVersionNotes(v), [
    `version 1.0.0 is pinned by deno.json — the build number is not derived; ` +
    `write "1.0" to let aio number builds from commits`,
  ]);
});

Deno.test("build-version: anything that is neither M.m nor M.m.p is refused by name", () => {
  for (const bad of ["1", "1.2.3.4", "v1.2", "1.2-rc1", "1.2.3-alpha", "abc"]) {
    assertThrows(
      () => parseDeclaredVersion(bad),
      Error,
      JSON.stringify(bad),
      `${bad} must be refused, naming itself`,
    );
  }
  assertThrows(() => parseDeclaredVersion(12), Error, "12");
  // Leading zeros normalise; whitespace is trimmed.
  assertEquals(parseDeclaredVersion(" 01.2 "), { kind: "base", base: "1.2" });
});

// ── the dirty hash ──────────────────────────────────────────────────────────

Deno.test("build-version: the same dirty content twice hashes the same; a different edit never collides", async () => {
  const enc = (s: string) => new TextEncoder().encode(s);
  const a = await contentHash8([
    { path: "src/app.ts", bytes: enc("x = 1") },
    { path: "README.md", bytes: enc("hi") },
  ]);
  const same = await contentHash8([
    { path: "README.md", bytes: enc("hi") }, // order-independent
    { path: "src/app.ts", bytes: enc("x = 1") },
  ]);
  assertEquals(a, same);
  assertMatch(a, /^[0-9a-f]{8}$/);
  const edited = await contentHash8([
    { path: "src/app.ts", bytes: enc("x = 2") },
    { path: "README.md", bytes: enc("hi") },
  ]);
  assert(edited !== a, "a different edit must be a different version");
  const deleted = await contentHash8([
    { path: "src/app.ts", bytes: null },
    { path: "README.md", bytes: enc("hi") },
  ]);
  assert(deleted !== a && deleted !== edited);
});

// ── the real reader, on a real repository ───────────────────────────────────

async function git(dir: string, ...args: string[]): Promise<void> {
  const r = await new Deno.Command("git", {
    args: ["-C", dir, ...args],
    stdout: "null",
    stderr: "piped",
  }).output();
  if (r.code !== 0) throw new Error(new TextDecoder().decode(r.stderr));
}

async function repo(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "aio-build-version-" });
  await git(dir, "init", "-q");
  await git(dir, "config", "user.email", "t@example.com");
  await git(dir, "config", "user.name", "t");
  await git(dir, "config", "commit.gpgsign", "false");
  await Deno.writeTextFile(join(dir, ".gitignore"), ".aio/\ndist/\n");
  await Deno.writeTextFile(join(dir, "a.ts"), "export const a = 1;\n");
  await git(dir, "add", "-A");
  await git(dir, "commit", "-q", "-m", "one");
  return dir;
}

Deno.test("build-version: readTreeFacts — commits count, edits dirty, the build's own outputs never do", async () => {
  const dir = await repo();
  try {
    const one = await readTreeFacts(dir);
    assertEquals(one.repo, true);
    assertEquals(one.count, 1);
    assertEquals(one.hash, null, "a fresh commit is clean");
    assertMatch(one.commit ?? "", /^[0-9a-f]{8}$/);

    // The stamp and dist/ are the build's own outputs — writing them must
    // not turn a clean build dirty (they are gitignored by the scaffold, and
    // excluded by the reader regardless).
    await Deno.mkdir(join(dir, ".aio"));
    await Deno.writeTextFile(join(dir, ".aio", "build-version.json"), "{}");
    await Deno.mkdir(join(dir, "dist"));
    await Deno.writeTextFile(join(dir, "dist", "app.js"), "x");
    assertEquals((await readTreeFacts(dir)).hash, null);

    // A tracked edit dirties; the same edit twice is the same hash.
    await Deno.writeTextFile(join(dir, "a.ts"), "export const a = 2;\n");
    const d1 = await readTreeFacts(dir);
    const d2 = await readTreeFacts(dir);
    assertMatch(d1.hash ?? "", /^[0-9a-f]{8}$/);
    assertEquals(d1.hash, d2.hash);
    // An UNTRACKED, non-ignored file is dirty too — a build that quietly
    // ignored the file you forgot to `git add` would name itself clean.
    await Deno.writeTextFile(join(dir, "b.ts"), "export const b = 1;\n");
    const d3 = await readTreeFacts(dir);
    assert(d3.hash !== d1.hash);

    // An UNTRACKED deno.lock is the toolchain's (the first `deno task` writes
    // it) — not dirty. A TRACKED one that changes is.
    await Deno.remove(join(dir, "b.ts"));
    await Deno.writeTextFile(join(dir, "a.ts"), "export const a = 1;\n");
    await Deno.writeTextFile(join(dir, "deno.lock"), "{}");
    assertEquals((await readTreeFacts(dir)).hash, null, "untracked deno.lock");
    await git(dir, "add", "deno.lock");
    await git(dir, "commit", "-q", "-m", "lock");
    await Deno.writeTextFile(join(dir, "deno.lock"), "{ }");
    assert((await readTreeFacts(dir)).hash !== null, "changed tracked lock");
    await Deno.writeTextFile(join(dir, "deno.lock"), "{}");
    await Deno.writeTextFile(join(dir, "a.ts"), "export const a = 2;\n");
    await Deno.writeTextFile(join(dir, "b.ts"), "export const b = 1;\n");

    // Commit → clean again, count +1.
    await git(dir, "add", "-A");
    await git(dir, "commit", "-q", "-m", "two");
    const two = await readTreeFacts(dir);
    assertEquals(two.count, 3);
    assertEquals(two.hash, null);
    assert(two.commit !== one.commit);

    // The whole path: THE resolver over THE reader.
    const { bv, fromFleet } = await buildVersionFor(dir, "1.2");
    assertEquals(fromFleet, false);
    assertEquals(bv.version, "1.2.3");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("build-version: readTreeFacts without a repository hashes the project tree", async () => {
  const dir = await Deno.makeTempDir({ prefix: "aio-nogit-" });
  try {
    await Deno.writeTextFile(join(dir, "a.ts"), "1");
    const t1 = await readTreeFacts(dir);
    assertEquals(t1.repo, false);
    assertEquals(t1.count, 0);
    assertMatch(t1.hash ?? "", /^[0-9a-f]{8}$/);
    assertEquals((await readTreeFacts(dir)).hash, t1.hash);
    await Deno.writeTextFile(join(dir, "a.ts"), "2");
    assert((await readTreeFacts(dir)).hash !== t1.hash);
    const { bv } = await buildVersionFor(dir, undefined);
    assertEquals(bv.version, `0.1.0-nogit.${(await readTreeFacts(dir)).hash}`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("build-version: the fleet's answer is used verbatim by its children (one resolution per run)", async () => {
  const handed = resolveBuildVersion("3.4", clean);
  const { bv, fromFleet } = await buildVersionFor("/nonexistent", "9.9", {
    env: JSON.stringify(handed),
  });
  assertEquals(fromFleet, true);
  assertEquals(bv, handed);
});

// ── the stamp + the runtime twin ────────────────────────────────────────────

Deno.test("build-version: the stamp the build writes is the version the runtime reports", async () => {
  const dir = await Deno.makeTempDir({ prefix: "aio-stamp-" });
  try {
    const bv = resolveBuildVersion("1.2", dirty);
    const path = await writeBuildStamp(dir, bv, "aio-test");
    assertEquals(path, join(dir, ".aio", "build-version.json"));
    const stamp = readBuildStamp(new URL(`file://${dir}/`));
    assertEquals(stamp?.version, "1.2.345-dirty.9f3ac2b1");
    assertEquals(stamp?.aio, "aio-test");
    // Compiled → the stamp wins over whatever deno.json says now.
    assertEquals(
      resolveRuntimeVersion({
        declared: "1.2",
        compiled: true,
        stamp,
        tree: null,
      }),
      "1.2.345-dirty.9f3ac2b1",
    );
    // From source → derived, the same rule the build uses.
    assertEquals(
      resolveRuntimeVersion({
        declared: "1.2",
        compiled: false,
        stamp,
        tree: clean,
      }),
      "1.2.345",
    );
    assertEquals(readBuildStamp(new URL("file:///nonexistent/")), null);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("build-version: `deno compile` embeds the stamp", () => {
  const args = compileArgs({
    hasDist: true,
    workerInclude: [],
    assets: [],
    excludes: [],
    stamp: ".aio/build-version.json",
    out: "o",
    entry: "e",
  });
  const i = args.indexOf(".aio/build-version.json");
  assert(i > 0 && args[i - 1] === "--include", args.join(" "));
});

Deno.test("build-version: a refused deno.json version does not stop a SOURCE run — it reports unknown, in the refusal's words", () => {
  const v = resolveRuntimeVersion({
    declared: "1.0.0-alpha70",
    compiled: false,
    stamp: null,
    tree: clean,
  });
  assertStringIncludes(v, "unknown");
  assertStringIncludes(v, '"1.0.0-alpha70"');
  assertStringIncludes(v, "major.minor");
});

// ── artifact naming: every target kind ──────────────────────────────────────

const V = "1.2.345";
const VD = "1.2.345-dirty.9f3ac2b1";

/** builder output → placed name, per target kind (`myapp` is the binary). */
const GRAMMAR: [string, string][] = [
  ["myapp", "myapp-1.2.345"], // browser / server / cli binary
  ["myapp.service", "myapp-1.2.345.service"],
  ["myapp-x86_64.AppImage", "myapp-1.2.345-x86_64.AppImage"],
  ["myapp-win-x64.zip", "myapp-1.2.345-win-x64.zip"],
  ["myapp.apk", "myapp-1.2.345.apk"],
  ["myapp-client.apk", "myapp-1.2.345-client.apk"],
  ["myapp-unsigned.apk", "myapp-1.2.345-unsigned.apk"],
  ["myapp-client", "myapp-1.2.345-client"], // cli-client
  ["myapp-windows-x64.exe", "myapp-1.2.345-windows-x64.exe"],
  ["myapp-macos-arm64", "myapp-1.2.345-macos-arm64"],
  ["myapp-client-macos-arm64", "myapp-1.2.345-client-macos-arm64"],
  ["myapp-ios-client", "myapp-1.2.345-ios-client"],
  ["aio-client-x86_64.AppImage", "aio-client-1.2.345-x86_64.AppImage"],
];

Deno.test("build-version: the file-name grammar is <name>-<version><rest>, for every target kind", () => {
  for (const [built, placed] of GRAMMAR) {
    assertEquals(versionedArtifactName(built, "myapp", V), placed, built);
    // Idempotent: placing a placed name changes nothing.
    assertEquals(versionedArtifactName(placed, "myapp", V), placed);
    // …and the version reads back out of it.
    assertEquals(artifactVersion(placed, "myapp"), {
      unversioned: built,
      version: V,
    });
  }
  // A dirty version is carried in full — a dirty artifact is visibly dirty.
  assertEquals(
    versionedArtifactName("myapp-client.apk", "myapp", VD),
    "myapp-1.2.345-dirty.9f3ac2b1-client.apk",
  );
  assertEquals(
    artifactVersion("myapp-1.2.345-dirty.9f3ac2b1-client.apk", "myapp")
      ?.version,
    VD,
  );
  assertEquals(
    versionedArtifactName("myapp", "myapp", "1.2.0-nogit.4e1d0c77"),
    "myapp-1.2.0-nogit.4e1d0c77",
  );
  // Not this app's file at all.
  assertEquals(artifactVersion("deno.json", "myapp"), null);
  assertEquals(versionedArtifactName("README.md", "myapp", V), "README.md");
});

Deno.test("build-version: stripVersionToken gives the readers with no binary name the builder's name back", () => {
  for (const [built, placed] of GRAMMAR) {
    assertEquals(stripVersionToken(placed), built, placed);
    assertEquals(stripVersionToken(built), built, "legacy is itself");
  }
  assertEquals(
    stripVersionToken("myapp-1.2.345-dirty.9f3ac2b1-client.apk"),
    "myapp-client.apk",
  );
});

Deno.test("build-version: placedName carries the version after the target label", () => {
  const suffixed = new Set(["cli"]);
  const v = { version: V, binaryName: "myapp" };
  assertEquals(placedName("myapp", "browser", suffixed, v), "myapp-1.2.345");
  assertEquals(placedName("myapp", "cli", suffixed, v), "myapp-1.2.345-cli");
  assertEquals(
    placedName("myapp.service", "cli", suffixed, v),
    "myapp-1.2.345-cli.service",
  );
  assertEquals(
    placedName("myapp-ios-client", "ios-client", new Set(["ios-client"]), v),
    "myapp-1.2.345-ios-client",
  );
  // Without a version (legacy callers) the old rule is untouched.
  assertEquals(placedName("myapp", "cli", suffixed), "myapp-cli");
});

Deno.test("build-version: isArtifactName recognises versioned AND legacy names, rejects the rest", () => {
  for (const [built, placed] of GRAMMAR) {
    assert(isArtifactName(built, "myapp"), `legacy ${built}`);
    assert(isArtifactName(placed, "myapp"), `versioned ${placed}`);
  }
  assert(isArtifactName("myapp-1.2.345-dirty.9f3ac2b1", "myapp"));
  assert(isArtifactName("myapp-1.2.0-nogit.4e1d0c77-windows-x64.exe", "myapp"));
  assert(Object.keys(PLATFORMS).length >= 5, "the platform table");
  for (const p of Object.keys(PLATFORMS)) {
    assert(isArtifactName(`myapp-${V}-${p}`, "myapp"), p);
  }
  // A version alone is not an artifact of another app, and source is never one.
  assertEquals(isArtifactName("otherapp-1.2.345", "myapp"), false);
  assertEquals(isArtifactName("myapp-1.2.345.ts", "myapp"), false);
  assertEquals(isArtifactName("deno.json", "myapp"), false);
  assertEquals(isArtifactName("manifest.json", "myapp"), false);
});

Deno.test("build-version: an APK's versionName is the build version, its versionCode the build number", () => {
  const bv = resolveBuildVersion("1.2", clean);
  assertEquals(androidVersion(bv), { code: 102_000_345, name: "1.2.345" });
  const d = androidVersion(resolveBuildVersion("1.2", dirty));
  assertEquals(d.name, VD);
  assertEquals(d.code, 102_000_345);
});

// ── publishing ──────────────────────────────────────────────────────────────

Deno.test("build-version: a dirty or nogit version is refused for publishing, by name", () => {
  assertEquals(unpublishableReason("1.2.345"), null);
  assertEquals(unpublishableReason("1.0.0"), null);
  const d = unpublishableReason(VD)!;
  assertStringIncludes(d, VD);
  assertStringIncludes(d, "commit first");
  assertStringIncludes(d, "--allow-dirty");
  assertStringIncludes(
    unpublishableReason("1.2.0-nogit.4e1d0c77")!,
    "commit first",
  );
});

Deno.test("build-version: the ship manifest carries version, buildNumber and commit", async () => {
  const m = await buildShipManifest({
    name: "myapp",
    version: "1.2.345",
    buildNumber: 345,
    commit: "abcdef12",
    binary: new Uint8Array([1, 2, 3]),
    sources: [{ content: "export const x = 1;" }],
  });
  assertEquals(m.version, "1.2.345");
  assertEquals(m.buildNumber, 345);
  assertEquals(m.commit, "abcdef12");
  // Omitted fields stay omitted — an older manifest shape is still valid.
  const bare = await buildShipManifest({
    name: "myapp",
    version: "1.0.0",
    binary: new Uint8Array([1]),
    sources: [{ content: "" }],
  });
  assert(!("buildNumber" in bare) && !("commit" in bare));
});

// ── the update decision ─────────────────────────────────────────────────────

Deno.test("build-version: the update check treats major.minor.build as THE newer-build signal; the digest only breaks a tie", async () => {
  const manifestAt = (version: string, byte: number) =>
    buildShipManifest({
      name: "myapp",
      version,
      binary: new Uint8Array([byte]),
      sources: [{ content: "" }],
      target: "binary",
    });
  const ask = async (version: string, byte: number) =>
    decide({
      current: "1.2.345",
      manifest: await manifestAt(version, byte),
      local: {
        schema: 1,
        cells: {},
        installedSha256: (await manifestAt("1.2.345", 1)).sha256,
      },
      canInstall: ["binary"],
    });
  // installed 1.2.345, channel 1.2.346 → offered (the build number is newer).
  assertEquals((await ask("1.2.346", 1)).kind, "offer");
  // channel 1.2.345, DIFFERENT digest → offered (same version, new build).
  const rebuilt = await ask("1.2.345", 2);
  assertEquals(rebuilt.kind, "offer");
  // channel 1.2.345, SAME digest → current.
  assertEquals((await ask("1.2.345", 1)).kind, "current");
  // channel 1.2.344 → not offered.
  assertEquals((await ask("1.2.344", 1)).kind, "current");
  // a dirty build of the same count is a prerelease of it → not offered.
  assertEquals((await ask("1.2.345-dirty.9f3ac2b1", 3)).kind, "current");
});

// ── strict publish, end to end through shipApp ──────────────────────────────

Deno.test("build-version: shipApp refuses a nogit/dirty version by name; --allow-dirty publishes it and says so", async () => {
  const dir = await Deno.makeTempDir({ prefix: "aio-ship-dirty-" });
  const cwd = Deno.cwd();
  const warned: string[] = [];
  const origWarn = console.warn;
  console.warn = (...a: unknown[]) => warned.push(a.map(String).join(" "));
  try {
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({ title: "Dirty", version: "1.2", entry: "src/app.ts" }),
    );
    await Deno.mkdir(join(dir, "src"));
    await Deno.writeTextFile(join(dir, "src", "app.ts"), `fetch("x");`);
    const binaryPath = join(dir, "app.bin");
    await Deno.writeFile(
      binaryPath,
      new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 1, 2, 3]),
    );
    Deno.chdir(dir);
    // No repository → `1.2.0-nogit.<hash8>` → refused, naming the version
    // and the fix.
    const { shipApp } = await import("../src/build/ship.ts");
    const err = await (async () => {
      try {
        await shipApp({ binaryPath, noData: true });
      } catch (e) {
        return e as Error;
      }
      throw new Error("a nogit version was published");
    })();
    assertMatch(err.message, /1\.2\.0-nogit\.[0-9a-f]{8}/);
    assertStringIncludes(err.message, "commit first");
    assertStringIncludes(err.message, "--allow-dirty");
    // The explicit override publishes — and is logged, never silent.
    const m = await shipApp({ binaryPath, noData: true, allowDirty: true });
    assertMatch(m.version, /^1\.2\.0-nogit\.[0-9a-f]{8}$/);
    assertEquals(m.buildNumber, 0);
    assertEquals(m.commit, null);
    assert(
      warned.some((w) => w.includes("--allow-dirty") && w.includes(m.version)),
      `the override must be logged: ${warned.join(" | ")}`,
    );
    // An explicit --version is never second-guessed (a pinned release).
    const pinned = await shipApp({
      binaryPath,
      noData: true,
      version: "1.2.3",
    });
    assertEquals(pinned.version, "1.2.3");
  } finally {
    console.warn = origWarn;
    Deno.chdir(cwd);
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

// ── am fix offers the rewrite of a pinned version ───────────────────────────

Deno.test("build-version: `am fix` offers to rewrite a pinned three-part version to major.minor", async () => {
  const REPO = join(import.meta.dirname!, "..");
  const report = async (version: string) => {
    const dir = await Deno.makeTempDir({ prefix: "aio-fix-version-" });
    try {
      await Deno.mkdir(join(dir, "src"), { recursive: true });
      await Deno.writeTextFile(
        join(dir, "deno.json"),
        JSON.stringify({
          name: "pinned",
          version,
          tasks: { dev: "deno run -A src/app.ts" },
        }),
      );
      await Deno.writeTextFile(
        join(dir, "src", "app.ts"),
        `import { aio } from "aio";\nawait aio.run({ ui: {} });\n`,
      );
      const out = await new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "-A",
          join(REPO, "src", "am.ts"),
          "fix",
          "--dry-run",
          "--json",
        ],
        cwd: dir,
        env: { ...Deno.env.toObject(), AIO_APPS_DIR: dir },
        stdout: "piped",
        stderr: "null",
      }).output();
      const r = JSON.parse(new TextDecoder().decode(out.stdout)) as {
        results: { name: string; outcome: string; note?: string }[];
      };
      return r.results.find((x) => x.name === "app version");
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  };
  const pinned = await report("1.0.0");
  assertEquals(pinned?.outcome, "would-fix");
  assertStringIncludes(pinned?.note ?? "", "pinned by deno.json");
  assertStringIncludes(pinned?.note ?? "", '"1.0"');
  assertEquals((await report("1.0"))?.outcome, "ok");
  const bad = await report("v1.0-rc1");
  assertEquals(bad?.outcome, "manual");
  assertStringIncludes(bad?.note ?? "", "v1.0-rc1");
});

// ── the coordinator's three decisions ───────────────────────────────────────

Deno.test("build-version: the proto hello carries the APP version (additive within v3), parsed and remembered", async () => {
  const {
    parseProtoHello,
    peerHello,
    protoHello,
    rememberPeerHello,
    PROTOCOL_VERSION,
  } = await import("../src/protocol/protocol-version.ts");
  const h = protoHello("1.0.0-alpha70", "1.2.345");
  assertEquals(h.v, PROTOCOL_VERSION);
  assertEquals(h.app, "1.2.345");
  assertEquals(protoHello("x").app, undefined, "absent when not known");
  // Parsed back out of the wire (a JSON round-trip), bounded like `ver`.
  assertEquals(parseProtoHello(JSON.parse(JSON.stringify(h)))?.app, "1.2.345");
  assertEquals(
    parseProtoHello({ v: 3, min: 3, app: "x".repeat(65) })?.app,
    undefined,
  );
  // A peer without it is still a valid hello — additive.
  assertEquals(parseProtoHello({ v: 3, min: 3 }), { v: 3, min: 3 });
  // The browser twin remembers the server's hello so a client can say which
  // build it talks to.
  const { handleControlFrame } = await import(
    "../src/browser/browser-shared.ts"
  );
  assert(
    handleControlFrame(
      { t: "proto", d: h } as never,
      { current: null },
      () => {},
    ),
  );
  assertEquals(peerHello()?.app, "1.2.345");
  rememberPeerHello({ v: 3, min: 3 });
  assertEquals(peerHello()?.app, undefined);
});

Deno.test("build-version: buildNumber and commit are INSIDE the signed manifest core", async () => {
  const { generateSigningKey, manifestCore, verifyShipManifest } = await import(
    "../src/build/ship.ts"
  );
  const keys = await generateSigningKey();
  const binary = new Uint8Array([7, 7, 7]);
  const m = await buildShipManifest({
    name: "myapp",
    version: "1.2.345",
    buildNumber: 345,
    commit: "abcdef12",
    binary,
    sources: [{ content: "" }],
    sign: keys,
  });
  assertStringIncludes(manifestCore(m), '"buildNumber":345');
  assertStringIncludes(manifestCore(m), '"commit":"abcdef12"');
  const ok = await verifyShipManifest(binary, m, { key: keys.publicKey });
  assertEquals(ok.ok, true, JSON.stringify(ok));
  // Editing either in transit breaks the signature, not just the display.
  for (
    const tampered of [{ ...m, buildNumber: 346 }, { ...m, commit: "deadbeef" }]
  ) {
    const r = await verifyShipManifest(binary, tampered, {
      key: keys.publicKey,
    });
    assertEquals(r.ok, false);
    assertStringIncludes(r.reason, "signature invalid");
  }
});

Deno.test("build-version: aio.run({ appVersion }) is RETIRED — refused by name from the registry", async () => {
  const { removalOf, removalMessage, removalsInSource } = await import(
    "../src/state/removals.ts"
  );
  const r = removalOf("aio.run({ appVersion })");
  assertEquals(r.kind, "api");
  assertEquals(r.removedIn, "alpha70");
  assertStringIncludes(r.hint, "deno.json `version`");
  // Findable in an app's source — aiol and `am fix` both point at the line.
  const hits = removalsInSource(
    'await aio.run({ appId: "x", appVersion: "1.0.0" });',
  );
  assertEquals(hits.map((h) => h.removal.key), ["aio.run({ appVersion })"]);
  assertStringIncludes(removalMessage(r, "aio.run"), "am pin");
  // …and the runtime, in dev, throws those words (prod logs the same line
  // and ignores the key — category (b): dev stricter than prod).
  const g = globalThis as Record<string, unknown>;
  const wasDev = g.__aioDev;
  g.__aioDev = true;
  try {
    const { aio } = await import("../mod.ts");
    const err = await (async () => {
      try {
        await aio.run(
          {
            appId: "retired-v",
            appVersion: "1.0.0",
            libraryMode: true,
          } as never,
        );
      } catch (e) {
        return e as Error;
      }
      throw new Error("a retired key booted");
    })();
    assertStringIncludes(err.message, "appVersion");
    assertStringIncludes(err.message, "deno.json `version`");
  } finally {
    g.__aioDev = wasDev;
  }
});

// ── what an artifact is INSTALLED as ────────────────────────────────────────
//
// The version is stamped into artifact FILE names, and the installed file is
// the one thing that must not carry it: a deno-compiled binary takes its
// identity — and therefore its data directory — from its own file name, so
// installing `demo-1.2.345.AppImage` renames the app on every update and
// starts it from empty state. `run.sh` and `run.ps1` ask the build for this
// (`--print-install-name`); nothing parses artifact names in shell.

Deno.test("install name: the version comes OFF the file and the app keeps its name", () => {
  const cases: [string, string, string, string | null][] = [
    // file                                       base            ext          version
    ["dist/demo-1.2.345-x86_64.AppImage", "demo", ".AppImage", "1.2.345"],
    [
      "demo-electron-0.1.1-dirty.a08c7788.AppImage",
      "demo-electron",
      ".AppImage",
      "0.1.1-dirty.a08c7788",
    ],
    ["myapp-0.1.0-nogit.4e1d0c77.exe", "myapp", ".exe", "0.1.0-nogit.4e1d0c77"],
    ["myapp-1.2.345-client.apk", "myapp-client", ".apk", "1.2.345"],
    ["demo-1.2.345", "demo", "", "1.2.345"],
    // A name a pre-versioning build wrote: the arch still comes off, the app
    // keeps every hyphen of its own name (`chat-app` is not `chat`).
    ["chat-app-aarch64.AppImage", "chat-app", ".AppImage", null],
    ["chat-app.exe", "chat-app", ".exe", null],
    ["demo", "demo", "", null],
    // A cross build: platform AND arch come off, but only together.
    ["notes-1.2.345-windows-x64.exe", "notes", ".exe", "1.2.345"],
    ["notes-1.2.345-macos-arm64", "notes", "", "1.2.345"],
    ["notes-1.2.345-win-x64.zip", "notes", ".zip", "1.2.345"],
    // …and never on its own: `my-linux` is an app's name, not a platform.
    ["my-linux-1.2.345", "my-linux", "", "1.2.345"],
    ["my-linux.AppImage", "my-linux", ".AppImage", null],
  ];
  for (const [file, base, ext, version] of cases) {
    assertEquals(installArtifactName(file), { base, ext, version }, file);
  }
  // Windows separators reach it too (run.ps1 hands it a file name).
  assertEquals(
    installArtifactName("C:\\src\\dist\\demo-1.2.345.exe").base,
    "demo",
  );
});

Deno.test("install name: naming an artifact and un-naming it round-trip", () => {
  for (
    const version of ["1.2.345", "0.1.7-dirty.0123abcd", "9.9.0-nogit.deadbeef"]
  ) {
    for (
      const [binary, built] of [
        ["demo", "demo"],
        ["demo", "demo.AppImage"],
        ["chat-app", "chat-app.exe"],
        ["demo", "demo-client.apk"],
      ] as const
    ) {
      const named = versionedArtifactName(built, binary, version);
      const back = installArtifactName(named);
      assertEquals(back.version, version, named);
      // The installed file is the name the builder wrote, version-free.
      assertEquals(`${back.base}${back.ext}`, stripVersionToken(named), named);
      assert(
        !`${back.base}${back.ext}`.includes(version),
        `the installed name still carries the version: ${named}`,
      );
    }
  }
});
