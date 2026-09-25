// A cached "you are current" ETag is a verdict about ONE install version on
// ONE manifest URL. It used to be sent regardless: a newer install cached the
// manifest's tag, an older binary started on the same data dir (a downgrade, a
// second copy, a reinstall) sent it, got a 304, and was told it was the latest
// while the manifest it never re-read carried a newer release.
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { buildShipManifest, generateSigningKey } from "../src/build/ship.ts";
import { createUpdatesRuntime } from "../src/server/updates-runtime.ts";
import { resolveUpdates } from "../src/server/updates-core.ts";
import { readTrust } from "../src/server/updates-check.ts";
import { freePort } from "../src/testing/server-test.ts";
import type { Log } from "../src/diagnostics/logger.ts";
import { tempDir } from "../src/testing/temp-dir.ts";

const platform = { os: Deno.build.os, arch: Deno.build.arch };
const silentLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Log;

/** A CDN-like host: serves an ETag, answers a matching `if-none-match` 304. */
async function releaseHost(version: string) {
  const keys = await generateSigningKey();
  const bytes = new TextEncoder().encode(`APP ${version}`);
  const manifest = await buildShipManifest({
    name: "app",
    version,
    binary: bytes,
    sources: [],
    sign: keys,
    channel: "prod",
    target: "binary",
    platform,
    url: `app-${version}`,
    data: { schema: 1, cells: { todos: { version: 1, migratesFrom: 1 } } },
  });
  const body = JSON.stringify(manifest);
  const etag = `"rel-${version}"`;
  const port = freePort();
  const server = Deno.serve(
    { port, hostname: "127.0.0.1", onListen: () => {} },
    (req) => {
      if (new URL(req.url).pathname.endsWith(".json")) {
        if (req.headers.get("if-none-match") === etag) {
          return new Response(null, { status: 304, headers: { etag } });
        }
        return new Response(body, {
          headers: { etag, "content-type": "application/json" },
        });
      }
      return new Response(bytes);
    },
  );
  return {
    source: `http://127.0.0.1:${port}`,
    stop: () => server.shutdown(),
  };
}

function runtimeFor(
  source: string,
  appVersion: string,
  dataDir: string,
  artifact: string,
) {
  return createUpdatesRuntime({
    config: resolveUpdates({ source, channel: "prod", allowUnsigned: true }),
    dataDir,
    appVersion,
    local: { schema: 1, cells: { todos: 1 } },
    exposed: false,
    log: silentLog,
    argv: [],
    artifact,
    canInstall: ["binary"],
    exit: () => {},
    relaunch: () => {},
    shutdown: () => Promise.resolve(),
  });
}

Deno.test("updates: a cached 'current' ETag does not tell an OLDER install on the same data dir it is the latest", async () => {
  const host = await releaseHost("2.0.0");
  const root = await tempDir("aio-upd-etag-bound-");
  const dataDir = join(root, "data");
  await Deno.mkdir(dataDir, { recursive: true });
  try {
    // The 2.0.0 install checks: current, and the verdict is cached.
    const v2 = join(root, "app-v2");
    await Deno.writeTextFile(v2, "APP 2.0.0");
    const first = await runtimeFor(host.source, "2.0.0", dataDir, v2)
      .check({ dismissed: null });
    assertEquals(first.kind, "current");
    assertEquals(readTrust(dataDir).etagCurrent, `"rel-2.0.0"`);

    // A 1.0.0 binary on the same data dir must be OFFERED 2.0.0 — not handed
    // a 304 that was the answer to a different install's question.
    const v1 = join(root, "app-v1");
    await Deno.writeTextFile(v1, "APP 1.0.0");
    const older = await runtimeFor(host.source, "1.0.0", dataDir, v1)
      .check({ dismissed: null });
    assertEquals(
      older.kind,
      "offer",
      `a 1.0.0 install must see the 2.0.0 release, got ${
        JSON.stringify(older)
      }`,
    );
  } finally {
    await host.stop();
  }
});
