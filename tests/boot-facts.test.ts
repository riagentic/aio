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
