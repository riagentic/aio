// Trust-on-first-use pins a release signing key only when the transport the
// key arrived over authenticates the host (`transportAuthenticatesHost`).
//
// The manifest fetch FOLLOWS REDIRECTS, and the check was made against the
// CONFIGURED URL only. A source that redirects to plain http off this machine
// (a CDN or mirror that downgrades) delivered the manifest over a leg anyone on
// the path can rewrite — and the key it carried was pinned forever, because
// the URL that was judged was the one that never served the body.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { buildShipManifest, generateSigningKey } from "../src/build/ship.ts";
import { createUpdatesRuntime } from "../src/server/updates-runtime.ts";
import { resolveUpdates } from "../src/server/updates-core.ts";
import { fetchManifest, readTrust } from "../src/server/updates-check.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import type { Log } from "../src/diagnostics/logger.ts";

const platform = { os: Deno.build.os, arch: Deno.build.arch };
const silentLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Log;

/** This machine's first non-loopback IPv4 — a plain-http host that is NOT
 *  loopback, reached without leaving the machine. */
const lanIp = Deno.networkInterfaces().find((i) =>
  i.family === "IPv4" && !i.address.startsWith("127.")
)?.address;

Deno.test({
  name:
    "updates: a manifest redirected to plain http off-machine never pins its key",
  ignore: lanIp === undefined,
  async fn() {
    const dataDir = await tempDir("aio-tofu-redirect-");
    const keys = await generateSigningKey();
    const manifest = await buildShipManifest({
      name: "app",
      version: "2.0.0",
      binary: new TextEncoder().encode("APP 2.0.0"),
      sources: [],
      sign: keys,
      channel: "prod",
      target: "binary",
      platform,
      url: "app-2.0.0",
      data: { schema: 1, cells: {} },
    });
    const portB = await freePort();
    const mirror = Deno.serve(
      { hostname: lanIp!, port: portB, onListen: () => {} },
      () => Response.json(manifest),
    );
    const portA = await freePort();
    const origin = Deno.serve(
      { hostname: "127.0.0.1", port: portA, onListen: () => {} },
      (req) =>
        Response.redirect(
          `http://${lanIp}:${portB}${new URL(req.url).pathname}`,
          302,
        ),
    );
    try {
      const source = `http://127.0.0.1:${portA}`;
      const got = await fetchManifest(
        `${source}/prod/${platform.os}-${platform.arch}.json`,
        undefined,
        { allowCrossOrigin: true },
      );
      assertEquals(got.kind, "ok");
      assertEquals(
        got.kind === "ok" && got.pinnable,
        false,
        "the body came over plain http to a non-loopback host",
      );

      const rt = createUpdatesRuntime({
        config: resolveUpdates({ source, channel: "prod" }),
        dataDir,
        appVersion: "1.0.0",
        local: { schema: 1, cells: {} },
        exposed: false,
        log: silentLog,
        argv: [],
        canInstall: ["binary"],
        exit: () => {},
        relaunch: () => {},
        shutdown: () => Promise.resolve(),
        snapshot: () => Promise.resolve(),
      });
      const res = await rt.check({ dismissed: null });
      assertEquals(res.kind, "error", JSON.stringify(res));
      assertStringIncludes(
        (res as { error: string }).error,
        "unauthenticated transport",
      );
      assert(readTrust(dataDir).key === undefined, "no key was pinned");
    } finally {
      await origin.shutdown();
      await mirror.shutdown();
      await dropTempDir(dataDir);
    }
  },
});
