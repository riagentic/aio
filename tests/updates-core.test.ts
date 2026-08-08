// updates-core.test.ts — the rules that decide whether a user is ever offered
// an update. Pure functions, so every branch is reachable without a network.
import { assert, assertEquals, assertThrows } from "@std/assert";
import type { DataContract, ShipManifest } from "../src/build/ship.ts";
import {
  classifySource,
  compareVersions,
  dataCompatibility,
  decide,
  decideGit,
  defaultInterval,
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

Deno.test("updates channel: the artifact's stamp is the default, and is overridable", () => {
  // The stamp is what stops a test build from updating itself into prod.
  assertEquals(resolveChannel({ stamp: "test" }), "test");
  assertEquals(resolveChannel({}), "prod");
  // Most specific wins, in order.
  assertEquals(resolveChannel({ stamp: "test", config: "beta" }), "beta");
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
  manifestVersion: 2,
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

Deno.test("decide: a target this install cannot apply is refused with the reason", () => {
  const d = decide({
    current: "1.0.0",
    manifest: manifest({ target: "android" }),
    local,
    canInstall,
  });
  assertEquals(d.kind, "refused");
  if (d.kind === "refused") assert(d.reason.includes("OS"));
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
