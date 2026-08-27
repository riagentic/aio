// updates-core.test.ts — the rules that decide whether a user is ever offered
// an update. Pure functions, so every branch is reachable without a network.
import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import type { DataContract, ShipManifest } from "../src/build/ship.ts";
import {
  classifySource,
  compareVersions,
  dataCompatibility,
  decide,
  decideGit,
  defaultInterval,
  isComparableVersion,
  isPrerelease,
  manifestUrl,
  resolveChannel,
  resolveUpdates,
} from "../src/server/updates-core.ts";

// ── config ──────────────────────────────────────────────────────────────────

Deno.test("updates config: a bare URL is the whole configuration", () => {
  const r = resolveUpdates("https://rel.example.com/wallet/", {
    stamp: "prod",
  });
  assertEquals(r.source, "https://rel.example.com/wallet"); // trailing / trimmed
  assertEquals(r.kind, "manifest");
  assertEquals(r.channel, "prod");
  assertEquals(r.auto, false); // never install unasked by default
  assertEquals(r.allowUnsigned, false);
  assertEquals(r.intervalMs, 21_600_000);
});

Deno.test("updates config: check toggles between never, default and explicit", () => {
  const base = { source: "https://r.example.com/a" };
  assertEquals(resolveUpdates({ ...base, check: false }).intervalMs, 0);
  assertEquals(
    resolveUpdates({ ...base, check: true }, { stamp: "dev" }).intervalMs,
    60_000,
  );
  assertEquals(resolveUpdates({ ...base, check: 5000 }).intervalMs, 5000);
});

Deno.test("updates config: poll cadence is per channel, not one size", () => {
  assertEquals(defaultInterval("dev"), 60_000);
  assertEquals(defaultInterval("test"), 300_000);
  assertEquals(defaultInterval("prod"), 21_600_000);
  // An unknown channel is far more likely a release channel than a dev one.
  assertEquals(defaultInterval("stable"), 21_600_000);
});

Deno.test("updates channel: the artifact's STAMP outranks the config literal", () => {
  // The stamp is what stops a test build from updating itself into prod.
  assertEquals(resolveChannel({ stamp: "test" }), "test");
  assertEquals(resolveChannel({}), "prod");

  // THE ORDER THAT MATTERS. A source tree carries `updates: { channel: "prod" }`
  // and every build made from it carries a stamp; the stamp says what THIS
  // artifact is. Letting the literal win meant a build stamped `test` followed
  // the prod channel and updated itself into the prod release — the tester
  // loses the build they were testing, silently, which is the exact failure the
  // stamp exists to prevent. The old order did that, while the comment above
  // `resolveChannel` claimed the opposite.
  assertEquals(resolveChannel({ stamp: "test", config: "beta" }), "test");
  // …and the config literal is still the default when nothing stamped one.
  assertEquals(resolveChannel({ config: "beta" }), "beta");

  // Per-install and per-run overrides still win, most specific first.
  assertEquals(
    resolveChannel({ stamp: "test", config: "beta", pinned: "prod" }),
    "prod",
  );
  assertEquals(
    resolveChannel({ stamp: "test", pinned: "prod", env: "dev" }),
    "dev",
  );
  assertEquals(
    resolveChannel({ stamp: "test", pinned: "prod", env: "dev", flag: "test" }),
    "test",
  );
});

Deno.test("updates config: `check` must be a poll interval, or it is refused", () => {
  const base = { source: "https://r.example.com/a" };
  // `-1` used to resolve to intervalMs -1, which the scheduler reads as "never
  // poll" — an app that believes it checks hourly and has never checked at all.
  assertThrows(
    () => resolveUpdates({ ...base, check: -1 }),
    Error,
    "check: -1",
  );
  // `NaN` used to reach setTimeout, which treats it as 0: a tight loop against
  // somebody's release host, from every install that shipped with it.
  assertThrows(
    () => resolveUpdates({ ...base, check: Number.NaN }),
    Error,
    "check: NaN",
  );
  assertThrows(
    () => resolveUpdates({ ...base, check: 999 }),
    Error,
    ">= 1000",
  );
  assertThrows(
    () => resolveUpdates({ ...base, check: Number.POSITIVE_INFINITY }),
    Error,
    "is not a poll interval",
  );
  // The message names what to write instead.
  assertThrows(
    () => resolveUpdates({ ...base, check: 0 }),
    Error,
    "updates.check()",
  );
  // The legitimate values are untouched.
  assertEquals(resolveUpdates({ ...base, check: 1000 }).intervalMs, 1000);
  assertEquals(resolveUpdates({ ...base, check: false }).intervalMs, 0);
});

