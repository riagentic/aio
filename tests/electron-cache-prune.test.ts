// `am prune` — the shared Electron runtime cache, and the rule that it may
// never destroy a working install.
//
// The cache had never lost an entry: 32 of them, 7.7 GB, Electron 41.2.1
// through 44.4.2, on the machine this was written on. It is also MACHINE-WIDE,
// which is why the obvious repairs are all wrong — deleting a runtime because
// THIS app does not need it breaks the offline app next door. So the design is
// (a) judge by USE, never by version order or platform, (b) print the plan,
// (c) delete only what that plan named and only when asked.
//
// Every one of those is a property with a test here. The one that matters most
// is the first in the file: whatever the age, whatever the flags, the Electron
// this aio ships is never on the list.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import {
  applyElectronPrune,
  type CacheEntry,
  cacheEntryIdentity,
  cacheEntryKind,
  DEFAULT_ELECTRON_VERSION,
  humanBytes,
  parseCacheName,
  planElectronPrune,
  PRUNE_DEFAULT_MIN_AGE_DAYS,
  readElectronCache,
} from "../src/build/electron-cache.ts";
import {
  RUNTIME_USE_STAMP,
  runtimeLastUsed,
  touchRuntimeUse,
} from "../src/electron/electron-runtime-fetch.ts";
import { parsePruneArgs, renderPrunePlan } from "../src/am/am-cmd-prune.ts";

const NOW = Date.UTC(2026, 8, 21);
const DAY = 86_400_000;

function entry(over: Partial<CacheEntry> & { name: string }): CacheEntry {
  // The SAME identity the scanner computes — a helper that strips suffixes
  // its own way is a second decider, and it hid a real one (see below).
  const { version, slug } = cacheEntryIdentity(over.name);
  return {
    path: `/cache/electron/${over.name}`,
    kind: cacheEntryKind(over.name),
    version,
    slug,
    bytes: 250_000_000,
    lastUsed: NOW - 400 * DAY,
    lastUsedSource: "stamp",
    ...over,
  };
}

const plan = (entries: CacheEntry[], over: Partial<{
  keepVersions: string[];
  minAgeDays: number;
}> = {}) =>
  planElectronPrune(entries, {
    keepVersions: [DEFAULT_ELECTRON_VERSION, ...(over.keepVersions ?? [])],
    minAgeDays: over.minAgeDays ?? PRUNE_DEFAULT_MIN_AGE_DAYS,
    now: NOW,
  });

Deno.test("the Electron this aio ships is never offered, at any age", () => {
  // The single property that makes the verb safe to run: every app on this
  // machine is being moved onto DEFAULT_ELECTRON_VERSION by `am pin`/`am fix`,
  // so it is the one version that is certainly needed — including for every
  // platform, because a cross-build's runtimes are inputs, not leftovers.
  const ancient = [
    `${DEFAULT_ELECTRON_VERSION}-linux-x64`,
    `${DEFAULT_ELECTRON_VERSION}-win32-x64`,
    `${DEFAULT_ELECTRON_VERSION}-darwin-arm64`,
    `${DEFAULT_ELECTRON_VERSION}-win32-x64.zip`,
  ].map((name) => entry({ name, lastUsed: 0 }));
  for (const days of [0, 1, 30, 365, 10_000]) {
    const p = plan(ancient, { minAgeDays: days });
    assertEquals(
      p.remove.map((d) => d.entry.name),
      [],
      `minAgeDays=${days} offered the shipped runtime`,
    );
    assertEquals(p.freed, 0);
  }
});

Deno.test("--keep protects a version the caller knows an app is pinned to", () => {
  const old = entry({ name: "43.4.1-linux-x64", lastUsed: NOW - 400 * DAY });
  assertEquals(plan([old]).remove.length, 1, "unprotected, it would go");
  const p = plan([old], { keepVersions: ["43.4.1"] });
  assertEquals(p.remove, []);
  assertStringIncludes(p.keep[0]!.why, "pinned");
});

Deno.test("recent use keeps an entry, and the boundary is not off by one", () => {
  const at = (days: number) =>
    entry({ name: "43.4.1-linux-x64", lastUsed: NOW - days * DAY });
  assertEquals(plan([at(29)]).remove.length, 0, "29 days is not 30");
  assertEquals(plan([at(30)]).remove.length, 1, "30 days is 30");
  assertEquals(plan([at(31)]).remove.length, 1);
});

Deno.test("unknown is not unused — an entry with no timestamp is kept", () => {
  const p = plan([
    entry({ name: "43.4.1-linux-x64", lastUsed: null, lastUsedSource: "none" }),
  ]);
  assertEquals(p.remove, []);
  assertStringIncludes(p.keep[0]!.why, "unknown is not unused");
});

