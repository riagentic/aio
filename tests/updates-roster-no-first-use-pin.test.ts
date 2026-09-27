// A configured `updates.keys` roster replaces the first-use pin
// (`expectations()` drops the pinned key under a roster). The pin itself still
// ran on every check — `expect.key` is always undefined under a roster — so
// each check rewrote update-trust.json and logged the loud "trusting … on
// first use" line again (3 checks, 3 warnings), and over plain http to a LAN
// host `pinKey`'s transport refusal made every check an error. A roster
// install pins nothing; a no-roster install pins exactly once.
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { buildShipManifest, generateSigningKey } from "../src/build/ship.ts";
import { createUpdatesRuntime } from "../src/server/updates-runtime.ts";
import { resolveUpdates } from "../src/server/updates-core.ts";
import { readTrust } from "../src/server/updates-check.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import type { Log } from "../src/diagnostics/logger.ts";

const platform = { os: Deno.build.os, arch: Deno.build.arch };

async function firstUseWarns(roster: boolean): Promise<{
  warns: number;
  pinned: boolean;
  kinds: string[];
}> {
  const key = await generateSigningKey();
  const bytes = new TextEncoder().encode("#!/bin/sh\necho 1.0.0\n");
  // The CURRENT version, so every check answers "current" (no offer state).
  const manifest = await buildShipManifest({
    name: "app",
    version: "1.0.0",
    binary: bytes,
    sources: [],
    sign: key,
    channel: "prod",
    target: "binary",
    platform,
    url: "app-1.0.0",
  });
  const port = freePort();
  const server = Deno.serve(
    { port, hostname: "127.0.0.1", onListen: () => {} },
    (req) =>
      new URL(req.url).pathname.endsWith(".json")
        ? new Response(JSON.stringify(manifest))
        : new Response(bytes),
  );
  const root = await tempDir("aio-roster-pin-");
  let warns = 0;
  const log = {
    info: () => {},
    warn: (_c: string, msg: string) => {
      if (msg.includes("on first use")) warns++;
    },
    error: () => {},
    debug: () => {},
  } as unknown as Log;
  try {
    const dataDir = join(root, "data");
    await Deno.mkdir(dataDir, { recursive: true });
    const artifact = join(root, "app");
    await Deno.writeFile(artifact, bytes);
    const rt = createUpdatesRuntime({
      config: resolveUpdates({
        source: `http://127.0.0.1:${port}`,
        channel: "prod",
        ...(roster ? { keys: [key.publicKey] } : {}),
      }),
      dataDir,
      appName: "app",
      appVersion: "1.0.0",
      local: { schema: 1, cells: {} },
      exposed: false,
      log,
      argv: [],
      artifact,
      canInstall: ["binary"],
      exit: () => {},
      relaunch: () => {},
      shutdown: () => Promise.resolve(),
    });
    const kinds: string[] = [];
    for (let i = 0; i < 2; i++) {
      kinds.push((await rt.check({ dismissed: null })).kind);
    }
    return { warns, pinned: !!readTrust(dataDir).key, kinds };
  } finally {
    await server.shutdown();
    await dropTempDir(root);
  }
}

Deno.test("updates: a keys roster install pins nothing and never warns 'first use'", async () => {
  const r = await firstUseWarns(true);
  assertEquals(r.kinds, ["current", "current"]);
  assertEquals(r.warns, 0, "a roster replaces the first-use pin");
  assertEquals(r.pinned, false, "update-trust.json holds no pinned key");
});

Deno.test("updates: a no-roster install pins on first use exactly once", async () => {
  const r = await firstUseWarns(false);
  assertEquals(r.kinds, ["current", "current"]);
  assertEquals(r.warns, 1);
  assertEquals(r.pinned, true);
});