Deno.test("updates source: git and manifest are inferred only when unambiguous", () => {
  assertEquals(classifySource("https://github.com/you/app"), "git");
  assertEquals(classifySource("https://example.com/repo.git"), "git");
  assertEquals(classifySource("git@github.com:you/app.git"), "git");
  assertEquals(classifySource("https://rel.example.com/wallet"), "manifest");
  assertEquals(classifySource("file:///mnt/releases/wallet"), "manifest");
  // A deep forge path could be either — refuse rather than pick.
  assertThrows(
    () => classifySource("https://github.com/you/app/releases/latest"),
    Error,
    "cannot tell",
  );
  // An explicit kind always wins.
  assertEquals(
    classifySource("https://github.com/you/app/releases", "manifest"),
    "manifest",
  );
});

Deno.test("updates source: a git source follows a ref, defaulting to main", () => {
  const r = resolveUpdates("https://github.com/you/app", { stamp: "prod" });
  assertEquals(r.kind, "git");
  // "prod" is not a ref that exists anywhere by default; following it would
  // read to the user as "no updates, ever".
  assertEquals(r.channel, "main");
  assertEquals(
    resolveUpdates({ source: "https://github.com/you/app", channel: "release" })
      .channel,
    "release",
  );
});

Deno.test("updates: manifest URL is channel + platform scoped", () => {
  assertEquals(
    manifestUrl("https://r.example.com/w/", "prod", {
      os: "linux",
      arch: "x86_64",
    }),
    "https://r.example.com/w/prod/linux-x86_64.json",
  );
});

// ── versions ────────────────────────────────────────────────────────────────

Deno.test("updates: semver comparison, including prerelease ordering", () => {
  assertEquals(compareVersions("1.2.3", "1.2.3"), 0);
  assertEquals(compareVersions("1.2.4", "1.2.3"), 1);
  assertEquals(compareVersions("1.10.0", "1.9.0"), 1); // not lexical
  assertEquals(compareVersions("2.0.0", "1.99.99"), 1);
  assertEquals(compareVersions("v1.2.3", "1.2.3"), 0); // leading v tolerated
  // A release outranks its own prereleases.
  assertEquals(compareVersions("1.0.0", "1.0.0-rc.1"), 1);
  assertEquals(compareVersions("1.0.0-rc.2", "1.0.0-rc.1"), 1);
  assertEquals(compareVersions("1.0.0-alpha.9", "1.0.0-alpha.10"), -1); // numeric
  assertEquals(compareVersions("1.0.0-alpha", "1.0.0-alpha.1"), -1);
  assert(isPrerelease("1.0.0-alpha53"));
  assert(!isPrerelease("1.0.0"));
});

// ── the data gate ───────────────────────────────────────────────────────────

const contract = (
  cells: Record<string, [number, number]>,
  schema = 1,
): DataContract => ({
  schema,
  cells: Object.fromEntries(
    Object.entries(cells).map(([k, [version, migratesFrom]]) => [
      k,
      { version, migratesFrom },
    ]),
  ),
});

Deno.test("data gate: same schema installs cleanly, with no migration", () => {
  const v = dataCompatibility(
    { schema: 1, cells: { todos: 2 } },
    contract({ todos: [2, 1] }),
  );
  assertEquals(v.ok, true);
  assertEquals(v.migrates, false);
});

Deno.test("data gate: a covered migration is allowed and flagged for backup", () => {
  const v = dataCompatibility(
    { schema: 1, cells: { todos: 1 } },
    contract({ todos: [3, 1] }), // writes v3, migrates from v1
  );
  assertEquals(v.ok, true);
  assertEquals(v.migrates, true); // → the applier takes a backup first
});

