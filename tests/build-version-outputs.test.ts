// A version derived from the tree is an identity of the app's SOURCES. What a
// build wrote is not a source — and it is told apart by WHERE the build put
// it, never by what a directory looks like:
//
//   - `dist/` (the build always stages there) and the out dir of the build
//     that is running, by name. They used to be one OR the other, so with
//     `--out=release` the staging in `dist/` was hashed and an untouched
//     project got a new version on every build.
//   - every other directory a build or a publish of the project wrote to, by
//     the record that command left (`.aio/outputs.json`) — the release under
//     last week's `--out`, the directory `am publish` stages into.
//
// And a path git tracks is source wherever it lies: a tracked folder that
// happens to hold a manifest and the files it lists is not a release.
import { assertEquals, assertNotEquals } from "@std/assert";
import { join } from "@std/path";
import {
  buildVersionFor,
  outputExcludes,
  runtimeTreeFacts,
} from "../src/server/app-version.ts";
import {
  outputEntry,
  OUTPUTS_FILE,
  recordedOutputs,
  recordOutput,
  unsafeOutDir as outputGuard,
} from "../src/server/build-outputs.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { unsafeOutDir } from "../src/testing/internal.ts";

/** Write `files` (path → text) under `dir`. */
async function write(dir: string, files: Record<string, string>) {
  for (const [rel, text] of Object.entries(files)) {
    await Deno.mkdir(join(dir, rel, ".."), { recursive: true });
    await Deno.writeTextFile(join(dir, rel), text);
  }
}

/** A release as the fleet assembles it: the manifest, and what it lists. */
const release = (out: string, n: number): Record<string, string> => ({
  [`${out}/manifest.json`]: JSON.stringify({
    app: "app",
    version: `1.2.${n}`,
    targets: [{
      target: "cli",
      artifacts: [{ file: `app-1.2.${n}` }, { file: `app-1.2.${n}-web` }],
    }],
  }),
  [`${out}/app-1.2.${n}`]: `binary ${n}\n`,
  [`${out}/app-1.2.${n}-web/index.html`]: `site ${n}\n`,
});

/** What one build leaves behind with `--out=<out>`: staging, state, release. */
const built = (out: string, n: number): Record<string, string> => ({
  "dist/app.js": `bundle ${n}\n`,
  "dist/icon.png": `icon ${n}\n`,
  ".aio/build-version.json": `{"n":${n}}\n`,
  ...release(out, n),
});

const version = async (dir: string, out: string | undefined) =>
  (await buildVersionFor(dir, "1.2", { env: "", out })).bv.version;

async function git(dir: string, ...args: string[]) {
  const r = await new Deno.Command("git", {
    args: ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@e.x", ...args],
    stdout: "null",
    stderr: "piped",
  }).output();
  assertEquals(r.code, 0, new TextDecoder().decode(r.stderr));
}

/** A project with one commit. */
async function repo(dir: string, files: Record<string, string> = {}) {
  await write(dir, {
    "deno.json": "{}\n",
    "src/app.ts": "export {};\n",
    ...files,
  });
  await git(dir, "init", "-q", "-b", "main");
  await git(dir, "add", "-A", "-f");
  await git(dir, "commit", "-q", "-m", "first");
}

/** A project with no repository above it. */
async function plain(): Promise<string> {
  // aio-ok: must sit outside every git work tree, which the registry's root is not
  const dir = await Deno.makeTempDir({ prefix: "aio-version-outputs-" });
  await write(dir, { "deno.json": "{}\n", "src/app.ts": "export {};\n" });
  return dir;
}

Deno.test("build outputs: dist/ is one always, and the out dir named inside the project is the other", () => {
  const root = "/p/app";
  const table: Array<[string | undefined, string[]]> = [
    [undefined, ["dist/"]],
    ["dist", ["dist/"]],
    ["release", ["dist/", "release/"]],
    ["out/agent", ["dist/", "out/agent/"]],
    ["/p/app/release", ["dist/", "release/"]],
    // Outside the project there is nothing in the tree to leave out.
    ["/srv/release", ["dist/"]],
    ["../release", ["dist/"]],
  ];
  assertEquals(
    table.map(([out]) => outputExcludes(root, out)),
    table.map(([, want]) => want),
  );
});

