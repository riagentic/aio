// An install whose binary reports a different version than its signed
// manifest was offered that release again on every check.
//
// `aio ship` stamps the release version from the repo (or `--version=`), not
// from the artifact — so a build shipped a commit later is signed as 1.0.1
// while its binary says 1.0.0. Every install took it, booted reporting 1.0.0,
// and `decide()` offered 1.0.1 again: with `auto: true` a download→swap→
// restart loop, forever. Three layers now refuse it, each by name:
//   - decide(): the installed digest IS the release's → not an offer;
//   - the applier's smoke test: `--version` must name the signed version;
//   - ship: refuses to sign a version the binary does not report.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  decide,
  reportedVersions,
  resolveUpdates,
} from "../src/server/updates-core.ts";
import { smokeTestArtifact } from "../src/server/updates-apply.ts";
import {
  buildShipManifest,
  generateSigningKey,
  shipApp,
  type ShipManifest,
} from "../src/build/ship.ts";
import { createUpdatesRuntime } from "../src/server/updates-runtime.ts";
import type { Log } from "../src/diagnostics/logger.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { programBytes, writeProgram } from "./fake-program-helper.ts";

const silentLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Log;

const SHA = "ab".repeat(32);

function manifest(version: string): ShipManifest {
  return {
    name: "notes",
    version,
    channel: "prod",
    target: "binary",
    sha256: SHA,
    releasedAt: "2026-11-01T00:00:00.000Z",
    url: "notes",
  } as unknown as ShipManifest;
}

Deno.test("decide: the installed artifact IS the release, but reports another version → not offered, named", () => {
  const verdict = decide({
    current: "1.0.0",
    manifest: manifest("1.0.1"),
    // Case-blind, like every digest compare.
    local: { schema: 1, cells: {}, installedSha256: SHA.toUpperCase() },
    canInstall: ["binary"],
  });
  assertEquals(verdict.kind, "current", JSON.stringify(verdict));
  const reason = (verdict as { reason: string }).reason;
  assertStringIncludes(reason, "1.0.1");
  assertStringIncludes(reason, "reports itself as 1.0.0");
  assertStringIncludes(reason, "aio ship");
});

Deno.test("decide: a different digest at a newer version is still offered", () => {
  const verdict = decide({
    current: "1.0.0",
    manifest: manifest("1.0.1"),
    local: { schema: 1, cells: {}, installedSha256: "cd".repeat(32) },
    canInstall: ["binary"],
  });
  assertEquals(verdict.kind, "offer");
});

Deno.test("reportedVersions: whole tokens, aio's own version left out", () => {
  assertEquals(reportedVersions("notes 1.0.1 (aio 1.0.27-beta)\n"), ["1.0.1"]);
  assertEquals(reportedVersions("1.0.10\n").includes("1.0.1"), false);
  assertEquals(reportedVersions("notes (aio 1.0.1)"), []);
});

