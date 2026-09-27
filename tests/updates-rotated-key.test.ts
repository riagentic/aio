// Hunt r10: a key rotated OUT of the roster is still trusted forever by every
// install that pinned it on first use.
//
// `UpdatesConfig.keys` documents rotation as: "publish the next release signed
// by the NEW key while the old one is still listed, then drop the old one."
// But the runtime builds its expectations as `key: config.key ?? trust.key`,
// `keys: config.keys` — and `trustedKeys` UNIONS them. On a TOFU install
// (the default: no `key` in config) `trust.key` is the old key pinned on first
// use, so dropping it from `keys` changes nothing: a release signed by the
// retired (e.g. leaked) key is still verified and OFFERED.
//
// The explicit form does not have this hole — `updates: { key: NEW }` replaces
// the pin outright (`config.key ?? trust.key`) — so the same statement of
// trust means two different things depending on which field carries it.
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { buildShipManifest, generateSigningKey } from "../src/build/ship.ts";
import { createUpdatesRuntime } from "../src/server/updates-runtime.ts";
import { resolveUpdates } from "../src/server/updates-core.ts";
import { writeTrust } from "../src/server/updates-check.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import type { Log } from "../src/diagnostics/logger.ts";

const silentLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Log;
const platform = { os: Deno.build.os, arch: Deno.build.arch };

Deno.test("hunt r10: a key dropped from updates.keys is no longer trusted on a TOFU install", async () => {
  const oldKey = await generateSigningKey();
  const newKey = await generateSigningKey();
  const bytes = new TextEncoder().encode("#!/bin/sh\necho 2.0.0\n");
  // A release signed by the RETIRED key.
  const manifest = await buildShipManifest({
    name: "app",
    version: "2.0.0",
    binary: bytes,
    sources: [],
    sign: oldKey,
    channel: "prod",
    target: "binary",
    platform,
    url: "app-2.0.0",
  });
  const port = freePort();
  const server = Deno.serve(
    { port, hostname: "127.0.0.1", onListen: () => {} },
    (req) =>
      new URL(req.url).pathname.endsWith(".json")
        ? new Response(JSON.stringify(manifest))
        : new Response(bytes),
  );
  const root = await tempDir("aio-r10-rotkey-");
  try {
    const dataDir = join(root, "data");
    await Deno.mkdir(dataDir, { recursive: true });
    const artifact = join(root, "app");
    await Deno.writeTextFile(artifact, "#!/bin/sh\necho 1.0.0\n");
    // The install pinned the old key on first use, long ago.
    writeTrust(dataDir, { key: oldKey.publicKey });

    // Rotation finished: the app now lists ONLY the new key.
    const rt = createUpdatesRuntime({
      config: resolveUpdates({
        source: `http://127.0.0.1:${port}`,
        channel: "prod",
        keys: [newKey.publicKey],
      }),
      dataDir,
      appName: "app",
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
    const got = await rt.check({ dismissed: null });
    assertEquals(
      got.kind,
      "error",
      `a release signed by the key rotated out of updates.keys must be ` +
        `refused, got ${JSON.stringify(got)}`,
    );
  } finally {
    await server.shutdown();
    await dropTempDir(root);
  }
});