Deno.test("data gate: a version bump with NO migration path is BLOCKED", () => {
  // The whole point: bumping a cell version and forgetting onMigrate stops
  // being a data-loss incident at the user's boot and becomes an update they
  // are simply never offered.
  const v = dataCompatibility(
    { schema: 1, cells: { todos: 1 } },
    contract({ todos: [2, 2] }), // writes v2, can only read v2
  );
  assertEquals(v.ok, false);
  assertEquals(v.blockers.length, 1);
  assert(v.blockers[0]!.includes("cannot migrate"));
  assert(v.blockers[0]!.includes("todos"));
});

Deno.test("data gate: a release older than the data on disk is blocked", () => {
  const v = dataCompatibility(
    { schema: 1, cells: { todos: 4 } },
    contract({ todos: [3, 1] }),
  );
  assertEquals(v.ok, false);
  assert(v.blockers[0]!.includes("goes backwards"));
});

Deno.test("data gate: a persistence schema downgrade is blocked", () => {
  const v = dataCompatibility(
    { schema: 3, cells: {} },
    contract({}, 2),
  );
  assertEquals(v.ok, false);
  assert(v.blockers[0]!.includes("persistence schema"));
});

Deno.test("data gate: a removed cell warns but does not block", () => {
  // The rows are not deleted — they stop being read. That is the author's
  // deliberate choice, so it is said out loud rather than refused.
  const v = dataCompatibility(
    { schema: 1, cells: { todos: 1, legacy: 1 } },
    contract({ todos: [1, 1] }),
  );
  assertEquals(v.ok, true);
  assertEquals(v.warnings.length, 1);
  assert(v.warnings[0]!.includes("legacy"));
});

Deno.test("data gate: an undeclared contract blocks when there IS data at risk", () => {
  // Nothing persisted → nothing to break.
  assertEquals(
    dataCompatibility({ schema: 1, cells: {} }, undefined).ok,
    true,
  );
  // Data persisted and no promise about it → refuse to guess.
  const v = dataCompatibility({ schema: 1, cells: { todos: 2 } }, undefined);
  assertEquals(v.ok, false);
  assert(v.blockers[0]!.includes("does not declare"));
});

// ── the decision ────────────────────────────────────────────────────────────

const manifest = (over: Partial<ShipManifest> = {}): ShipManifest => ({
  manifestVersion: 3,
  name: "app",
  version: "2.0.0",
  sha256: "0".repeat(64),
  size: 10,
  capabilities: {
    net: true,
    read: true,
    write: true,
    ffi: false,
    env: false,
    run: false,
    sys: false,
  },
  runFlags: [],
  channel: "prod",
  target: "appimage",
  platform: { os: "linux", arch: "x86_64" },
  releasedAt: "2026-08-08T00:00:00.000Z",
  data: contract({ todos: [1, 1] }),
  ...over,
});

const local = { schema: 1, cells: { todos: 1 } };
const canInstall = ["appimage" as const];

Deno.test("decide: a newer, compatible release is offered", () => {
  const d = decide({
    current: "1.0.0",
    manifest: manifest(),
    local,
    canInstall,
  });
  assertEquals(d.kind, "offer");
  if (d.kind === "offer") assertEquals(d.version, "2.0.0");
});

Deno.test("decide: same or older is simply current, not an error", () => {
  assertEquals(
    decide({ current: "2.0.0", manifest: manifest(), local, canInstall }).kind,
    "current",
  );
  // What a channel switch looks like from the old side.
  assertEquals(
    decide({ current: "3.0.0", manifest: manifest(), local, canInstall }).kind,
    "current",
  );
});

Deno.test("decide: an incompatible release is reported, never offered", () => {
  // The user is told a newer version exists AND why they cannot take it —
  // silence here would read as "you are up to date".
  const d = decide({
    current: "1.0.0",
    manifest: manifest({ data: contract({ todos: [2, 2] }) }),
    local,
    canInstall,
  });
  assertEquals(d.kind, "incompatible");
  if (d.kind === "incompatible") {
    assertEquals(d.version, "2.0.0");
    assert(d.blockers[0]!.includes("cannot migrate"));
  }
});

