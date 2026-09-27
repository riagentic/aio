// Hunt r10: a rollback puts the OLD artifact back but leaves the trust store's
// `installedSha256` naming the build that just FAILED.
//
// `installedSha256` is documented as "the SHA-256 of the artifact this install
// is RUNNING" and is what `decide` uses to detect "same version, new build".
// The applier records the new digest at swap time; `judgePendingUpdate`'s
// rollback restores the previous artifact and never touches the record. (The
// git path clears it for exactly this reason: "a stale digest would be a lie
// about what is installed".)
//
// Consequence: the publisher pulls the broken 2.0.0 and re-publishes 1.0.0 —
// the very bytes the rolled-back install is running — and that install is
// offered "same version, new build" of its own artifact (and with `auto: true`
// downloads it and restarts).
import { assertEquals, assertNotEquals } from "@std/assert";
import { join } from "@std/path";
import { buildShipManifest, sha256Hex } from "../src/build/ship.ts";
import { judgePendingUpdate } from "../src/server/updates-boot.ts";
import { writePending } from "../src/server/updates-apply.ts";
import {
  readTrust,
  recordInstalledSha256,
} from "../src/server/updates-check.ts";
import { decide } from "../src/server/updates-core.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import type { Log } from "../src/diagnostics/logger.ts";

const silentLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Log;

Deno.test("hunt r10: after a rollback the recorded installed digest is not the failed build's", async () => {
  const root = await tempDir("aio-r10-rbdigest-");
  try {
    const dataDir = join(root, "data");
    await Deno.mkdir(dataDir, { recursive: true });
    const oldBytes = new TextEncoder().encode("#!/bin/sh\necho 1.0.0\n");
    const newBytes = new TextEncoder().encode("#!/bin/sh\necho 2.0.0 broken\n");
    const current = join(root, "app");
    const previous = `${current}.old-1.0.0`;
    // State right after a flat swap 1.0.0 → 2.0.0 that never came up healthy:
    // the stable path holds 2.0.0, the kept-aside copy is 1.0.0, the digest of
    // 2.0.0 was recorded, and both boot attempts were spent.
    await Deno.writeFile(current, newBytes);
    await Deno.writeFile(previous, oldBytes);
    const oldSha = await sha256Hex(oldBytes);
    const newSha = await sha256Hex(newBytes);
    recordInstalledSha256(dataDir, newSha);
    writePending(dataDir, {
      from: "1.0.0",
      to: "2.0.0",
      artifact: current,
      previous,
      attempts: 2,
      startedAt: new Date().toISOString(),
    });

    const stop = await judgePendingUpdate(dataDir, silentLog);
    assertEquals(stop, true, "the rollback must run");
    // The rollback itself worked: 1.0.0 is back at the stable path.
    assertEquals(await Deno.readFile(current), oldBytes);

    // …but the install still claims to be running 2.0.0's bytes.
    const recorded = readTrust(dataDir).installedSha256;
    assertNotEquals(
      recorded,
      newSha,
      "installedSha256 still names the build that failed and was rolled back",
    );

    // What that lie costs: the channel re-publishes 1.0.0 with the bytes this
    // install is now running, and it is offered back to itself.
    const m = await buildShipManifest({
      name: "app",
      version: "1.0.0",
      binary: oldBytes,
      sources: [],
      channel: "prod",
      target: "binary",
      platform: { os: Deno.build.os, arch: Deno.build.arch },
    });
    assertEquals(m.sha256, oldSha);
    const d = decide({
      current: "1.0.0",
      manifest: m,
      local: { schema: 1, cells: {}, installedSha256: recorded },
      canInstall: ["binary"],
    });
    assertEquals(
      d.kind,
      "current",
      `the install is running exactly the published 1.0.0, got ${
        JSON.stringify(d)
      }`,
    );
  } finally {
    await dropTempDir(root);
  }
});