Deno.test("a lock is never touched — another process may hold it", () => {
  // Deleting a lock while its holder is mid-download is how two processes end
  // up unpacking into one directory.
  const p = plan([
    entry({ name: "43.4.1-linux-x64.lock", lastUsed: 0, bytes: 0 }),
  ]);
  assertEquals(p.remove, []);
  assertStringIncludes(p.keep[0]!.why, "lock");
});

Deno.test("aio's own older one-word platform names are recognised, not orphaned", () => {
  // `electronCacheDir` has a `?? platform` fallback, so older aio wrote
  // `43.4.0-macos` and `43.4.0-windows`. Filing those under "not ours" made
  // 670 MB permanently unreclaimable on the machine this was found on.
  assertEquals(parseCacheName("43.4.0-macos"), {
    version: "43.4.0",
    slug: "macos",
  });
  assertEquals(cacheEntryKind("43.4.0-windows"), "runtime");
  assertEquals(
    plan([entry({ name: "43.4.0-macos", lastUsed: NOW - 90 * DAY })])
      .remove.length,
    1,
  );
  // …and a name aio never writes still falls on the safe side.
  assertEquals(parseCacheName("some-other-thing").version, null);
  assertEquals(cacheEntryKind("some-other-thing"), "other");
  assertEquals(
    plan([entry({ name: "some-other-thing", lastUsed: 0 })]).remove,
    [],
  );
});

Deno.test("nothing the plan did not name is ever deleted", async () => {
  const root = await tempDir("aio-prune-");
  try {
    const keepDir = join(root, `${DEFAULT_ELECTRON_VERSION}-linux-x64`);
    const goDir = join(root, "43.4.1-linux-x64");
    for (const d of [keepDir, goDir]) {
      await Deno.mkdir(d, { recursive: true });
      await Deno.writeTextFile(join(d, "electron"), "x".repeat(1000));
    }
    // Both look ancient; only the unprotected one may go.
    const old = new Date(NOW - 400 * DAY);
    await Deno.writeTextFile(
      join(goDir, RUNTIME_USE_STAMP),
      old.toISOString(),
    );
    await Deno.writeTextFile(
      join(keepDir, RUNTIME_USE_STAMP),
      old.toISOString(),
    );
    const p = plan(await readElectronCache(root));
    assertEquals(p.remove.map((d) => d.entry.name), ["43.4.1-linux-x64"]);

    const result = await applyElectronPrune(p);
    assertEquals(result.failed, []);
    assertEquals(result.removed, [goDir]);
    assertEquals((await Deno.stat(keepDir)).isDirectory, true);
    await Deno.stat(goDir).then(
      () => assert(false, "the plan's entry is still there"),
      () => {},
    );
  } finally {
    await dropTempDir(root);
  }
});