Deno.test("decide: minFrom forces a stepping-stone release", () => {
  const d = decide({
    current: "1.0.0",
    manifest: manifest({ minFrom: "1.5.0" }),
    local,
    canInstall,
  });
  assertEquals(d.kind, "incompatible");
  if (d.kind === "incompatible") assert(d.blockers[0]!.includes("1.5.0"));
});

Deno.test("decide: prereleases are skipped unless asked for", () => {
  const m = manifest({ version: "2.0.0-rc.1" });
  assertEquals(
    decide({ current: "1.0.0", manifest: m, local, canInstall }).kind,
    "current",
  );
  assertEquals(
    decide({
      current: "1.0.0",
      manifest: m,
      local,
      canInstall,
      prerelease: true,
    })
      .kind,
    "offer",
  );
});

Deno.test("decide: a dismissed version stays dismissed until a newer one lands", () => {
  const base = { current: "1.0.0", local, canInstall };
  assertEquals(
    decide({ ...base, manifest: manifest(), dismissed: "2.0.0" }).kind,
    "current",
  );
  assertEquals(
    decide({
      ...base,
      manifest: manifest({ version: "2.1.0" }),
      dismissed: "2.0.0",
    })
      .kind,
    "offer",
  );
});

Deno.test("decide: an Android release is INFORMATION carrying the link, not an error", () => {
  // An APK is installed by the system installer — an app cannot replace its
  // own. That is not an error, it is a thing the user can do, and the one field
  // that makes it actionable is the URL the old refusal did not carry.
  const d = decide({
    current: "1.0.0",
    manifest: manifest({ target: "android" }),
    local,
    canInstall,
    artifactUrl: "https://rel.example.com/app/prod/app.apk",
  });
  assertEquals(d.kind, "incompatible");
  if (d.kind === "incompatible") {
    assertEquals(d.version, "2.0.0");
    assertStringIncludes(
      d.blockers[0]!,
      "https://rel.example.com/app/prod/app.apk",
    );
    assertStringIncludes(d.blockers[0]!, "system installer");
  }
});

Deno.test("decide: a target this install cannot apply names what it CAN apply", () => {
  const d = decide({
    current: "1.0.0",
    manifest: manifest({ target: "electron-zip" }),
    local,
    canInstall,
  });
  assertEquals(d.kind, "refused");
  if (d.kind === "refused") {
    assertStringIncludes(d.reason, "electron-zip");
    assertStringIncludes(d.reason, "appimage"); // …and what this install is
  }
});

Deno.test("decide: installability is judged AFTER the version, so an up-to-date app is quiet", () => {
  // Asked first (as it was), an Android manifest made every up-to-date Android
  // install show a permanent "cannot install" notice — for a release it was
  // already running.
  const d = decide({
    current: "2.0.0",
    manifest: manifest({ target: "android" }),
    local,
    canInstall,
  });
  assertEquals(d.kind, "current");
});

Deno.test("decideGit: a moved ref is an offer; the same sha is current", () => {
  const head = { sha: "abcdef1234567890", ref: "main" };
  assertEquals(
    decideGit({ currentSha: "abcdef1234567890", head }).kind,
    "current",
  );
  const d = decideGit({ currentSha: "0000000000000000", head });
  assertEquals(d.kind, "offer");
  if (d.kind === "offer") {
    assertEquals(d.version, "abcdef12");
    // The data gate cannot run before the build — say so rather than imply safety.
    assert(d.warnings[0]!.includes("after the build"));
  }
});

Deno.test("decideGit: an install with no recorded commit is refused, not guessed", () => {
  const d = decideGit({ currentSha: null, head: { sha: "aa", ref: "main" } });
  assertEquals(d.kind, "refused");
  if (d.kind === "refused") assert(d.reason.includes("does not record"));
});