Deno.test("build outputs: without a repository, building to an out dir inside the project does not move the version", async () => {
  const dir = await plain();
  try {
    const before = await version(dir, "out2");
    await write(dir, built("out2", 1));
    const afterOne = await version(dir, "out2");
    await write(dir, built("out2", 2));
    assertEquals([afterOne, await version(dir, "out2")], [before, before]);
    assertEquals(before.startsWith("1.2.0-nogit."), true, before);
    // A source run of the project names `build.out` and `dist/`.
    const run = (n: number) =>
      write(dir, built("out2", n)).then(() =>
        runtimeTreeFacts(dir, { version: "1.2", build: { out: "out2" } })
      );
    assertEquals((await run(3)).hash, (await run(4)).hash);
    // A source edit still moves it.
    await write(dir, { "src/app.ts": "export const x = 1;\n" });
    assertNotEquals(await version(dir, "out2"), before);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("build outputs: the record names a directory inside the project, and only that", async () => {
  const root = "/p/app";
  assertEquals(
    ["release", "out/agent/", "/p/app/o1", ".", "/p/app", "..", "../x", "/srv"]
      .map((d) => outputEntry(root, d)),
    ["release/", "out/agent/", "o1/", null, null, null, null, null],
  );

  const dir = await tempDir("aio-outputs-record-");
  try {
    const file = join(dir, OUTPUTS_FILE);
    // No record, and a record that is not one: nothing is recorded — the
    // directories then count, which shows.
    assertEquals(await recordedOutputs(dir), []);
    await write(dir, { [OUTPUTS_FILE]: "{ not json" });
    assertEquals(await recordedOutputs(dir), []);
    // Only a plain `<rel>/` inside the project is an entry.
    await write(dir, {
      [OUTPUTS_FILE]: JSON.stringify(
        ["o1", "../up/", "/abs/", 7, "", "a/b/", "a//c/", "o2/../o3/", "o4/"],
      ),
    });
    assertEquals(await recordedOutputs(dir), ["a/b/", "o4/"]);
    await Deno.remove(file);
    // What the out-dir guard refuses is not written down either.
    for (const no of ["src", "src/gen", ".git", ".aio/x", "dist/x", "."]) {
      await recordOutput(dir, no);
    }
    assertEquals(await Deno.stat(file).then(() => true, () => false), false);

    await Deno.mkdir(join(dir, "o1"));
    await recordOutput(dir, "o1");
    await recordOutput(dir, join(dir, "release")); // not there yet: it will be
    await recordOutput(dir, "/srv/elsewhere");
    await recordOutput(dir, dir);
    assertEquals(await recordedOutputs(dir), ["o1/", "release/"]);
    // Said twice is written once.
    const written = (await Deno.stat(file)).mtime;
    await recordOutput(dir, "release");
    assertEquals((await Deno.stat(file)).mtime, written);
    assertEquals(
      [...Deno.readDirSync(join(dir, ".aio"))].map((e) => e.name),
      ["outputs.json"],
    );
  } finally {
    await dropTempDir(dir);
  }
});

// The out dir of THIS build is named; the one a build last week wrote to
// under another `--out` is not, and neither is where `am publish` stages.
Deno.test("build outputs: without a repository, a recorded output dir is left out — and a folder that only LOOKS like a release is source", async () => {
  const dir = await plain();
  try {
    const before = await version(dir, "o3");
    // Two earlier builds' releases and a publish dir: recorded by the
    // commands that wrote them.
    for (const out of ["o1", "out/agent", "release"]) {
      await recordOutput(dir, out);
    }
    await write(dir, {
      ...release("o1", 1),
      ...release("out/agent", 2),
      "release/prod/linux-x86_64.json": "{}\n",
      "release/prod/app-1.2.2": "binary\n",
    });
    assertEquals(await version(dir, "o3"), before);
    // A source run names no out dir at all.
    const run = async () =>
      (await runtimeTreeFacts(dir, { version: "1.2" })).hash;
    const ran = await run();
    await Deno.remove(join(dir, "o1"), { recursive: true });
    await write(dir, release("o1", 3));
    assertEquals(await run(), ran);

    // The same files where no build put them: a manifest and exactly what it
    // lists, under src/. Source — and an edit in it is a change.
    await write(dir, release("src/bundled", 1));
    const withBundled = await version(dir, "o3");
    assertNotEquals(withBundled, before);
    await write(dir, { "src/bundled/app-1.2.1": "edited\n" });
    assertNotEquals(await version(dir, "o3"), withBundled);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("build outputs: in a repository, a recorded output dir is left out while UNTRACKED — a tracked path is source wherever it lies", async () => {
  const dir = await tempDir("aio-version-outputs-git-");
  try {
    // A tracked folder that looks exactly like a release, and a tracked file
    // inside a directory a build later writes to.
    await repo(dir, {
      ...release("src/bundled", 1),
      "release/NOTES.md": "tracked\n",
    });
    assertEquals(await version(dir, "o3"), "1.2.1");

    // Untracked and not recorded: a look-alike nobody's build wrote counts.
    await write(dir, release("drop", 2));
    const dropped = await version(dir, "o3");
    assertEquals(dropped.startsWith("1.2.1-dirty."), true, dropped);
    await Deno.remove(join(dir, "drop"), { recursive: true });

    // Recorded and untracked: output. Staging in dist/ by name.
    await recordOutput(dir, "o1");
    await recordOutput(dir, "release/prod");
    await write(dir, {
      ...built("o1", 3),
      "release/prod/linux-x86_64.json": "{}\n",
      "release/prod/app-1.2.3": "binary\n",
    });
    assertEquals(await version(dir, "o3"), "1.2.1");

    // The tracked look-alike, edited: a modified tree.
    await write(dir, { "src/bundled/app-1.2.1": "edited\n" });
    const edited = await version(dir, "o3");
    assertEquals(edited.startsWith("1.2.1-dirty."), true, edited);
    await git(dir, "checkout", "-q", "--", "src/bundled");
    assertEquals(await version(dir, "o3"), "1.2.1");

    // A TRACKED file beside a recorded output dir, edited — and deleted.
    await write(dir, { "release/NOTES.md": "changed\n" });
    const tracked = await version(dir, "o3");
    assertEquals(tracked.startsWith("1.2.1-dirty."), true, tracked);
    await Deno.remove(join(dir, "release/NOTES.md"));
    const deleted = await version(dir, "o3");
    assertEquals(deleted.startsWith("1.2.1-dirty."), true, deleted);
    assertNotEquals(deleted, tracked);
  } finally {
    await dropTempDir(dir);
  }
});

// The record is a file in the project: a publish pointed at a source dir wrote
// one, and anyone can. What it names is left out of the version, so it is
// believed only where the build itself would agree to put output.
const GARBLED = (dir: string): unknown[] => [
  ["src/"],
  [join(dir, "src") + "/"],
  ["o1/../src/"],
  ["src/cell.ts"],
  ["src/cell.ts/"],
  ["src"],
  ["./"],
  ["/"],
  ["../"],
  ["src/gen/"],
  ["SRC/"],
  ["apps/"],
  ["apps/web/"],
  ["apps/web/out/"],
  ["lib/"],
  ["notes.txt/"],
  { "src/": true },
  "src/",
];

Deno.test("build outputs: a record naming a source dir, the app's dir, a file or a nested project hides nothing — an edit there still moves the version", async () => {
  const dir = await plain();
  try {
    await write(dir, {
      "deno.json": JSON.stringify({
        build: {
          targets: { web: { kind: "browser", entry: "apps/web/main.ts" } },
        },
      }),
      "src/cell.ts": "export const a = 1;\n",
      "apps/web/main.ts": "export {};\n",
      "lib/deno.json": "{}\n",
      "lib/mod.ts": "export {};\n",
      "notes.txt": "one\n",
    });
    const edits: Record<string, string> = {
      "src/cell.ts": "export const a = 2;\n",
      "apps/web/main.ts": "export const b = 2;\n",
      "lib/mod.ts": "export const c = 2;\n",
      "notes.txt": "two\n",
    };
    const records = GARBLED(dir);
    assertEquals(records.length, 18);
    for (const record of records) {
      await write(dir, { [OUTPUTS_FILE]: JSON.stringify(record) });
      assertEquals(await recordedOutputs(dir), [], JSON.stringify(record));
      for (const [file, text] of Object.entries(edits)) {
        const before = await version(dir, undefined);
        const was = await Deno.readTextFile(join(dir, file));
        await write(dir, { [file]: text });
        assertNotEquals(
          await version(dir, undefined),
          before,
          `${file} edited under the record ${JSON.stringify(record)}`,
        );
        await write(dir, { [file]: was });
      }
    }
    // A deno.json that does not parse names no app dir: nothing is left out.
    await write(dir, { [OUTPUTS_FILE]: '["o1/"]', ...release("o1", 1) });
    assertEquals(await recordedOutputs(dir), ["o1/"]);
    await write(dir, { "deno.json": "{ not json" });
    assertEquals(await recordedOutputs(dir), []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("build outputs: in a repository, an untracked file in a recorded source dir still makes the tree dirty", async () => {
  const dir = await tempDir("aio-version-outputs-git-src-");
  try {
    await repo(dir, { "src/cell.ts": "export const a = 1;\n" });
    assertEquals(await version(dir, undefined), "1.2.1");
    const records = GARBLED(dir);
    assertEquals(records.length, 18);
    for (const record of records) {
      await write(dir, {
        [OUTPUTS_FILE]: JSON.stringify(record),
        "src/extra.ts": "export const e = 1;\n",
      });
      const v = await version(dir, undefined);
      assertEquals(v.startsWith("1.2.1-dirty."), true, JSON.stringify(record));
      await Deno.remove(join(dir, "src/extra.ts"));
      assertEquals(await version(dir, undefined), "1.2.1");
    }
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("build outputs: the reader and the build's --out answer to one guard", () => {
  // The guard moved beside the record; the build's name for it is the same
  // function, not a copy.
  assertEquals(unsafeOutDir, outputGuard);
});

// A record is a claim; the directory is the proof. An out dir later reused for
// source, or a folder somebody wrote into the record, was left out on the
// record's word — and without a repository an edit there changed nothing.
Deno.test("build outputs: a recorded directory is left out only while it holds what a build or a publish put there", async () => {
  const dir = await plain();
  try {
    const moved = async (file: string, why: string) => {
      const before = await version(dir, undefined);
      await write(dir, { [file]: `// ${crypto.randomUUID()}\n` });
      assertNotEquals(await version(dir, undefined), before, why);
    };
    const still = async (files: Record<string, string>, why: string) => {
      const before = await version(dir, undefined);
      await write(dir, files);
      assertEquals(await version(dir, undefined), before, why);
    };
    const record = (...entries: string[]) =>
      write(dir, { [OUTPUTS_FILE]: JSON.stringify(entries) });

    // A flat layout: the entry at the root, a library folder beside it.
    await write(dir, {
      "deno.json": JSON.stringify({ entry: "main.ts" }),
      "main.ts": 'import "./lib/util.ts";\n',
      "lib/util.ts": "export const a = 1;\n",
      "tests/cell.test.ts": "// 1\n",
    });
    await record("dist/", "lib/", "tests/");
    assertEquals(await recordedOutputs(dir), ["dist/"]);
    await moved("lib/util.ts", "a hand-written lib/");
    await moved("tests/cell.test.ts", "a hand-written tests/");

    // The scaffold's layout: the same for tests/ beside src/.
    await write(dir, { "deno.json": "{}\n" });
    await record("tests/");
    await moved("tests/cell.test.ts", "tests/ beside src/");

    // An out dir a build filled: left out, whatever is rebuilt into it.
    await record("o1/", "o2/");
    await write(dir, release("o1", 1));
    assertEquals(await recordedOutputs(dir), ["o1/", "o2/"]);
    await Deno.remove(join(dir, "o1"), { recursive: true });
    await still(release("o1", 2), "a second build into o1/");
    // …with what publish wrote beside the artifacts, and into a channel dir.
    await still({
      "o1/app-1.2.2.ship.json": "{}\n",
      "o1/linux-x86_64.json": "{}\n",
      "o1/prod/linux-x86_64.json": "{}\n",
      "o1/prod/app-1.2.2": "binary\n",
    }, "publish output in o1/");
    // One file no build put there, and the whole directory counts — while it
    // lies there. Gone, the directory is an output again: same record, same
    // version, and a write in between (another build) drops nothing.
    const clean = await version(dir, undefined);
    await moved("o1/notes.md", "a stray file in an out dir");
    assertEquals(await recordedOutputs(dir), ["o2/"]);
    await recordOutput(dir, "o2");
    assertEquals(
      JSON.parse(await Deno.readTextFile(join(dir, OUTPUTS_FILE))),
      ["o1/", "o2/"],
    );
    await Deno.remove(join(dir, "o1/notes.md"));
    assertEquals(await recordedOutputs(dir), ["o1/", "o2/"]);
    assertEquals(await version(dir, undefined), clean);
    // What the desktop drops into a folder somebody opened is nobody's file:
    // the directory stays an output…
    await still({
      "o1/.DS_Store": "finder\n",
      "o1/Thumbs.db": "explorer\n",
      "o1/prod/desktop.ini": "explorer\n",
    }, "desktop litter in an out dir");
    for (const f of ["o1/.DS_Store", "o1/Thumbs.db", "o1/prod/desktop.ini"]) {
      await Deno.remove(join(dir, f));
    }
    // …and it proves nothing: beside source, the folder is source.
    await record("o1/", "o2/", "pile/");
    await write(dir, { "pile/.DS_Store": "finder\n", "pile/a.ts": "// 1\n" });
    await moved("pile/a.ts", "source beside a .DS_Store");
    await Deno.remove(join(dir, "pile"), { recursive: true });
    await record("o1/", "o2/");

    // Emptied and refilled with source: source.
    await Deno.remove(join(dir, "o1"), { recursive: true });
    await still({}, "an out dir that is gone");
    await Deno.mkdir(join(dir, "o1"));
    assertEquals(await recordedOutputs(dir), ["o1/", "o2/"]);
    await write(dir, { "o1/mod.ts": "export {};\n" });
    await moved("o1/mod.ts", "an out dir reused for source");
    // A manifest.json that is not a release's proves nothing.
    await write(dir, { "o1/manifest.json": '{"name":"mine"}\n' });
    await moved("o1/mod.ts", "a folder with somebody's manifest.json");
    // The next write keeps the entry — it is asked again at every read — and
    // drops only what the guard refuses.
    await record("o1/", "o2/", "src/", "o1");
    await recordOutput(dir, "o3");
    assertEquals(
      JSON.parse(await Deno.readTextFile(join(dir, OUTPUTS_FILE))),
      ["o1/", "o2/", "o3/"],
    );

    // A channel dir: the update manifest is the proof — older artifacts lie
    // beside it, listed nowhere.
    await record("release/prod/", "release/");
    await write(dir, {
      "release/prod/linux-x86_64.json": "{}\n",
      "release/prod/app-1.2.1": "old\n",
    });
    assertEquals(await recordedOutputs(dir), ["release/prod/", "release/"]);
    await still({ "release/prod/app-1.2.2": "new\n" }, "the next publish");
    // The publish dir as older records name it: channel dirs, nothing else.
    await record("release/");
    await still({ "release/test/darwin-aarch64.json": "{}\n" }, "a channel");
    await still({ "release/.DS_Store": "finder\n" }, "a look at release/");
    await moved("release/NOTES.md", "a file of the user's in the publish dir");
    await Deno.remove(join(dir, "release/NOTES.md"));
    await write(dir, { "release/drafts/a.md": "x\n" });
    await moved("release/drafts/a.md", "a folder that is no channel");
    await Deno.remove(join(dir, "release/drafts"), { recursive: true });
    // The manifest is a FILE: a folder of that name proves nothing.
    await record("pkg/");
    await write(dir, {
      "pkg/linux-x86_64.json/x.ts": "export {};\n",
      "pkg/mod.ts": "export {};\n",
    });
    await moved("pkg/mod.ts", "a folder named like an update manifest");
    // A channel dir without its manifest is a folder.
    await record("release/prod/");
    await Deno.remove(join(dir, "release/prod/linux-x86_64.json"));
    await moved("release/prod/app-1.2.2", "a channel dir with no manifest");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