Deno.test("a launch stamps the runtime, and the stamp beats the mtime", async () => {
  const dir = await tempDir("aio-stamp-");
  try {
    // No stamp: the directory's own mtime stands in, and says so.
    const before = await runtimeLastUsed(dir);
    assert(before);
    assertEquals(before.source, "mtime");

    await touchRuntimeUse(dir);
    const after = await runtimeLastUsed(dir);
    assert(after);
    assertEquals(after.source, "stamp");
    assert(
      Math.abs(after.at.getTime() - Date.now()) < 60_000,
      "the stamp is the launch time",
    );

    // A corrupt stamp must not be read as "the epoch" — that would offer a
    // live runtime for deletion. It falls back to the mtime instead.
    await Deno.writeTextFile(join(dir, RUNTIME_USE_STAMP), "not a date");
    assertEquals((await runtimeLastUsed(dir))?.source, "mtime");
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("touching a runtime never throws, whatever the filesystem says", async () => {
  // It runs on every launch. A read-only cache, a full disk or a vanished
  // directory must cost a stamp, never the app opening. Throwing IS the
  // failure here, so the assertion is on what happened afterwards: nothing.
  const gone = "/definitely/not/a/directory/on/this/machine";
  await touchRuntimeUse(gone);
  assertEquals(
    await runtimeLastUsed(gone),
    null,
    "it must not have created anything on the way past",
  );
});

Deno.test("prune flags: --yes is the only one that deletes, bad values refuse", () => {
  assertEquals(parsePruneArgs([]).apply, false);
  assertEquals(parsePruneArgs([]).days, PRUNE_DEFAULT_MIN_AGE_DAYS);
  assertEquals(parsePruneArgs(["--yes"]).apply, true);
  assertEquals(parsePruneArgs(["-y"]).apply, true);
  assertEquals(parsePruneArgs(["--days=7"]).days, 7);
  assertEquals(parsePruneArgs(["--keep=43.4.1,41.2.1"]).keep, [
    "43.4.1",
    "41.2.1",
  ]);
  // A number we cannot read decides whether 250 MB stays. It is a refusal.
  assert(parsePruneArgs(["--days=x"]).error);
  assert(parsePruneArgs(["--days=-1"]).error);
  assert(parsePruneArgs(["--days=1.5"]).error);
});

Deno.test("the report names every entry it would remove, with its reason", () => {
  const p = plan([
    entry({ name: "43.4.1-linux-x64", lastUsed: NOW - 90 * DAY }),
    entry({ name: `${DEFAULT_ELECTRON_VERSION}-linux-x64`, lastUsed: NOW }),
  ]);
  const text = renderPrunePlan(p, NOW);
  assertStringIncludes(text, "43.4.1-linux-x64");
  assertStringIncludes(text, "last used 90 days ago");
  assertStringIncludes(text, "Nothing has been deleted");
  assertStringIncludes(text, "am prune --yes");
  // The offline warning is the whole reason this is not automatic.
  assertStringIncludes(text, "OFFLINE");
  // Every line of the plan carries a reason — a verdict without one is a
  // verdict nobody can check before acting on it.
  for (const d of [...p.remove, ...p.keep]) assert(d.why.length > 10, d.why);
});

Deno.test("sizes are readable, and the total is the sum of the parts", () => {
  assertEquals(humanBytes(0), "0 B");
  assertEquals(humanBytes(1023), "1023 B");
  assertEquals(humanBytes(1024 * 1024 * 250), "250 MB");
  const p = plan([
    entry({ name: "43.4.1-linux-x64", bytes: 100, lastUsed: 0 }),
    entry({ name: "43.4.0-linux-x64", bytes: 250, lastUsed: 0 }),
    entry({ name: `${DEFAULT_ELECTRON_VERSION}-linux-x64`, bytes: 7 }),
  ]);
  assertEquals(p.total, 357);
  assertEquals(p.freed, 350);
});

Deno.test({
  name: "`am prune` with no --yes deletes nothing, and --yes deletes the plan",
  // This case runs the real `am` binary as a subprocess; Deno counts the
  // child's pipes against this test and the runtime closes them after
  // `output()` resolves, not before the sanitizer looks.
  // aio-ok: a real subprocess's pipes, closed by the runtime after output().
  sanitizeResources: false,
  fn: async () => {
    // The report-only default is the whole promise of the verb, so it is
    // checked through the REAL command line against a REAL cache directory —
    // not through the planner, which is where a wiring mistake would hide.
    const cache = await tempDir("aio-prune-cli-");
    try {
      const root = join(cache, "aio", "tools", "electron");
      const stale = join(root, "41.2.1-linux-x64");
      const shipped = join(root, `${DEFAULT_ELECTRON_VERSION}-linux-x64`);
      for (const d of [stale, shipped]) {
        await Deno.mkdir(d, { recursive: true });
        await Deno.writeTextFile(join(d, "electron"), "binary");
        await Deno.writeTextFile(
          join(d, RUNTIME_USE_STAMP),
          new Date(Date.now() - 400 * DAY).toISOString(),
        );
      }
      const run = async (args: string[]) => {
        const out = await new Deno.Command(Deno.execPath(), {
          args: ["run", "-A", "src/am.ts", "prune", "--json", ...args],
          env: { ...Deno.env.toObject(), XDG_CACHE_HOME: cache },
          stdout: "piped",
          stderr: "piped",
        }).output();
        const text = new TextDecoder().decode(out.stdout).trim();
        // The WHOLE of stdout is the document — am's `--json` contract
        // (tests/am-json-contract.test.ts). Printing the plan and then the
        // result would be two, which is why `--yes` folds both into one.
        return JSON.parse(text);
      };

      const report = await run([]);
      assertEquals(report.applied, false);
      assertEquals(report.removed, []);
      assertEquals(
        report.plan.filter((p: { keep: boolean }) => !p.keep)
          .map((p: { name: string }) => p.name),
        ["41.2.1-linux-x64"],
      );
      assertEquals(
        (await Deno.stat(stale)).isDirectory,
        true,
        "a report deleted a runtime",
      );

      const done = await run(["--yes"]);
      // One document, carrying BOTH what was planned and what was removed —
      // `--yes` means "I have decided", never "do not tell me what you did".
      assertEquals(done.applied, true);
      assertEquals(done.removed, [stale]);
      assertEquals(
        done.plan.filter((p: { keep: boolean }) => !p.keep)
          .map((p: { name: string }) => p.name),
        ["41.2.1-linux-x64"],
      );
      await Deno.stat(stale).then(
        () => assert(false, "--yes left the entry it named"),
        () => {},
      );
      assertEquals((await Deno.stat(shipped)).isDirectory, true);
    } finally {
      await dropTempDir(cache);
    }
  },
});
