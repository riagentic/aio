// the cached "you are current" ETag is bound to {version, url} only.
// A `current` verdict that depended on CONFIG ("X is a prerelease — set
// prerelease: true") is cached, so after the app turns `prerelease: true` on,
// the next check sends the old validator, gets a 304, and reports
// "1.0.0 is the latest" — the prerelease it now follows is never offered.
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { buildShipManifest, generateSigningKey } from "../src/build/ship.ts";
import { createUpdatesRuntime } from "../src/server/updates-runtime.ts";
import { resolveUpdates } from "../src/server/updates-core.ts";
import { freePort } from "../src/testing/server-test.ts";
import type { Log } from "../src/diagnostics/logger.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const platform = { os: Deno.build.os, arch: Deno.build.arch };
const silentLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Log;

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
  return { source: `http://127.0.0.1:${port}`, stop: () => server.shutdown() };
}

function runtimeFor(
  source: string,
  dataDir: string,
  artifact: string,
  prerelease: boolean,
) {
  return createUpdatesRuntime({
    config: resolveUpdates({
      source,
      channel: "prod",
      allowUnsigned: true,
      prerelease,
    }),
    dataDir,
    appVersion: "1.0.0",
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

Deno.test("updates: turning prerelease on is not answered by a 304 cached under prerelease off", async () => {
  const host = await releaseHost("1.1.0-rc.1");
  const root = await tempDir("aio-etag-pre-");
  const dataDir = join(root, "data");
  await Deno.mkdir(dataDir, { recursive: true });
  const art = join(root, "app");
  await Deno.writeTextFile(art, "APP 1.0.0");
  try {
    const off = await runtimeFor(host.source, dataDir, art, false)
      .check({ dismissed: null });
    assertEquals(off.kind, "current", JSON.stringify(off));

    // Same install, same data dir, the app now says `prerelease: true`.
    const on = await runtimeFor(host.source, dataDir, art, true)
      .check({ dismissed: null });
    assertEquals(
      on.kind,
      "offer",
      `prerelease: true must see 1.1.0-rc.1, got ${JSON.stringify(on)}`,
    );
  } finally {
    await host.stop();
    await dropTempDir(root);
  }
});
