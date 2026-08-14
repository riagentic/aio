// The ETag cache may only remember ONE decision: "you are current".
//
// It used to be written after every successful fetch, including one that
// produced an OFFER. The next check then sent `if-none-match`, got a 304, and
// reported `current` — the cell cleared `available` and the update went
// invisible. The ETag is on disk, so it stayed invisible across every future
// boot: an app that had already SEEN the release could never be told about it
// again, while an app that had not seen it updated normally.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { buildShipManifest, generateSigningKey } from "../src/build/ship.ts";
import { createUpdatesRuntime } from "../src/server/updates-runtime.ts";
import { resolveUpdates } from "../src/server/updates-core.ts";
import { readTrust } from "../src/server/updates-check.ts";
import { freePort } from "../src/testing/server-test.ts";
import type { Log } from "../src/diagnostics/logger.ts";

const platform = { os: Deno.build.os, arch: Deno.build.arch };
const silentLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Log;

/** A release host that behaves like a CDN: it serves an ETag and honours
 *  `if-none-match` with a 304. */
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
  const conditional: boolean[] = []; // one entry per manifest request
  const port = freePort();
  const server = Deno.serve(
    { port, hostname: "127.0.0.1", onListen: () => {} },
    (req) => {
      const url = new URL(req.url);
      if (url.pathname.endsWith(".json")) {
        const sent = req.headers.get("if-none-match");
        conditional.push(sent === etag);
        if (sent === etag) {
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
    conditional,
    stop: () => server.shutdown(),
  };
}

async function runtimeFor(source: string, appVersion: string) {
  const root = await Deno.makeTempDir({ prefix: "aio-upd-etag-" });
  const dataDir = join(root, "data");
  await Deno.mkdir(dataDir, { recursive: true });
  const artifact = join(root, "app");
  await Deno.writeTextFile(artifact, "APP");
  return {
    dataDir,
    rt: createUpdatesRuntime({
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
    }),
  };
}

Deno.test("updates: an unresolved OFFER is never short-circuited by a 304", async () => {
  const host = await releaseHost("2.0.0");
  try {
    const { rt, dataDir } = await runtimeFor(host.source, "1.0.0");
    const first = await rt.check();
    assertEquals(first.kind, "offer", "v2 is offered to a v1 install");

    assertEquals(
      readTrust(dataDir).etagCurrent,
      undefined,
      "an offer is unresolved — nothing about it may be cached",
    );

    const second = await rt.check();
    assertEquals(
      second.kind,
      "offer",
      "the SAME offer must still be there on the next check, and every one " +
        "after it, until it is installed",
    );
    assertEquals(
      host.conditional,
      [false, false],
      "no conditional request may be sent while an offer is outstanding",
    );
  } finally {
    await host.stop();
  }
});

Deno.test("updates: 'you are current' IS cached — the next check costs a 304", async () => {
  const host = await releaseHost("1.0.0");
  try {
    const { rt, dataDir } = await runtimeFor(host.source, "1.0.0");
    const first = await rt.check();
    assertEquals(first.kind, "current");
    const cached = readTrust(dataDir).etagCurrent;
    assert(cached, "the one cacheable decision is cached");

    const second = await rt.check();
    assertEquals(second.kind, "current");
    assertEquals(
      host.conditional,
      [false, true],
      "the second check asks conditionally — that is the point of the cache",
    );
  } finally {
    await host.stop();
  }
});

// The heal: an install whose old `etag` was poisoned by the bug must not stay
// blind. The field is simply not read any more.
Deno.test("updates: a legacy poisoned `etag` is ignored, so a hidden offer reappears", async () => {
  const host = await releaseHost("2.0.0");
  try {
    const { rt, dataDir } = await runtimeFor(host.source, "1.0.0");
    const { writeTrust } = await import("../src/server/updates-check.ts");
    writeTrust(dataDir, { etag: `"rel-2.0.0"` }); // what the bug left behind
    const res = await rt.check();
    assertEquals(res.kind, "offer", "the offer is visible again");
    assertEquals(host.conditional, [false], "the poisoned tag was not sent");
  } finally {
    await host.stop();
  }
});
