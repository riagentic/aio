// boot-facts.test.ts — the startup report answers "what am I running?" without
// anyone having to guess, and never states something it did not read.
import { assert, assertEquals } from "@std/assert";
import { bootLines, buildFacts } from "../src/server/boot-facts.ts";

const facts = {
  build: "compiled" as const,
  target: "appimage" as const,
  artifact: "/opt/wallet/wallet-x86_64.AppImage",
  platform: "linux/x86_64",
  runtime: "deno 2.9.1",
};

function asMap(pairs: [string, string][]): Record<string, string> {
  return Object.fromEntries(pairs);
}

Deno.test("boot report: reads the artifact from the process, not from config", () => {
  const f = buildFacts();
  // Under `deno test` the executable IS deno, so this must report source.
  assertEquals(f.build, "source");
  assertEquals(f.target, "source");
  assertEquals(f.platform, `${Deno.build.os}/${Deno.build.arch}`);
  assert(f.runtime.startsWith("deno "));
});

Deno.test("boot report: names the build, the target and the file on disk", () => {
  const m = asMap(bootLines(facts));
  assertEquals(m.build, "compiled (appimage)");
  // Running from source, the target adds nothing — don't say it twice.
  assertEquals(
    asMap(bootLines({ ...facts, build: "source", target: "source" })).build,
    "source",
  );
  // The path matters: inside an AppImage the executable is a temporary mount,
  // and the file a user (or an update) must touch is the .AppImage itself.
  assertEquals(m.artifact, "/opt/wallet/wallet-x86_64.AppImage");
  assertEquals(m.platform, "linux/x86_64 · deno 2.9.1");
});

Deno.test("boot report: an app with no update path says so", () => {
  // Silence would leave it to be discovered at the moment an update is needed.
  assertEquals(asMap(bootLines(facts)).updates, "not configured");
});

Deno.test("boot report: update config is stated in units a human can act on", () => {
  const m = asMap(bootLines(facts, {
    updates: {
      source: "https://rel.example.com/wallet",
      kind: "manifest",
      channel: "prod",
      intervalMs: 21_600_000,
      auto: false,
    },
  }));
  assertEquals(m.updates, "prod · manifest · every 6h · ask first");
  assertEquals(m.source, "https://rel.example.com/wallet");
});

Deno.test("boot report: 'manual' beats '0ms', and auto-install is spelled out", () => {
  const m = asMap(bootLines(facts, {
    updates: {
      source: "https://github.com/you/app",
      kind: "git",
      channel: "main",
      intervalMs: 0,
      auto: true,
    },
  }));
  assertEquals(m.updates, "main · git · manual · auto-install");
});

Deno.test("boot report: minutes for sub-hour cadences", () => {
  const m = asMap(bootLines(facts, {
    updates: {
      source: "file:///mnt/rel",
      kind: "manifest",
      channel: "dev",
      intervalMs: 60_000,
      auto: false,
    },
  }));
  assert(m.updates!.includes("every 1m"));
});

Deno.test("boot report: data dir, protocol and cells appear only when known", () => {
  const bare = asMap(bootLines(facts));
  assertEquals(bare.data, undefined);
  assertEquals(bare.cells, undefined);
  assertEquals(bare.protocol, undefined);

  const full = asMap(bootLines(facts, {
    dataDir: "/home/u/.wallet",
    protocol: 3,
    cells: ["wallet", "prices"],
  }));
  assertEquals(full.data, "/home/u/.wallet");
  assertEquals(full.protocol, "v3");
  assertEquals(full.cells, "2 (wallet, prices)");
});

Deno.test("boot report: order is stable, so logs diff cleanly across boots", () => {
  const labels = bootLines(facts, {
    dataDir: "/d",
    protocol: 3,
    cells: ["a"],
    updates: {
      source: "s",
      kind: "manifest",
      channel: "prod",
      intervalMs: 3_600_000,
      auto: false,
    },
  }).map(([k]) => k);
  assertEquals(labels, [
    "build",
    "artifact",
    "platform",
    "protocol",
    "data",
    "cells",
    "updates",
    "source",
  ]);
});

// ── "Where is it defined?" ───────────────────────────────────────────────────
// The question that prompted this: an app's client target can come from a
// --flag, aio.run(), deno.json, or nothing at all — and the running app was the
// one thing that could not say which. A value without its source sends someone
// to grep three files for the one that won.

const linesOf = (extra: Parameters<typeof bootLines>[1]) =>
  Object.fromEntries(bootLines(facts, extra));

Deno.test("boot: a resolved value names who decided it", () => {
  const l = linesOf({
    client: { value: "electron", from: "deno.json" },
    port: { value: 8000, from: "flag" },
  });
  assertEquals(l.client, "electron (deno.json)");
  assertEquals(l.port, "8000 (flag)");
});

Deno.test("boot: `default` is spelled out, never implied by silence", () => {
  // "The default" is exactly the case people misremember, so it is the one
  // that most needs saying.
  const l = linesOf({ client: { value: "electron", from: "default" } });
  assertEquals(l.client, "electron (default)");
});

Deno.test("boot: the bind address says what it MEANS", () => {
  // `expose: true` only implied the posture; 0.0.0.0 vs 127.0.0.1 is the whole
  // security difference and deserves words, not inference.
  assertEquals(
    linesOf({ bind: "0.0.0.0 — every interface" }).bind,
    "0.0.0.0 — every interface",
  );
});

Deno.test("boot: what is NOT ordinary about the cells is stated", () => {
  // A worker cell runs on its own thread and a synced cell has a second
  // writer. Both change how a symptom is read, and neither was visible without
  // opening the source.
  const l = linesOf({
    cells: ["ledger", "index", "prefs"],
    workers: ["index"],
    syncCells: ["ledger"],
  });
  assertEquals(l.cells, "3 (ledger, index, prefs)");
  assertEquals(l.workers, "index");
  assertEquals(l.sync, "ledger");
});

Deno.test("boot: nothing extra is invented when there is nothing to say", () => {
  // An empty extras block must not produce empty lines — "absent" and
  // "unknown" read identically in a log, which is the thing being removed.
  const l = linesOf({ cells: [], workers: [], syncCells: [], routes: 0 });
  assertEquals("workers" in l, false);
  assertEquals("sync" in l, false);
  assertEquals("routes" in l, false);
  assertEquals("client" in l, false);
  assertEquals("pid" in l, false);
});

Deno.test("boot: the operational lines a support thread starts with", () => {
  const l = linesOf({
    pid: 4242,
    heap: "8.0 GB max of 32.0 GB RAM",
    logs: { dir: "/home/u/.wallet/logs", level: "debug" },
    journal: "/home/u/.wallet/data/journal",
    tls: "self-signed",
    routes: 3,
    serverFns: ["billing", "admin"],
  });
  assertEquals(l.pid, "4242");
  assertEquals(l.heap, "8.0 GB max of 32.0 GB RAM");
  assertEquals(l.logs, "/home/u/.wallet/logs · debug");
  assertEquals(l.journal, "/home/u/.wallet/data/journal");
  assertEquals(l.tls, "self-signed");
  assertEquals(l.routes, "3");
  assertEquals(l.serverfns, "billing, admin");
});