// ── the gate refuses what it cannot check ────────────────────────────────
//
// `dataCompatibility` is the last thing between a release and an app's data —
// "anything it cannot prove safe becomes a blocker". The manifest reaches it as
// `JSON.parse(text) as ShipManifest`, a cast with no validation, so a
// mis-published or older-format release could hand it a contract with no
// `schema` (where `undefined < local.schema` is false, so the backwards-schema
// blocker could never fire — the release was judged SAFE) or `{}` (a TypeError
// thrown from inside the gate). Both are refusals now.
Deno.test("dataCompatibility: a malformed contract is a blocker, not a pass", () => {
  const local = { schema: 3, cells: { todo: 2 } };
  const malformed: unknown[] = [
    {},
    { cells: { todo: { version: 2, migratesFrom: 1 } } }, // no schema
    { schema: 3 }, // no cells
    { schema: "3", cells: {} }, // schema of the wrong type
    { schema: 3, cells: { todo: { version: 2 } } }, // cell without migratesFrom
    { schema: 3, cells: { todo: "2" } },
    [],
  ];
  for (const contract of malformed) {
    const v = dataCompatibility(local, contract as never);
    assertEquals(v.ok, false, `must refuse: ${JSON.stringify(contract)}`);
    assertEquals(v.blockers.length, 1);
    assertStringIncludes(v.blockers[0]!, "malformed");
    assertStringIncludes(v.blockers[0]!, "aio ship"); // …and how to fix it
  }
  // A well-formed one still passes, and a backwards schema is still the
  // blocker it always was — the new check must not swallow the real ones.
  assertEquals(
    dataCompatibility(local, {
      schema: 3,
      cells: { todo: { version: 2, migratesFrom: 1 } },
    }).ok,
    true,
  );
  assertStringIncludes(
    dataCompatibility(local, { schema: 2, cells: {} }).blockers[0]!,
    "goes backwards",
  );
});

Deno.test("updates config: prerelease follows the dev channel by default, and the key is real", () => {
  const src = "https://rel.example.com/wallet";
  // dev is the channel you ship alphas into; every other channel is a release
  // channel where a prerelease is an accident until somebody says otherwise.
  assertEquals(
    resolveUpdates({ source: src, channel: "dev" }).prerelease,
    true,
  );
  assertEquals(
    resolveUpdates({ source: src, channel: "test" }).prerelease,
    false,
  );
  assertEquals(
    resolveUpdates({ source: src, channel: "prod" }).prerelease,
    false,
  );
  assertEquals(resolveUpdates({ source: src }).prerelease, false);
  // Explicit wins in both directions.
  assertEquals(
    resolveUpdates({ source: src, channel: "dev", prerelease: false })
      .prerelease,
    false,
  );
  assertEquals(
    resolveUpdates({ source: src, channel: "prod", prerelease: true })
      .prerelease,
    true,
  );
});

// ── the version table ───────────────────────────────────────────────────────
//
// One table, because every entry in it was a real, silent wrong answer.

Deno.test("compareVersions: build metadata takes no part in precedence", () => {
  // `1.2.3+build-1` used to be split on the FIRST `-`, so the build tag became
  // a "prerelease": it sorted BELOW the release it was a build of, and
  // `isPrerelease` said yes — which on any non-dev channel meant the release
  // was silently filtered out and never offered to anyone.
  assertEquals(compareVersions("1.2.3+build-1", "1.2.3"), 0);
  assertEquals(compareVersions("1.2.3+a", "1.2.3+b"), 0);
  assertEquals(compareVersions("1.2.4+build-1", "1.2.3"), 1);
  assertEquals(compareVersions("v1.2.3+sha.abc", "1.2.3"), 0);
  assert(!isPrerelease("1.2.3+build-1"));
  assert(!isPrerelease("1.2.3+rc-1")); // still build metadata, still not a pre

  // Two prereleases differing only in build metadata are the same prerelease —
  // string-compared (as they were) they ordered by the sha, which is noise.
  assertEquals(compareVersions("1.0.0-rc.1+aaa", "1.0.0-rc.1+zzz"), 0);
  assertEquals(compareVersions("1.0.0-rc.2+aaa", "1.0.0-rc.1+zzz"), 1);
  assert(isPrerelease("1.0.0-rc.1+aaa"));
});

