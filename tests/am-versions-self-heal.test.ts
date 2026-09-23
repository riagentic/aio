// The version store heals the checkout's worktree registry on every provision.
//
// The store lives under $HOME (`~/.local/lib/aio-versions`) and each version's
// REGISTRATION lives in the aio checkout's .git. A version provisioned under a
// HOME that is later deleted — CI, a sandbox, a test's temp HOME — left a
// "prunable" entry in the user's checkout for good (the exit-code sweep planted
// them in this very repo). `ensureVersion` now runs `git worktree prune` before
// every `worktree add` — for entries under the version store ONLY, each by
// exact path. A blanket `git worktree prune` would also expire the developer's
// own worktree the moment its drive is unmounted (gc waits three months).
//
// Everything runs against a THROWAWAY repo made here — never this checkout.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { ensureVersion, removeVersion } from "../src/am/am-versions.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const GIT_ENV = {
  GIT_AUTHOR_NAME: "aio test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "aio test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
  GIT_CONFIG_NOSYSTEM: "1",
};

async function git(cwd: string, ...args: string[]): Promise<string> {
  const o = await new Deno.Command("git", {
    args: ["-C", cwd, ...args],
    env: GIT_ENV,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const d = new TextDecoder();
  assert(o.success, `git ${args.join(" ")}: ${d.decode(o.stderr)}`);
  return d.decode(o.stdout);
}

const registered = async (repo: string) =>
  (await git(repo, "worktree", "list", "--porcelain")).split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice("worktree ".length));

Deno.test("ensureVersion drops stale STORE registrations, and only those", async () => {
  const base = await tempDir("am-versions-heal-");
  const saved = Deno.env.get("AIO_VERSIONS_DIR");
  try {
    const repo = join(base, "aio");
    await Deno.mkdir(repo);
    await git(repo, "init", "-q");
    await Deno.writeTextFile(join(repo, "mod.ts"), "export {};\n");
    await git(repo, "add", "mod.ts");
    await git(repo, "commit", "-q", "-m", "init");
    await git(repo, "tag", "v9.9.9");

    // Two registrations whose directories are gone: one IN the version
    // store (aio's own — a deleted version dir), and one OUTSIDE it (the
    // developer's own worktree on an unmounted drive or a moved folder).
    const store = join(base, "store");
    const stale = join(store, "v0.0.1");
    const theirs = join(base, "unmounted", "feature-x");
    await git(repo, "worktree", "add", "--detach", stale, "HEAD");
    await git(repo, "worktree", "add", "--detach", theirs, "HEAD");
    await Deno.remove(stale, { recursive: true });
    await Deno.remove(join(base, "unmounted"), { recursive: true });
    const before = await registered(repo);
    assert(before.includes(stale) && before.includes(theirs), "plants took");

    Deno.env.set("AIO_VERSIONS_DIR", store);
    const r = await ensureVersion(repo, "v9.9.9");
    assert(r.ok, r.ok ? "" : r.error);
    assertEquals(r.created, true);

    const now = await registered(repo);
    assertEquals(
      now.includes(stale),
      false,
      "the store's stale entry survived",
    );
    assert(
      now.includes(theirs),
      "a worktree OUTSIDE the store lost its registration — only the store " +
        "is aio's to forget",
    );
    assert(now.includes(join(store, "v9.9.9")), now.join("\n"));
  } finally {
    if (saved === undefined) Deno.env.delete("AIO_VERSIONS_DIR");
    else Deno.env.set("AIO_VERSIONS_DIR", saved);
    await dropTempDir(base);
  }
});

Deno.test("ensureVersion heals a SYMLINKED store (git records the real path)", async () => {
  const base = await tempDir("am-versions-heal-link-");
  const saved = Deno.env.get("AIO_VERSIONS_DIR");
  try {
    const repo = join(base, "aio");
    await Deno.mkdir(repo);
    await git(repo, "init", "-q");
    await Deno.writeTextFile(join(repo, "mod.ts"), "export {};\n");
    await git(repo, "add", "mod.ts");
    await git(repo, "commit", "-q", "-m", "init");
    await git(repo, "tag", "v9.9.9");
    // HOME (or AIO_VERSIONS_DIR) reached through a symlink.
    const real = join(base, "real-store");
    await Deno.mkdir(real);
    const link = join(base, "store-link");
    await Deno.symlink(real, link);
    Deno.env.set("AIO_VERSIONS_DIR", link);

    const first = await ensureVersion(repo, "v9.9.9");
    assert(first.ok, first.ok ? "" : first.error);
    // The version dir vanishes (a cleaned store); its registration stays.
    await Deno.remove(join(real, "v9.9.9"), { recursive: true });

    const again = await ensureVersion(repo, "v9.9.9");
    assert(again.ok, `re-provisioning failed: ${again.ok ? "" : again.error}`);
    assertEquals(again.created, true);
  } finally {
    if (saved === undefined) Deno.env.delete("AIO_VERSIONS_DIR");
    else Deno.env.set("AIO_VERSIONS_DIR", saved);
    await dropTempDir(base);
  }
});

// ── A checkout killed mid-`git worktree add` ─────────────────────────────
//
// Measured: a provision killed at 21022 of 30000 files leaves a directory
// with no mod.ts and a registration `locked initializing`. It was returned as
// provisioned forever (a tag is never re-checked), and deleting it by hand
// made the version un-addable ("missing but locked worktree").

async function repoWithTag(base: string): Promise<string> {
  const repo = join(base, "aio");
  await Deno.mkdir(repo);
  await git(repo, "init", "-q");
  await Deno.writeTextFile(join(repo, "mod.ts"), "export {};\n");
  // Sorted AFTER mod.ts, as git writes it: a checkout interrupted here has
  // mod.ts and not src/.
  await Deno.mkdir(join(repo, "src"));
  await Deno.writeTextFile(join(repo, "src", "x.ts"), "export {};\n");
  await git(repo, "add", "mod.ts", "src/x.ts");
  await git(repo, "commit", "-q", "-m", "init");
  await git(repo, "tag", "v9.9.9");
  return repo;
}

/** Leave `path` the way a killed `git worktree add` does: registered, locked
 *  `initializing`, no mod.ts. `ageMs` backdates the lock. */
async function killedMidAdd(
  repo: string,
  path: string,
  ageMs: number,
  opts: { reason?: string; missing?: string } = {},
) {
  await git(
    repo,
    "worktree",
    "add",
    "--detach",
    "--lock",
    "--reason",
    opts.reason ?? "initializing",
    path,
    "v9.9.9",
  );
  await Deno.remove(join(path, opts.missing ?? "mod.ts"), { recursive: true })
    .catch(() => {}); // a "missing" file that never existed: nothing torn
  const gitdir = (await Deno.readTextFile(join(path, ".git")))
    .replace(/^gitdir:\s*/, "").trim();
  const then = new Date(Date.now() - ageMs);
  await Deno.utime(join(gitdir, "locked"), then, then);
}

const porcelain = (repo: string) =>
  git(repo, "worktree", "list", "--porcelain");

async function withStore(
  fn: (base: string, repo: string, store: string) => Promise<void>,
) {
  const base = await tempDir("am-versions-torn-");
  const saved = Deno.env.get("AIO_VERSIONS_DIR");
  try {
    const repo = await repoWithTag(base);
    const store = join(base, "store");
    await Deno.mkdir(store);
    Deno.env.set("AIO_VERSIONS_DIR", store);
    await fn(base, repo, store);
  } finally {
    if (saved === undefined) Deno.env.delete("AIO_VERSIONS_DIR");
    else Deno.env.set("AIO_VERSIONS_DIR", saved);
    await dropTempDir(base);
  }
}

Deno.test("ensureVersion: a checkout killed mid-add is torn down and re-provisioned", () =>
  withStore(async (_base, repo, store) => {
    const path = join(store, "v9.9.9");
    await killedMidAdd(repo, path, 3_600_000);
    const r = await ensureVersion(repo, "v9.9.9");
    assert(r.ok, r.ok ? "" : r.error);
    assertEquals(r.created, true, "the torn checkout was returned as-is");
    assert(await Deno.stat(join(path, "mod.ts")).then(() => true, () => false));
    assert(!(await porcelain(repo)).includes("locked"), await porcelain(repo));
  }));

Deno.test("ensureVersion: a killed add whose directory was then deleted is addable again", () =>
  withStore(async (_base, repo, store) => {
    const path = join(store, "v9.9.9");
    await killedMidAdd(repo, path, 3_600_000);
    await Deno.remove(path, { recursive: true });
    const r = await ensureVersion(repo, "v9.9.9");
    assert(r.ok, `"missing but locked" came back: ${r.ok ? "" : r.error}`);
    assertEquals(r.created, true);
  }));

Deno.test("ensureVersion: an add IN FLIGHT (fresh initializing lock) is refused, not torn down", () =>
  withStore(async (_base, repo, store) => {
    const path = join(store, "v9.9.9");
    await killedMidAdd(repo, path, 0);
    const r = await ensureVersion(repo, "v9.9.9");
    assertEquals(r.ok, false);
    assertStringIncludes(r.ok ? "" : r.error, "being provisioned right now");
    assert(await Deno.stat(path).then(() => true, () => false), "torn down");
    assertStringIncludes(await porcelain(repo), "locked initializing");
  }));

Deno.test("store cleanup: a stale initializing lock OUTSIDE the store is left alone", () =>
  withStore(async (base, repo) => {
    const theirs = join(base, "elsewhere", "wip");
    await killedMidAdd(repo, theirs, 3_600_000);
    const r = await ensureVersion(repo, "v9.9.9");
    assert(r.ok, r.ok ? "" : r.error);
    assert((await registered(repo)).includes(theirs), "theirs was removed");
    assert(await Deno.stat(theirs).then(() => true, () => false));
  }));

Deno.test("removeVersion: removes a locked store entry, and prunes nothing else", () =>
  withStore(async (base, repo, store) => {
    const theirs = join(base, "unmounted", "feature-x");
    await git(repo, "worktree", "add", "--detach", theirs, "HEAD");
    await Deno.remove(join(base, "unmounted"), { recursive: true });
    const path = join(store, "v9.9.9");
    await killedMidAdd(repo, path, 0);
    assertEquals(await removeVersion(repo, "v9.9.9"), true);
    const now = await registered(repo);
    assertEquals(now.includes(path), false, "the locked store entry stayed");
    assert(now.includes(theirs), "a repo-wide prune took their worktree");
  }));

Deno.test("ensureVersion: a store dir with no mod.ts and no lock is still torn, and re-provisioned", () =>
  withStore(async (_base, repo, store) => {
    // The lock is gone (git unlocked, or someone ran `worktree unlock`) but
    // the checkout never finished.
    const path = join(store, "v9.9.9");
    await git(repo, "worktree", "add", "--detach", path, "v9.9.9");
    await Deno.remove(join(path, "mod.ts"));
    const r = await ensureVersion(repo, "v9.9.9");
    assert(r.ok, r.ok ? "" : r.error);
    assertEquals(
      r.created,
      true,
      "a torn checkout was returned as provisioned",
    );
    assert(await Deno.stat(join(path, "mod.ts")).then(() => true, () => false));
  }));

// ── Round 2: a lock in any language, "has mod.ts" ≠ finished, legacy dirs ──

const marked = (path: string) =>
  Deno.stat(`${path}.provisioned`).then(() => true, () => false);

Deno.test("ensureVersion: a lock whose reason git TRANSLATED is still in flight", () =>
  withStore(async (_base, repo, store) => {
    const path = join(store, "v9.9.9");
    await killedMidAdd(repo, path, 0, { reason: "initialisiere" });
    const r = await ensureVersion(repo, "v9.9.9");
    assertEquals(r.ok, false, "a German-locked checkout was torn down");
    assertStringIncludes(r.ok ? "" : r.error, "being provisioned right now");
    assert(await Deno.stat(path).then(() => true, () => false));
  }));

Deno.test("ensureVersion: mod.ts written but src/ not yet — refused while the add runs", () =>
  withStore(async (_base, repo, store) => {
    const path = join(store, "v9.9.9");
    await killedMidAdd(repo, path, 0, { missing: "src" });
    const r = await ensureVersion(repo, "v9.9.9");
    assertEquals(r.ok, false, "a checkout still being written was returned");
  }));

Deno.test("ensureVersion: a fresh provision is marked complete", () =>
  withStore(async (_base, repo, store) => {
    const r = await ensureVersion(repo, "v9.9.9");
    assert(r.ok && r.created, JSON.stringify(r));
    assert(await marked(join(store, "v9.9.9")));
  }));

Deno.test("ensureVersion: a complete LEGACY checkout (no marker) is kept and marked", () =>
  withStore(async (_base, repo, store) => {
    const path = join(store, "v9.9.9");
    await git(repo, "worktree", "add", "--detach", path, "v9.9.9");
    // An edit is not a torn checkout either.
    await Deno.writeTextFile(join(path, "src", "x.ts"), "// edited\n");
    const r = await ensureVersion(repo, "v9.9.9");
    assert(r.ok, r.ok ? "" : r.error);
    assertEquals(r.created, false, "a complete legacy checkout was torn down");
    assertEquals(
      await Deno.readTextFile(join(path, "src", "x.ts")),
      "// edited\n",
    );
    assert(await marked(path));
  }));

Deno.test("ensureVersion: an unmarked, unlocked checkout missing files is re-provisioned", () =>
  withStore(async (_base, repo, store) => {
    const path = join(store, "v9.9.9");
    await git(repo, "worktree", "add", "--detach", path, "v9.9.9");
    await Deno.remove(join(path, "src"), { recursive: true });
    const r = await ensureVersion(repo, "v9.9.9");
    assert(r.ok, r.ok ? "" : r.error);
    assertEquals(r.created, true);
    assert(await Deno.stat(join(path, "src", "x.ts")).then(() => true));
  }));

Deno.test("ensureVersion: a version ANOTHER clone is writing is refused, not deleted", () =>
  withStore(async (base, repo, store) => {
    const other = join(base, "other-clone");
    await git(base, "clone", "-q", repo, other);
    const path = join(store, "v9.9.9");
    await killedMidAdd(other, path, 0, { missing: "src" });
    const r = await ensureVersion(repo, "v9.9.9");
    assertEquals(r.ok, false);
    assert(await Deno.stat(path).then(() => true, () => false), "deleted");
  }));

Deno.test("ensureVersion: a marker does not vouch for a checkout that lost mod.ts", () =>
  withStore(async (_base, repo, store) => {
    const path = join(store, "v9.9.9");
    await git(repo, "worktree", "add", "--detach", path, "v9.9.9");
    await Deno.writeTextFile(`${path}.provisioned`, "stale\n");
    await Deno.remove(join(path, "mod.ts"));
    const r = await ensureVersion(repo, "v9.9.9");
    assert(r.ok, r.ok ? "" : r.error);
    assertEquals(r.created, true, "a torn checkout was trusted for its marker");
  }));

Deno.test("ensureVersion: a STALE lock in another language, dir deleted, is addable again", () =>
  withStore(async (_base, repo, store) => {
    const path = join(store, "v9.9.9");
    await killedMidAdd(repo, path, 3_600_000, { reason: "initialisiere" });
    await Deno.remove(path, { recursive: true });
    const r = await ensureVersion(repo, "v9.9.9");
    assert(r.ok, `"missing but locked" came back: ${r.ok ? "" : r.error}`);
  }));

// ── Round 3: git that cannot answer is never evidence ─────────────────────
//
// A v1.0.9 checkout (no marker) whose registering clone was MOVED — or
// re-cloned, reinstalled, "dubious ownership" — makes `git ls-files` fail.
// That was read as "torn" and the complete checkout was deleted; with the tag
// gone upstream (or offline) the framework never came back.

/** A complete legacy (unmarked) checkout of v9.9.9 in the store, whose
 *  registering clone is then moved away so git can no longer inspect it. */
async function orphanedLegacy(base: string, store: string): Promise<string> {
  const first = await repoWithTag(join(base, "first"));
  const path = join(store, "v9.9.9");
  await git(first, "worktree", "add", "--detach", path, "v9.9.9");
  await Deno.rename(join(base, "first"), join(base, "first-moved"));
  return path;
}

Deno.test("ensureVersion: a complete legacy checkout git cannot inspect is KEPT", () =>
  withStore(async (base, repo, store) => {
    await Deno.mkdir(join(base, "first"));
    const path = await orphanedLegacy(base, store);
    const r = await ensureVersion(repo, "v9.9.9");
    assert(r.ok, r.ok ? "" : r.error);
    assertEquals(r.created, false, "a complete checkout was deleted");
    assertEquals(
      await Deno.readTextFile(join(path, "src", "x.ts")),
      "export {};\n",
    );
    assert(await marked(path));
  }));

Deno.test("ensureVersion: …and kept even when the root no longer has the tag", async () => {
  const base = await tempDir("am-versions-notag-");
  const saved = Deno.env.get("AIO_VERSIONS_DIR");
  try {
    const store = join(base, "store");
    await Deno.mkdir(store);
    Deno.env.set("AIO_VERSIONS_DIR", store);
    await Deno.mkdir(join(base, "first"));
    const path = await orphanedLegacy(base, store);
    // A root with no v9.9.9 at all (the tag was deleted upstream / offline).
    const bare = join(base, "bare");
    await Deno.mkdir(bare);
    await git(bare, "init", "-q");
    await Deno.writeTextFile(join(bare, "mod.ts"), "export {};\n");
    await git(bare, "add", "mod.ts");
    await git(bare, "commit", "-q", "-m", "init");
    const r = await ensureVersion(bare, "v9.9.9");
    assert(r.ok, r.ok ? "" : r.error);
    assert(await Deno.stat(join(path, "mod.ts")).then(() => true), "deleted");
  } finally {
    if (saved === undefined) Deno.env.delete("AIO_VERSIONS_DIR");
    else Deno.env.set("AIO_VERSIONS_DIR", saved);
    await dropTempDir(base);
  }
});

Deno.test("ensureVersion: a TORN checkout the root cannot rebuild is refused and left", async () => {
  const base = await tempDir("am-versions-torn-notag-");
  const saved = Deno.env.get("AIO_VERSIONS_DIR");
  try {
    const store = join(base, "store");
    await Deno.mkdir(store);
    Deno.env.set("AIO_VERSIONS_DIR", store);
    await Deno.mkdir(join(base, "tagged"));
    const tagged = await repoWithTag(join(base, "tagged"));
    const path = join(store, "v9.9.9");
    await git(tagged, "worktree", "add", "--detach", path, "v9.9.9");
    await Deno.remove(join(path, "src"), { recursive: true });
    await git(tagged, "tag", "-d", "v9.9.9"); // gone upstream
    const r = await ensureVersion(tagged, "v9.9.9");
    assertEquals(r.ok, false);
    assertStringIncludes(r.ok ? "" : r.error, "left in place");
    assert(await Deno.stat(join(path, "mod.ts")).then(() => true), "deleted");
  } finally {
    if (saved === undefined) Deno.env.delete("AIO_VERSIONS_DIR");
    else Deno.env.set("AIO_VERSIONS_DIR", saved);
    await dropTempDir(base);
  }
});

Deno.test("store cleanup: a stale-locked checkout that FINISHED is unlocked and kept", () =>
  withStore(async (_base, repo, store) => {
    const path = join(store, "v9.9.9");
    await killedMidAdd(repo, path, 3_600_000, { missing: "no-such-file" });
    const r = await ensureVersion(repo, "v9.9.9");
    assert(r.ok, r.ok ? "" : r.error);
    assertEquals(r.created, false, "a finished checkout was torn down");
    assert(!(await porcelain(repo)).includes("locked"));
  }));

// ── Round 6: a teardown judged by its result; a clock that stepped back ──

Deno.test({
  name:
    "ensureVersion: a torn checkout that cannot be DELETED is refused, never ok",
  // Root deletes through a read-only dir anyway — nothing to fail.
  ignore: Deno.build.os === "windows" || Deno.uid() === 0,
  fn: () =>
    withStore(async (_base, repo, store) => {
      const path = join(store, "v9.9.9");
      await killedMidAdd(repo, path, 3_600_000);
      const ro = join(path, "stuck");
      await Deno.mkdir(ro);
      await Deno.writeTextFile(join(ro, "f"), "x");
      await Deno.chmod(ro, 0o555);
      try {
        const r = await ensureVersion(repo, "v9.9.9");
        assertEquals(r.ok, false, "a torn checkout came back as provisioned");
        const err = r.ok ? "" : r.error;
        assertStringIncludes(err, path);
        assertStringIncludes(err, "could not be removed");
      } finally {
        await Deno.chmod(ro, 0o755);
      }
    }),
});

Deno.test("ensureVersion: a lock stamped in the FUTURE is stale, not in flight", () =>
  withStore(async (_base, repo, store) => {
    // The clock stepped back after the add was killed: raw subtraction read
    // "started -3600s ago" and refused forever.
    const path = join(store, "v9.9.9");
    await killedMidAdd(repo, path, -3_600_000);
    const r = await ensureVersion(repo, "v9.9.9");
    assert(r.ok, r.ok ? "" : r.error);
    assertEquals(r.created, true);
  }));

Deno.test("store cleanup: a FUTURE-stamped lock on a vanished store dir is pruned", () =>
  withStore(async (_base, repo, store) => {
    const path = join(store, "v9.9.9");
    await killedMidAdd(repo, path, -3_600_000);
    await Deno.remove(path, { recursive: true });
    const r = await ensureVersion(repo, "v9.9.9");
    assert(r.ok, r.ok ? "" : r.error);
    assertEquals(r.created, true);
  }));

Deno.test({
  name:
    "ensureVersion: …and an UNLOCKED torn checkout that cannot be deleted too",
  ignore: Deno.build.os === "windows" || Deno.uid() === 0,
  fn: () =>
    withStore(async (_base, repo, store) => {
      const path = join(store, "v9.9.9");
      await git(repo, "worktree", "add", "--detach", path, "v9.9.9");
      await Deno.remove(join(path, "mod.ts"));
      const ro = join(path, "stuck");
      await Deno.mkdir(ro);
      await Deno.writeTextFile(join(ro, "f"), "x");
      await Deno.chmod(ro, 0o555);
      try {
        const r = await ensureVersion(repo, "v9.9.9");
        assertEquals(r.ok, false, "a torn checkout came back as provisioned");
        assertStringIncludes(r.ok ? "" : r.error, `${path} is an incomplete`);
      } finally {
        await Deno.chmod(ro, 0o755);
      }
    }),
});

Deno.test("ensureVersion: a bare store dir stamped in the FUTURE is torn, not in flight", () =>
  withStore(async (_base, repo, store) => {
    // No `.git` yet reads as "git just made it" only while YOUNG; a future
    // mtime is old (the clock stepped back), never "-3600s ago".
    const path = join(store, "v9.9.9");
    await Deno.mkdir(path);
    const later = new Date(Date.now() + 3_600_000);
    await Deno.utime(path, later, later);
    const r = await ensureVersion(repo, "v9.9.9");
    assert(r.ok, r.ok ? "" : r.error);
    assertEquals(r.created, true);
  }));
