// A version string must never cost an unbounded read — and bounding it must
// not take a version away from an app that had one.
//
// The tree reader behind `-dirty.<hash8>` / `-nogit.<hash8>` was capped after
// a boot hashed an entire home directory. The cap had three defects of its
// own, each pinned here:
//
//   • it was checked AFTER `readFile`, so the one file that crossed it was
//     read whole — a 1 GB file cost 1 GB of RSS to be refused;
//   • it ran for a PINNED version, which prints no hash at all — an app at
//     `"version": "0.1.0"` with one large asset reported `unknown (…)` and
//     its build exited 1;
//   • past the cap it refused outright, where a cheap identity (path, size,
//     mtime — no file opened) still names the tree.
//
// And through all of it the hash of a NORMAL tree must not move: the goldens
// below are the values the 1.0.14 reader produced for these exact fixtures.
import {
  assert,
  assertEquals,
  assertMatch,
  assertNotEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { basename, DELIMITER, fromFileUrl, join } from "@std/path";
import { EXE, writeProgram } from "./fake-program-helper.ts";
import {
  buildVersionFor,
  GIT_STDOUT_MAX_BYTES,
  GIT_TIMEOUT_MS,
  outDirExclude,
  readTreeFacts,
  resolveRuntimeVersion,
  runtimeTreeFacts,
  splitRuntimeVersion,
  TREE_LIST_MAX_FILES,
  TREE_WALK_MAX_BYTES,
  TREE_WALK_MAX_DEPTH,
  TREE_WALK_MAX_DIRS,
  TREE_WALK_MAX_FILES,
  type TreeIo,
  TreeRefusal,
  unresolvedTreeVersion,
} from "../src/server/app-version.ts";
import { spec } from "./module-spec-helper.ts";

const GiB = 1024 * 1024 * 1024;

async function git(dir: string, ...args: string[]): Promise<void> {
  const r = await new Deno.Command("git", {
    args: ["-C", dir, ...args],
    stdout: "null",
    stderr: "piped",
  }).output();
  if (r.code !== 0) throw new Error(new TextDecoder().decode(r.stderr));
}

async function initRepo(dir: string): Promise<void> {
  await git(dir, "init", "-q");
  await git(dir, "config", "user.email", "t@example.com");
  await git(dir, "config", "user.name", "t");
  await git(dir, "config", "commit.gpgsign", "false");
  await Deno.writeTextFile(join(dir, "a.ts"), "export const a = 1;\n");
  await git(dir, "add", "-A");
  await git(dir, "commit", "-q", "-m", "one");
}

/** A file of `bytes` that occupies no disk: a hole. Reading it is the cost
 *  under test; making it is free. */
async function sparse(path: string, bytes: number): Promise<void> {
  await Deno.writeFile(path, new Uint8Array(0));
  await Deno.truncate(path, bytes);
}

/** The real disk, with every read written down — so "it was never read" is an
 *  observation, not an inference from a clock or from RSS. */
function countingIo(): {
  io: TreeIo;
  read: string[];
  probed: string[];
  stats: () => number;
} {
  const read: string[] = [];
  const probed: string[] = [];
  let stats = 0;
  return {
    read,
    probed,
    stats: () => stats,
    io: {
      stat: (p) => {
        stats++;
        return Deno.stat(p);
      },
      readFile: (p) => {
        read.push(basename(p));
        return Deno.readFile(p);
      },
      probe: async (p) => {
        probed.push(basename(p));
        (await Deno.open(p)).close();
      },
    },
  };
}

async function withDir(
  prefix: string,
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  // The SYSTEM temp dir, not the suite's own: half of these cases are about a
  // project with no repository, and that needs a directory with no git work
  // tree anywhere above it.
  // aio-ok: must sit outside every git work tree, which the registry's root is not
  const dir = await Deno.makeTempDir({ prefix });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

// ── the hash of a normal tree did not move ───────────────────────────────────

Deno.test("tree identity: a non-repo tree hashes to the SAME value the 1.0.14 reader gave", async () => {
  await withDir("aio-tree-golden-", async (dir) => {
    await Deno.mkdir(join(dir, "sub", "deep"), { recursive: true });
    await Deno.mkdir(join(dir, "pkg", "node_modules", "y"), {
      recursive: true,
    });
    await Deno.mkdir(join(dir, "node_modules", "x"), { recursive: true });
    await Deno.mkdir(join(dir, ".aio"), { recursive: true });
    await Deno.mkdir(join(dir, "dist"), { recursive: true });
    await Deno.writeTextFile(join(dir, "deno.json"), '{ "version": "1.2" }\n');
    await Deno.writeTextFile(join(dir, "a.ts"), "export const a = 1;\n");
    await Deno.writeTextFile(join(dir, "empty.txt"), "");
    await Deno.writeTextFile(join(dir, "sub", "b.ts"), "export const b = 2;\n");
    await Deno.writeFile(
      join(dir, "sub", "deep", "c.bin"),
      new Uint8Array([0, 1, 2, 253, 254, 255]),
    );
    // A NESTED node_modules is part of the hash (only the root one is
    // excluded) — so it cannot be dropped from the count without moving every
    // such app's version.
    await Deno.writeTextFile(
      join(dir, "pkg", "node_modules", "y", "m.js"),
      "module.exports = 1;\n",
    );
    await Deno.writeTextFile(
      join(dir, "node_modules", "x", "i.js"),
      "ignored\n",
    );
    await Deno.writeTextFile(join(dir, ".aio", "build-version.json"), "{}");
    await Deno.writeTextFile(join(dir, "dist", "app.js"), "built\n");

    const built = await readTreeFacts(dir, {
      excludes: [outDirExclude(dir, undefined)],
    });
    assertEquals(built, {
      repo: false,
      count: 0,
      commit: null,
      hash: "683e0ef5",
    });
    // …and with no out-dir exclude, `dist/` is hashed like any other file.
    assertEquals((await readTreeFacts(dir)).hash, "7133ef20");
    assertEquals(
      (await buildVersionFor(dir, "1.2", { env: "" })).bv.version,
      "1.2.0-nogit.683e0ef5",
    );
  });
});

Deno.test("tree identity: a dirty set (edit, deletion, rename, untracked) hashes to the SAME value the 1.0.14 reader gave", async () => {
  await withDir("aio-tree-golden-git-", async (dir) => {
    await initRepo(dir);
    await Deno.writeTextFile(join(dir, ".gitignore"), ".aio/\ndist/\n");
    await Deno.writeTextFile(join(dir, "b.ts"), "export const b = 1;\n");
    await Deno.writeTextFile(join(dir, "c.ts"), "export const c = 1;\n");
    await git(dir, "add", "-A");
    await git(dir, "commit", "-q", "--amend", "-m", "one");
    await Deno.writeTextFile(join(dir, "a.ts"), "export const a = 2;\n");
    await Deno.remove(join(dir, "b.ts"));
    await git(dir, "mv", "c.ts", "d.ts");
    await Deno.writeTextFile(join(dir, "e.ts"), "export const e = 1;\n");
    await Deno.mkdir(join(dir, "sub"));
    await Deno.writeFile(
      join(dir, "sub", "f.bin"),
      new Uint8Array([9, 8, 7, 0, 255]),
    );
    const t = await readTreeFacts(dir);
    assertEquals(t.repo, true);
    assertEquals(t.count, 1);
    assertEquals(t.hash, "0879573e");
  });
});

// ── the byte cap decides BEFORE the read ─────────────────────────────────────

Deno.test("tree walk: a file past the byte cap is never opened — its size is read from stat", async () => {
  await withDir("aio-tree-sparse-", async (dir) => {
    await Deno.writeTextFile(join(dir, "a.ts"), "export const a = 1;\n");
    await sparse(join(dir, "huge.bin"), 3 * GiB);
    const c = countingIo();
    const t = await readTreeFacts(dir, { io: c.io });
    assertEquals(
      c.read.includes("huge.bin"),
      false,
      "3 GiB must not be read to learn that it is over a 128 MB cap",
    );
    assertEquals(t.repo, false);
    assertMatch(t.hash ?? "", /^[0-9a-f]{8}$/, "the tree still has a version");
    // The cheap identity is an identity: the same tree twice is one hash, and
    // a change to the file nobody read still changes it.
    assertEquals((await readTreeFacts(dir)).hash, t.hash);
    await Deno.truncate(join(dir, "huge.bin"), 3 * GiB + 1);
    assertNotEquals((await readTreeFacts(dir)).hash, t.hash);
  });
});

Deno.test("dirty set: an untracked file past the byte cap is never opened either", async () => {
  await withDir("aio-tree-sparse-git-", async (dir) => {
    await initRepo(dir);
    await Deno.writeTextFile(join(dir, "b.ts"), "export const b = 1;\n");
    await sparse(join(dir, "huge.bin"), 3 * GiB);
    const c = countingIo();
    const t = await readTreeFacts(dir, { io: c.io });
    assertEquals(c.read.includes("huge.bin"), false);
    assertEquals(t.repo, true);
    assertMatch(t.hash ?? "", /^[0-9a-f]{8}$/, "dirty, and named");
    assertEquals((await readTreeFacts(dir)).hash, t.hash);
    assertMatch(
      (await buildVersionFor(dir, "1.2", { env: "" })).bv.version,
      /^1\.2\.1-dirty\.[0-9a-f]{8}$/,
    );
  });
});

// ── one cap per reader, each on its own fixture ──────────────────────────────

Deno.test("tree walk: past the FILE cap nothing more is read, and the tree is still identified", async () => {
  await withDir("aio-tree-files-", async (dir) => {
    for (let i = 0; i < 6; i++) {
      await Deno.writeTextFile(join(dir, `f${i}.ts`), `export const f = ${i};`);
    }
    const under = countingIo();
    const full = await readTreeFacts(dir, {
      io: under.io,
      limits: { files: 6 },
    });
    assertEquals(under.read.length, 6, "at the cap every file is content");
    assertEquals(full.hash, (await readTreeFacts(dir)).hash);

    const over = countingIo();
    const cheap = await readTreeFacts(dir, {
      io: over.io,
      limits: { files: 5 },
    });
    assertEquals(over.read.length, 5, "the sixth file is not opened");
    assertEquals(over.stats(), 6, "…but every file is listed");
    assertMatch(cheap.hash ?? "", /^[0-9a-f]{8}$/);
    assertNotEquals(cheap.hash, full.hash, "a different identity, never a mix");
  });
});

Deno.test("tree walk: past the BYTE cap the file that would cross it is not opened", async () => {
  await withDir("aio-tree-bytes-", async (dir) => {
    await Deno.writeTextFile(join(dir, "a.txt"), "x".repeat(10));
    await Deno.writeTextFile(join(dir, "b.txt"), "y".repeat(10));
    const at = countingIo();
    await readTreeFacts(dir, { io: at.io, limits: { bytes: 20 } });
    assertEquals(at.read.length, 2, "exactly the cap is still content");
    const over = countingIo();
    await readTreeFacts(dir, { io: over.io, limits: { bytes: 19 } });
    assertEquals(over.read.length, 1, "the file that crosses it is not read");
  });
});

Deno.test("dirty set: past the FILE cap nothing more is read, and the build is still named", async () => {
  await withDir("aio-tree-files-git-", async (dir) => {
    await initRepo(dir);
    for (let i = 0; i < 6; i++) {
      await Deno.writeTextFile(join(dir, `u${i}.ts`), `export const u = ${i};`);
    }
    const over = countingIo();
    const t = await readTreeFacts(dir, { io: over.io, limits: { files: 3 } });
    assertEquals(over.read.length, 3);
    assertMatch(t.hash ?? "", /^[0-9a-f]{8}$/);
    assertNotEquals(t.hash, (await readTreeFacts(dir)).hash);
  });
});

// ── a file nobody can read never crosses a cap ───────────────────────────────
//
// An unreadable file was never part of the count: its bytes were never read.
// Taking the size from `stat` counted it, so ONE large file this user may not
// open moved a small tree off its content hash and onto the cheap one — where
// `touch` changes the version. The goldens are what the reader gave these
// exact fixtures before it had a cheap identity to fall to.

/** `chmod 000` denies root nothing, and Windows has no such mode. */
const CAN_LOCK = Deno.build.os !== "windows" && Deno.uid() !== 0;

/** A file of `bytes` this process may not open. */
async function locked(path: string, bytes: number): Promise<void> {
  await sparse(path, bytes);
  await Deno.chmod(path, 0);
}

const touch = (path: string) =>
  Deno.utime(path, new Date(1_600_000_000_000), new Date(1_600_000_000_000));

Deno.test({
  name:
    "tree walk: one large UNREADABLE file leaves the tree on its content hash",
  ignore: !CAN_LOCK,
  async fn() {
    await withDir("aio-tree-locked-", async (dir) => {
      await Deno.writeTextFile(join(dir, "a.ts"), "export const a = 1;\n");
      await locked(join(dir, "locked.bin"), TREE_WALK_MAX_BYTES + 1);
      assertEquals((await readTreeFacts(dir)).hash, "b4aa3a20");
      // A content hash does not move when nothing but a timestamp did.
      await touch(join(dir, "a.ts"));
      assertEquals((await readTreeFacts(dir)).hash, "b4aa3a20");
    });
  },
});

Deno.test({
  name: "tree walk: an UNREADABLE file is not one of the files the cap counts",
  ignore: !CAN_LOCK,
  async fn() {
    await withDir("aio-tree-locked-count-", async (dir) => {
      await Deno.writeTextFile(join(dir, "a.ts"), "export const a = 1;\n");
      await Deno.writeTextFile(join(dir, "b.ts"), "export const b = 1;\n");
      await locked(join(dir, "z-locked.ts"), 7);
      const limits = { files: 2 };
      assertEquals((await readTreeFacts(dir, { limits })).hash, "1faa14b7");
      await touch(join(dir, "a.ts"));
      assertEquals((await readTreeFacts(dir, { limits })).hash, "1faa14b7");
    });
  },
});

Deno.test({
  name:
    "dirty set: a large UNREADABLE file is a deletion, as it was — one entry, no bytes",
  ignore: !CAN_LOCK,
  async fn() {
    await withDir("aio-tree-locked-git-", async (dir) => {
      await initRepo(dir);
      await Deno.writeTextFile(join(dir, "b.ts"), "export const b = 1;\n");
      await locked(join(dir, "locked.bin"), TREE_WALK_MAX_BYTES + 1);
      assertEquals((await readTreeFacts(dir)).hash, "65e18879");
      await touch(join(dir, "b.ts"));
      assertEquals((await readTreeFacts(dir)).hash, "65e18879");
      // The deletion has no bytes, but it IS an entry: two fit a cap of two…
      assertEquals(
        (await readTreeFacts(dir, { limits: { files: 2 } })).hash,
        "65e18879",
      );
      // …and not a cap of one.
      const over = await readTreeFacts(dir, { limits: { files: 1 } });
      assertMatch(over.hash ?? "", /^[0-9a-f]{8}$/);
      assertNotEquals(over.hash, "65e18879");
    });
  },
});

Deno.test("tree walk: a file past a cap is ASKED whether it can be read — and never read", async () => {
  // The same fixture as the first case above, on every platform: here the
  // refusal comes from the injected reader instead of the file's mode.
  await withDir("aio-tree-probe-", async (dir) => {
    await Deno.writeTextFile(join(dir, "a.ts"), "export const a = 1;\n");
    await sparse(join(dir, "locked.bin"), TREE_WALK_MAX_BYTES + 1);
    const open = countingIo();
    const cheap = await readTreeFacts(dir, { io: open.io });
    assertEquals(open.probed, ["locked.bin"]);
    assertEquals(open.read.includes("locked.bin"), false);
    assertNotEquals(cheap.hash, "b4aa3a20", "readable: it crosses the cap");

    const shut = countingIo();
    const denied = await readTreeFacts(dir, {
      io: {
        ...shut.io,
        probe: (p) =>
          shut.io.probe(p).then(() => {
            throw new Deno.errors.PermissionDenied(p);
          }),
      },
    });
    assertEquals(shut.probed, ["locked.bin"]);
    assertEquals(shut.read.includes("locked.bin"), false);
    assertEquals(denied.hash, "b4aa3a20", "unreadable: it does not");
  });
});

// ── the cheap identity is a format, and it is pinned ─────────────────────────

/** The real disk with every mtime replaced by one derived from the file's
 *  name, so the cheap identity of a fixture is the same on every run. */
function fixedMtimeIo(mtimeOf: (name: string) => number): TreeIo {
  return {
    stat: async (p) => {
      const st = await Deno.stat(p);
      return {
        size: st.size,
        isDirectory: st.isDirectory,
        mtime: new Date(mtimeOf(basename(p))),
      };
    },
    readFile: (p) => Deno.readFile(p),
    probe: async (p) => (await Deno.open(p)).close(),
  };
}

Deno.test("cheap identity: sorted `path\\0size\\0mtime` lines, JSON-encoded, under its own tag", async () => {
  await withDir("aio-tree-cheap-golden-", async (dir) => {
    // Created in an order that is neither sorted nor reverse-sorted, so no
    // directory listing hands them over already in order.
    const names = ["m.ts", "a.ts", "z.ts", "c.ts", "x.ts", "e.ts"];
    for (const [i, name] of names.entries()) {
      await Deno.writeTextFile(join(dir, name), "x".repeat(i + 1));
    }
    await Deno.mkdir(join(dir, "sub"));
    await Deno.writeTextFile(join(dir, "sub", "b c.ts"), "y".repeat(40));
    const at = (bump: number) =>
      fixedMtimeIo((name) =>
        1_700_000_000_000 + name.charCodeAt(0) * 1000 +
        (name === "c.ts" ? bump : 0)
      );
    const limits = { files: 0 };
    const cheap = await readTreeFacts(dir, { io: at(0), limits });
    // sha256 of `aio-tree-meta\n` + JSON.stringify of the seven lines, sorted
    // — computed outside this code base. A change to any part of the format
    // moves the version of every tree past the content caps.
    assertEquals(cheap.hash, "0f23974f");
    assertEquals(
      (await readTreeFacts(dir, { io: at(0), limits })).hash,
      cheap.hash,
    );
    // `touch` is a change: one file's mtime, one millisecond.
    assertNotEquals(
      (await readTreeFacts(dir, { io: at(1), limits })).hash,
      cheap.hash,
    );
  });
});

Deno.test("tree walk: a file that GREW between its stat and its read still ends content mode", async () => {
  await withDir("aio-tree-grew-", async (dir) => {
    await Deno.writeTextFile(join(dir, "a.txt"), "x".repeat(50));
    // `stat` saw 5 bytes; by the read there are 50, and the cap is 20.
    const io = fixedMtimeIo(() => 1_700_000_000_000);
    const grew: TreeIo = {
      ...io,
      stat: async (p) => ({ ...(await io.stat(p)), size: 5 }),
    };
    const got = await readTreeFacts(dir, { io: grew, limits: { bytes: 20 } });
    assertEquals(
      got.hash,
      (await readTreeFacts(dir, { io: grew, limits: { files: 0 } })).hash,
      "the cheap identity",
    );
    assertNotEquals(got.hash, (await readTreeFacts(dir)).hash);
  });
});

// ── a nested node_modules is bulk, not the project ───────────────────────────

/** One source file, and a nested `node_modules` of `n` packages. */
async function vendoredTree(dir: string, n: number): Promise<void> {
  await Deno.writeTextFile(join(dir, "a.ts"), "export const a = 1;\n");
  for (let i = 0; i < n; i++) {
    const pkg = join(dir, "web", "node_modules", `p${i}`, "lib");
    await Deno.mkdir(pkg, { recursive: true });
    await Deno.writeTextFile(join(pkg, "index.js"), `module.exports = ${i};`);
  }
}

Deno.test("nested node_modules: inside the caps it is part of the hash, as it always was", async () => {
  await withDir("aio-tree-vendored-", async (dir) => {
    await vendoredTree(dir, 3);
    const before = (await readTreeFacts(dir)).hash;
    await Deno.writeTextFile(
      join(dir, "web", "node_modules", "p1", "lib", "index.js"),
      "module.exports = 'patched';",
    );
    assertNotEquals((await readTreeFacts(dir)).hash, before);
  });
});

Deno.test("nested node_modules: past the content cap it is left out of the identity, and no longer walked", async () => {
  await withDir("aio-tree-vendored-over-", async (dir) => {
    await vendoredTree(dir, 12);
    // 13 files against a cap of 4; and a listing bound the project's ONE own
    // file is inside, which the vendored ones — were they listed — are not.
    const limits = { files: 4, listed: 2 };
    const c = countingIo();
    const t = await readTreeFacts(dir, { io: c.io, limits });
    assertMatch(t.hash ?? "", /^[0-9a-f]{8}$/);
    assert(c.read.length <= 4, "reading stops at the content cap");
    assert(c.stats() <= 6, `…and so does the walk of it: ${c.stats()} stats`);
    // The cheap identity is the project's own files. Whatever part of the
    // vendored tree was visited before the cap, none of it is in the hash.
    for (let i = 0; i < 12; i++) {
      await Deno.writeTextFile(
        join(dir, "web", "node_modules", `p${i}`, "lib", "index.js"),
        `module.exports = "patched, and longer: ${i}";`,
      );
    }
    await Deno.remove(join(dir, "web", "node_modules", "p7"), {
      recursive: true,
    });
    assertEquals((await readTreeFacts(dir, { limits })).hash, t.hash);
    await Deno.writeTextFile(join(dir, "a.ts"), "export const a = 22;\n");
    assertNotEquals((await readTreeFacts(dir, { limits })).hash, t.hash);
  });
});

Deno.test("nested node_modules: its folders and depth never REFUSE a project its version", async () => {
  await withDir("aio-tree-vendored-bounds-", async (dir) => {
    await vendoredTree(dir, 12);
    // The project itself is 2 folders, 1 level deep. What is vendored is 25
    // folders and 4 levels — past both bounds, and it is not the project.
    const t = await readTreeFacts(dir, { limits: { dirs: 3, depth: 2 } });
    assertMatch(t.hash ?? "", /^[0-9a-f]{8}$/);
    // The same bounds still refuse the project's OWN folders.
    await Deno.mkdir(join(dir, "src", "deep", "er"), { recursive: true });
    await refusal(readTreeFacts(dir, { limits: { dirs: 3, depth: 2 } }));
  });
});

Deno.test("nested node_modules: untracked in a repository, it still makes the tree dirty — and is not read past the cap", async () => {
  await withDir("aio-tree-vendored-git-", async (dir) => {
    await initRepo(dir);
    for (let i = 0; i < 8; i++) {
      const pkg = join(dir, "web", "node_modules", `p${i}`);
      await Deno.mkdir(pkg, { recursive: true });
      await Deno.writeTextFile(join(pkg, "index.js"), `module.exports = ${i};`);
    }
    const c = countingIo();
    const t = await readTreeFacts(dir, {
      io: c.io,
      limits: { files: 3, listed: 1 },
    });
    assertEquals(c.read.length, 3);
    assert(c.stats() <= 4, `nothing vendored is touched after: ${c.stats()}`);
    assert(t.hash !== null, "dirty");
    // A pinned build reads nothing, and is dirty all the same.
    const pinned = await readTreeFacts(dir, { content: false });
    assert(pinned.hash !== null, "dirty");
  });
});

/** The refusal, and the ONE line of it a version may carry. */
async function refusal(p: Promise<unknown>): Promise<TreeRefusal> {
  const e = await assertRejects(() => p, TreeRefusal);
  assertStringIncludes(e.message, "refusing to hash");
  assertStringIncludes(e.message, "unbounded read");
  assertEquals(e.reason.includes("\n"), false, "one line");
  return e;
}

Deno.test("tree walk: past the LISTING cap the identity is REFUSED by name, never a partial hash", async () => {
  await withDir("aio-tree-listed-", async (dir) => {
    for (let i = 0; i < 5; i++) {
      await Deno.writeTextFile(join(dir, `f${i}.ts`), "x");
    }
    assertMatch(
      (await readTreeFacts(dir, { limits: { listed: 5 } })).hash ?? "",
      /^[0-9a-f]{8}$/,
    );
    const e = await refusal(readTreeFacts(dir, { limits: { listed: 4 } }));
    assertEquals(e.reason, "the project tree holds more than 4 files");
    assertStringIncludes(e.message, dir, "the log names the root");
    assertEquals(e.reason.includes(dir), false, "the version does not");
  });
});

Deno.test("dirty set: past the LISTING cap the identity is REFUSED by name", async () => {
  await withDir("aio-tree-listed-git-", async (dir) => {
    await initRepo(dir);
    for (let i = 0; i < 5; i++) {
      await Deno.writeTextFile(join(dir, `u${i}.ts`), "x");
    }
    const e = await refusal(readTreeFacts(dir, { limits: { listed: 4 } }));
    assertEquals(e.reason, "the project tree holds more than 4 files");
  });
});

Deno.test("tree walk: the number of DIRECTORIES visited is bounded", async () => {
  await withDir("aio-tree-dirs-", async (dir) => {
    for (let i = 0; i < 4; i++) await Deno.mkdir(join(dir, `d${i}`));
    // The root is a directory too: 5 visited.
    assertMatch(
      (await readTreeFacts(dir, { limits: { dirs: 5 } })).hash ?? "",
      /^[0-9a-f]{8}$/,
    );
    const e = await refusal(readTreeFacts(dir, { limits: { dirs: 4 } }));
    assertEquals(e.reason, "the project tree holds more than 4 folders");
  });
});

Deno.test("tree walk: the DEPTH descended is bounded", async () => {
  await withDir("aio-tree-depth-", async (dir) => {
    await Deno.mkdir(join(dir, "1", "2", "3"), { recursive: true });
    await Deno.writeTextFile(join(dir, "1", "2", "3", "leaf.ts"), "x");
    assertMatch(
      (await readTreeFacts(dir, { limits: { depth: 3 } })).hash ?? "",
      /^[0-9a-f]{8}$/,
    );
    const e = await refusal(readTreeFacts(dir, { limits: { depth: 2 } }));
    assertEquals(e.reason, "the project tree nests more than 2 deep");
  });
});

Deno.test("dirty set: git's listing is bounded — an enormous status is refused, not buffered", async () => {
  await withDir("aio-tree-gitbytes-", async (dir) => {
    await initRepo(dir);
    for (let i = 0; i < 40; i++) {
      await Deno.writeTextFile(join(dir, `${"u".repeat(60)}-${i}.ts`), "x");
    }
    // Room for every other git answer (a path, a count, a sha) — not for
    // 40 × 64 bytes of untracked names.
    const e = await refusal(
      readTreeFacts(dir, { limits: { gitBytes: 1024 } }),
    );
    assertEquals(
      e.reason,
      "`git status` listed more than 1024 bytes of paths",
    );
  });
});

/** Run `fn` with a stand-in `git` (a fake program) first on PATH. */
async function withFakeGit(
  dir: string,
  script: string,
  fn: () => Promise<void>,
): Promise<void> {
  const bin = join(dir, "bin");
  await Deno.mkdir(bin);
  await writeProgram(join(bin, `git${EXE}`), `#!/bin/sh\n${script}\n`);
  const path = Deno.env.get("PATH") ?? "";
  Deno.env.set("PATH", `${bin}${DELIMITER}${path}`);
  try {
    await fn();
  } finally {
    Deno.env.set("PATH", path);
  }
}

for (
  const [what, script] of [
    // The process itself never answers: it has to be killed.
    ["the process", "exec sleep 30"],
    // The shell is killed and its CHILD lives on, holding the pipe: the read
    // has to be cancelled too, or it waits for as long as the child does.
    // (Windows' stand-in sleeps in-process, so there the child is a deno.)
    [
      "a child it started",
      Deno.build.os === "windows"
        ? `exec "${Deno.execPath()}" eval 'setTimeout(() => {}, 30000)'`
        : "sleep 30",
    ],
  ] as const
) {
  Deno.test({
    name:
      `dirty set: a git that does not answer (${what}) is stopped AT the timeout and refused by name`,
    async fn() {
      await withDir("aio-tree-gitslow-", async (dir) => {
        await withFakeGit(dir, script, async () => {
          const t0 = performance.now();
          const e = await refusal(
            readTreeFacts(dir, { limits: { gitMs: 50 } }),
          );
          const took = performance.now() - t0;
          assertEquals(
            e.reason,
            "`git rev-parse` did not answer within 50 ms",
          );
          // Under the 30 s the stand-in sleeps: it was stopped, not waited
          // for. (Windows: starting — and ending — a program that was
          // written a moment ago takes seconds on a busy machine; measured
          // 10.7 s there, so the bound is 20 s rather than 5.)
          const bound = Deno.build.os === "windows" ? 20_000 : 5000;
          assert(took < bound, `refused after ${Math.round(took)} ms`);
        });
      });
    },
  });
}

Deno.test({
  name: "dirty set: a git that answers leaves no timer behind",
  // The pending timeout is the leak: it holds a finished `--version` open
  // for the 30 s git was given.
  sanitizeOps: true,
  sanitizeResources: true,
  async fn() {
    await withDir("aio-tree-gittimer-", async (dir) => {
      await initRepo(dir);
      assertEquals((await readTreeFacts(dir)).hash, null);
    });
  },
});

Deno.test("tree caps: the numbers the docs state are the numbers the reader uses", async () => {
  assertEquals(TREE_WALK_MAX_FILES, 20_000);
  assertEquals(TREE_WALK_MAX_BYTES, 128 * 1024 * 1024);
  assertEquals(TREE_LIST_MAX_FILES, 50_000);
  assertEquals(TREE_WALK_MAX_DIRS, 50_000);
  assertEquals(TREE_WALK_MAX_DEPTH, 64);
  assertEquals(GIT_TIMEOUT_MS, 30_000);
  assertEquals(GIT_STDOUT_MAX_BYTES, 32 * 1024 * 1024);
  const doc = await Deno.readTextFile(
    new URL("../docs/build/versioning.md", import.meta.url),
  );
  for (
    const said of [
      "20,000 files",
      "128 MB",
      "50,000 files",
      "50,000 directories",
      "64 levels",
      "30 s",
      "32 MB",
    ]
  ) {
    assertStringIncludes(doc, said);
  }
});

// ── a pinned version needs no tree ───────────────────────────────────────────

Deno.test("pinned: a build with a large asset keeps its version, and opens no file to get it", async () => {
  await withDir("aio-tree-pinned-", async (dir) => {
    await Deno.writeTextFile(join(dir, "a.ts"), "export const a = 1;\n");
    await sparse(join(dir, "asset.bin"), 3 * GiB);
    // No repository: nothing about a pinned build depends on the tree.
    const { bv } = await buildVersionFor(dir, "0.1.0", { env: "" });
    assertEquals(bv.version, "0.1.0");
    assertEquals(bv.source, "pinned");
    assertEquals(bv.commit, null);
    assertEquals(bv.dirty, false);
    const c = countingIo();
    assertEquals(
      await readTreeFacts(dir, { content: false, io: c.io }),
      { repo: false, count: 0, commit: null, hash: null },
    );
    assertEquals([c.read.length, c.stats()], [0, 0], "no walk at all");
  });
});

Deno.test("pinned: in a repository the build still records its commit and whether it is dirty", async () => {
  await withDir("aio-tree-pinned-git-", async (dir) => {
    await initRepo(dir);
    const clean = (await buildVersionFor(dir, "2.0.0", { env: "" })).bv;
    assertEquals(clean.version, "2.0.0");
    assertMatch(clean.commit ?? "", /^[0-9a-f]{8}$/);
    assertEquals(clean.dirty, false);
    await sparse(join(dir, "asset.bin"), 3 * GiB);
    const c = countingIo();
    const t = await readTreeFacts(dir, { content: false, io: c.io });
    assertEquals(c.read, [], "dirty is a fact about paths, not contents");
    assert(t.hash !== null);
    const dirty = (await buildVersionFor(dir, "2.0.0", { env: "" })).bv;
    assertEquals(dirty.version, "2.0.0");
    assertEquals(dirty.dirty, true);
    assertEquals(dirty.commit, clean.commit);
  });
});

Deno.test("pinned: a tree the reader REFUSES still builds — the version is written down", async () => {
  await withDir("aio-tree-pinned-refused-", async (dir) => {
    await initRepo(dir);
    for (let i = 0; i < 5; i++) {
      await Deno.writeTextFile(join(dir, `u${i}.ts`), "x");
    }
    // A cap this small tree is already past: a derived version is refused…
    const limits = { listed: 2 };
    await refusal(buildVersionFor(dir, "2.0", { env: "", limits }));
    // …and a pinned one is not — it loses the two facts nobody could read,
    // and says so, rather than the version it had written down.
    const { bv } = await buildVersionFor(dir, "2.0.0", { env: "", limits });
    assertEquals(bv.version, "2.0.0");
    assertEquals([bv.commit, bv.dirty], [null, false]);
    // A source run of a pinned app does not even ask.
    assertEquals(
      resolveRuntimeVersion({
        declared: "2.0.0",
        compiled: false,
        stamp: null,
        tree: await runtimeTreeFacts(dir, { version: "2.0.0" }, () => {
          throw new Error("a pinned source run must not read the tree");
        }),
      }),
      "2.0.0",
    );
  });
});

Deno.test("source run: only a DERIVED version reads the tree, and it excludes the app's out dir", async () => {
  const calls: Array<{ root: string; excludes?: readonly string[] }> = [];
  const read = ((root: string, opts?: { excludes?: readonly string[] }) => {
    calls.push({ root, excludes: opts?.excludes });
    return Promise.resolve({
      repo: true,
      count: 7,
      commit: "deadbeef",
      hash: null,
    });
  }) as typeof readTreeFacts;
  for (const pinned of ["1.0.0", "1.0.0-rc", " 01.2.3 "]) {
    await runtimeTreeFacts("/app", { version: pinned }, read);
  }
  // A refused declaration is reported in the refusal's own words — no tree.
  await runtimeTreeFacts("/app", { version: "v1" }, read);
  assertEquals(calls, [], "nothing printed a hash, so nothing was read");

  for (const derived of ["1.2", "1.2-beta", undefined]) {
    assertEquals(
      (await runtimeTreeFacts("/app", {
        version: derived,
        build: { out: "release" },
      }, read)).count,
      7,
    );
  }
  assertEquals(calls.length, 3);
  // `dist/` beside it: the build stages there whatever `out` is.
  assertEquals(calls[0], { root: "/app", excludes: ["dist/", "release/"] });
});

// ── an unknown version is one short line ─────────────────────────────────────

Deno.test("unknown version: a refused tree is ONE line with no path — the root stays in the log", async () => {
  await withDir("aio-tree-unknown-", async (dir) => {
    for (let i = 0; i < 3; i++) {
      await Deno.writeTextFile(join(dir, `f${i}.ts`), "x");
    }
    const e = await refusal(readTreeFacts(dir, { limits: { listed: 2 } }));
    const v = unresolvedTreeVersion(e);
    assertEquals(
      v,
      "unknown (the project tree holds more than 2 files — see the log)",
    );
    assertEquals(v.includes("\n"), false);
    assertEquals(v.includes(dir), false);
    assert(v.length < 100, "a version line, not a paragraph");
    // Still the shape every reader of an unresolved version splits on.
    assertEquals(splitRuntimeVersion(v), {
      version: null,
      unresolved: "the project tree holds more than 2 files — see the log",
    });
    // An error that is not a refusal never lends the string its message — a
    // raw OS error carries the path it failed on.
    assertEquals(
      unresolvedTreeVersion(new Error(`EACCES: ${dir}/secret`)),
      "unknown (the project tree could not be read — see the log)",
    );
  });
});

// ── the real boot path ───────────────────────────────────────────────────────

const ROOT = fromFileUrl(new URL("../", import.meta.url)).replace(/[\\/]$/, "");

/** An app whose project tree nests past the depth cap — the cheapest tree the
 *  reader refuses with its PRODUCTION limits. */
async function deepApp(dir: string, version: string): Promise<void> {
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify({
      title: "treeprobe",
      version,
      imports: {
        "aio": `${spec(ROOT)}/mod.ts`,
        "aio/": `${spec(ROOT)}/src/`,
        "immer": "npm:immer@10.2.0",
        "@std/path": "jsr:@std/path@1.1.2",
      },
    }),
  );
  await Deno.writeTextFile(
    join(dir, "app.ts"),
    `import { aio } from "aio";\nawait aio.run({ client: "server-only" });\n`,
  );
  const deep = join(dir, ...Array(TREE_WALK_MAX_DEPTH + 1).fill("d"));
  await Deno.mkdir(deep, { recursive: true });
  await Deno.writeTextFile(join(deep, "leaf.ts"), "x");
}

async function versionOf(dir: string): Promise<string> {
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-Aq", join(dir, "app.ts"), "--version"],
    cwd: dir,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const text = new TextDecoder().decode(out.stdout) +
    new TextDecoder().decode(out.stderr);
  assertEquals(out.code, 0, `--version must succeed:\n${text}`);
  return text;
}

Deno.test({
  name:
    "--version: a refused tree prints one short `unknown (…)` line, and the full reason once",
  async fn() {
    await withDir("aio-tree-e2e-", async (dir) => {
      await deepApp(dir, "3.7");
      const text = await versionOf(dir);
      const line = text.split("\n").find((l) => l.includes("unknown ("));
      assert(line, `the version must say unknown:\n${text}`);
      assertStringIncludes(
        line,
        `unknown (the project tree nests more than ${TREE_WALK_MAX_DEPTH} ` +
          `deep — see the log)`,
      );
      assertEquals(line.includes(dir), false, "no path in the version line");
      assertEquals(
        text.split("refusing to hash").length - 1,
        1,
        `the teachable reason is logged exactly once:\n${text}`,
      );
    });
  },
});

Deno.test({
  name: "--version: the same tree with a PINNED version just prints it",
  async fn() {
    await withDir("aio-tree-e2e-pinned-", async (dir) => {
      await deepApp(dir, "3.7.1");
      const text = await versionOf(dir);
      assertStringIncludes(text, "3.7.1");
      assertEquals(text.includes("unknown"), false, text);
      assertEquals(text.includes("refusing to hash"), false, text);
    });
  },
});