Deno.test("compareVersions: an unorderable string is REFUSED, never read as 0.0.0", () => {
  // `Number.parseInt(n, 10) || 0` turned every string it could not read into
  // 0.0.0. A compiled binary that cannot determine its own version reports
  // "unknown (compiled binary …)" — which compared as older than every release
  // ever published, so `auto: true` downloaded, swapped, restarted, still could
  // not read its version, and did it again. Forever.
  for (
    const bad of [
      "unknown (compiled binary aio)",
      "",
      "latest",
      "main",
      "v",
      "1.2.3-",
      " 1.2.3 extra",
    ]
  ) {
    assert(!isComparableVersion(bad), `must be unorderable: ${bad}`);
    assertThrows(
      () => compareVersions("2.0.0", bad),
      Error,
      "cannot order the version",
    );
    // …and the string itself is in the message, so it can be searched for.
    assertThrows(() => compareVersions(bad, "2.0.0"), Error, bad || '""');
  }
  for (
    const good of [
      "1",
      "1.2",
      "1.2.3",
      "v1.2.3",
      "1.2.3-rc.1",
      "1.2.3+b",
      "1.2.3-rc.1+b",
    ]
  ) {
    assert(isComparableVersion(good), `must be orderable: ${good}`);
  }
});

Deno.test("decide: an app that does not know its own version refuses to compare", () => {
  const d = decide({
    current: "unknown (compiled binary myapp)",
    manifest: manifest(),
    local,
    canInstall,
  });
  assertEquals(d.kind, "refused");
  if (d.kind === "refused") {
    assertStringIncludes(d.reason, "unknown (compiled binary myapp)");
    assertStringIncludes(d.reason, "deno.json");
  }
});

Deno.test("decide: a release whose version is not a version is refused, naming it", () => {
  const d = decide({
    current: "1.0.0",
    manifest: manifest({ version: "latest" }),
    local,
    canInstall,
  });
  assertEquals(d.kind, "refused");
  if (d.kind === "refused") {
    assertStringIncludes(d.reason, '"latest"');
    assertStringIncludes(d.reason, "aio ship");
  }
});

// ── the headline: a new BUILD of the same version ───────────────────────────

Deno.test("decide: same version, DIFFERENT bytes is an offer", () => {
  // The update people actually ship most often, and until this it was
  // undetectable: `cmp === 0` answered "you are the latest" and no digest of
  // the installed artifact existed anywhere to contradict it.
  const d = decide({
    current: "2.0.0",
    manifest: manifest({ sha256: "b".repeat(64) }),
    local: { ...local, installedSha256: "a".repeat(64) },
    canInstall,
  });
  assertEquals(d.kind, "offer");
  if (d.kind === "offer") {
    assertEquals(d.version, "2.0.0");
    assertStringIncludes(d.reason, "same version, new build");
    // Both digests are named, truncated, so a publisher can tell WHICH build.
    assertStringIncludes(d.reason, "bbbbbbbbbbbb");
    assertStringIncludes(d.reason, "aaaaaaaaaaaa");
  }
});

Deno.test("decide: same version, same bytes is current", () => {
  const sha = "a".repeat(64);
  const d = decide({
    current: "2.0.0",
    manifest: manifest({ sha256: sha }),
    local: { ...local, installedSha256: sha },
    canInstall,
  });
  assertEquals(d.kind, "current");
  if (d.kind === "current") assertStringIncludes(d.reason, "is the latest");
});

Deno.test("decide: an UNKNOWN installed digest never becomes an offer", () => {
  // Never offer on ignorance. An install that predates the digest being
  // recorded would otherwise re-download its own bytes once on every channel
  // that does not bump a version — forever.
  const d = decide({
    current: "2.0.0",
    manifest: manifest({ sha256: "b".repeat(64) }),
    local, // no installedSha256
    canInstall,
  });
  assertEquals(d.kind, "current");
  // …and it SAYS it cannot see that class of update, rather than implying it
  // checked and found nothing.
  if (d.kind === "current") {
    assertStringIncludes(d.reason, "no recorded artifact digest");
  }
});