Deno.test("smokeTestArtifact: refuses an artifact whose --version is not the signed version", async () => {
  const dir = await tempDir("aio-smoke-version-");
  try {
    const bin = join(dir, "notes.new-1.0.1");
    await writeProgram(
      bin,
      `#!/bin/sh\nif [ "$1" = "--version" ]; then echo notes 1.0.0 "(aio 1.0.1)"; exit 0; fi\nexit 0\n`,
    );
    const r = await smokeTestArtifact(bin, { expectVersion: "1.0.1" });
    assert(!r.ok, "a 1.0.0 binary signed as 1.0.1 must be refused");
    assertStringIncludes(r.error, "signed as 1.0.1");
    assertStringIncludes(r.error, "notes 1.0.0");
    assertStringIncludes(r.error, "NOT installed");
    // The same artifact, held to the version it does report, passes.
    assert((await smokeTestArtifact(bin, { expectVersion: "1.0.0" })).ok);
    // …and with no expectation it is the plain runs-at-all check.
    assert((await smokeTestArtifact(bin)).ok);
    // An answer that names no version at all is not this loop (every aio
    // build prints one): warned, not refused.
    const quiet = join(dir, "quiet");
    await writeProgram(quiet, `#!/bin/sh\nexit 0\n`);
    assert((await smokeTestArtifact(quiet, { expectVersion: "1.0.1" })).ok);
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("shipApp: refuses to sign a version the binary does not report", async () => {
  const root = await tempDir("aio-ship-version-");
  const cwd = Deno.cwd();
  try {
    await Deno.writeTextFile(
      join(root, "deno.json"),
      JSON.stringify({ appId: "notes", entry: "src/app.ts" }),
    );
    await Deno.mkdir(join(root, "src"));
    await Deno.writeTextFile(join(root, "src/app.ts"), "export const x = 1;\n");
    const bin = join(root, "notes");
    await writeProgram(
      bin,
      `#!/bin/sh\n` +
        `if [ "$1" = "--aio-data-contract" ]; then echo '{"schema":1,"cells":{}}'; exit 0; fi\n` +
        `if [ "$1" = "--version" ]; then echo notes 1.0.0 "(aio 1.0.27-beta)"; exit 0; fi\n` +
        `exit 0\n`,
    );
    Deno.chdir(root);
    const e = await shipApp({
      binaryPath: bin,
      version: "1.0.1",
      channel: "prod",
      out: join(root, "a.ship.json"),
    }).catch((e) => e as Error);
    assert(e instanceof Error, "a 1.0.0 binary must not be signed as 1.0.1");
    assertStringIncludes(e.message, "reports version 1.0.0");
    assertStringIncludes(e.message, "signed as 1.0.1");
    assertStringIncludes(e.message, "--version=1.0.0");
    // The version it reports signs.
    const m = await shipApp({
      binaryPath: bin,
      version: "1.0.0",
      channel: "prod",
      out: join(root, "b.ship.json"),
    });
    assertEquals(m.version, "1.0.0");
  } finally {
    Deno.chdir(cwd);
    await dropTempDir(root);
  }
});

Deno.test("runtime: the installed artifact IS the release signed as 2.0.0 but reports 1.0.0 → current, named, no loop", async () => {
  const root = await tempDir("aio-upd-version-loop-");
  try {
    const platform = { os: Deno.build.os, arch: Deno.build.arch };
    const dataDir = join(root, "data");
    const channelDir = join(root, "releases", "prod");
    await Deno.mkdir(dataDir, { recursive: true });
    await Deno.mkdir(channelDir, { recursive: true });
    // ONE build, reporting 1.0.0 — installed, and published as 2.0.0.
    const body =
      `#!/bin/sh\nif [ "$1" = "--version" ]; then echo app 1.0.0; exit 0; fi\nexit 0\n`;
    const artifact = join(root, "app");
    await writeProgram(artifact, body);
    const bytes = await programBytes(body);
    const manifest = await buildShipManifest({
      name: "app",
      version: "2.0.0",
      binary: bytes,
      sources: [],
      sign: await generateSigningKey(),
      channel: "prod",
      target: "binary",
      platform,
      url: "app-2.0.0",
      data: { schema: 1, cells: {} },
    });
    await Deno.writeFile(join(channelDir, "app-2.0.0"), bytes);
    await Deno.writeTextFile(
      join(channelDir, `${platform.os}-${platform.arch}.json`),
      JSON.stringify(manifest),
    );
    const rt = () =>
      createUpdatesRuntime({
        config: resolveUpdates({
          source: `file://${join(root, "releases")}`,
          channel: "prod",
        }),
        dataDir,
        appVersion: "1.0.0",
        local: { schema: 1, cells: {} },
        exposed: false,
        log: silentLog,
        argv: [],
        artifact,
        canInstall: ["binary"],
        exit: () => {},
        relaunch: () => {},
        shutdown: () => Promise.resolve(),
      });
    // Every check, not just the first: the loop was the SECOND one.
    for (let i = 0; i < 2; i++) {
      const got = await rt().check({ dismissed: null });
      assertEquals(got.kind, "current", JSON.stringify(got));
      if (got.kind === "current") {
        assertStringIncludes(got.reason, "reports itself as 1.0.0");
      }
    }
  } finally {
    await dropTempDir(root);
  }
});