Deno.test("decide: a same-version rebuild still passes every gate", () => {
  const rebuilt = { ...local, installedSha256: "a".repeat(64) };
  const newBytes = { sha256: "b".repeat(64) };

  // The data gate still applies…
  const blockedByData = decide({
    current: "2.0.0",
    manifest: manifest({ ...newBytes, data: contract({ todos: [2, 2] }) }),
    local: rebuilt,
    canInstall,
  });
  assertEquals(blockedByData.kind, "incompatible");

  // …and so does installability…
  const wrongTarget = decide({
    current: "2.0.0",
    manifest: manifest({ ...newBytes, target: "electron-zip" }),
    local: rebuilt,
    canInstall,
  });
  assertEquals(wrongTarget.kind, "refused");

  // …but NOT the prerelease filter: this app already IS that prerelease, and
  // filtering it would refuse to repair the very build the user is running.
  const pre = decide({
    current: "2.0.0-rc.1",
    manifest: manifest({ ...newBytes, version: "2.0.0-rc.1" }),
    local: rebuilt,
    canInstall,
    prerelease: false,
  });
  assertEquals(pre.kind, "offer");

  // A dismissal DOES cover a rebuild of the dismissed version — the user said
  // no to 2.0.0, and a differently-built 2.0.0 is still 2.0.0. `undismiss()`
  // is the way back.
  const dismissed = decide({
    current: "2.0.0",
    manifest: manifest(newBytes),
    local: rebuilt,
    canInstall,
    dismissed: "2.0.0",
  });
  assertEquals(dismissed.kind, "current");
});

// ── the one-way doors ───────────────────────────────────────────────────────

Deno.test("decide: minFrom says WHERE to get the stepping stone, not just its version", () => {
  const d = decide({
    current: "1.0.0",
    manifest: manifest({ minFrom: "1.5.0" }),
    local,
    canInstall,
    source: "https://rel.example.com/wallet",
  });
  assertEquals(d.kind, "incompatible");
  if (d.kind === "incompatible") {
    assertStringIncludes(d.blockers[0]!, "1.5.0");
    // A version with no way to get it is a dead end; the location is the fix.
    assertStringIncludes(
      d.blockers[0]!,
      "https://rel.example.com/wallet/prod/",
    );
  }
  // With no source configured it still says something a person can act on,
  // rather than naming a version and stopping.
  const bare = decide({
    current: "1.0.0",
    manifest: manifest({ minFrom: "1.5.0" }),
    local,
    canInstall,
  });
  if (bare.kind === "incompatible") {
    assertStringIncludes(bare.blockers[0]!, "publishes releases to");
  }
});

Deno.test("decide: a minFrom that is not a version is refused, not ignored", () => {
  const d = decide({
    current: "1.0.0",
    manifest: manifest({ minFrom: "the-one-with-the-new-db" }),
    local,
    canInstall,
  });
  assertEquals(d.kind, "refused");
  if (d.kind === "refused") {
    assertStringIncludes(d.reason, "the-one-with-the-new-db");
  }
});

Deno.test("decide: every offer carries a reason in the words the user sees", () => {
  const d = decide({
    current: "1.0.0",
    manifest: manifest(),
    local,
    canInstall,
  });
  if (d.kind === "offer") {
    assertStringIncludes(d.reason, "2.0.0 is newer than 1.0.0");
  }
  const g = decideGit({
    currentSha: "0".repeat(16),
    head: { sha: "abcdef1234567890", ref: "main" },
  });
  if (g.kind === "offer") assertStringIncludes(g.reason, "main moved to");
});

Deno.test("updates config: the veto and the key roster survive resolution", () => {
  const canApply = () => false;
  const keys = [{ kty: "OKP", crv: "Ed25519", x: "a" }];
  const r = resolveUpdates({
    source: "https://rel.example.com/w",
    canApply,
    keys,
  });
  assertEquals(r.canApply, canApply);
  assertEquals(r.keys, keys);
  // Absent by default — an app with no opinion gets no hook, not a stub.
  assertEquals(resolveUpdates("https://rel.example.com/w").canApply, undefined);
});
