// A Windows Electron release is TWO install kinds: the self-contained `.exe`
// (`binary`, in the platform's `windows-x86_64.json`) and the `.zip`
// (`electron-zip`). An install unpacked from the zip refuses a `binary`
// release, so while publish shipped only the exe's manifest, every zip install
// saw every release as "incompatible", forever. Publish now writes
// `<os>-<arch>.electron-zip.json` beside it; a zip install reads that first
// and falls back to the platform's manifest when the channel has none.
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { join, toFileUrl } from "@std/path";
import { buildShipManifest, kindManifestFileName } from "../src/build/ship.ts";
import {
  installManifestUrl,
  kindManifestUrl,
} from "../src/server/updates-check.ts";
import { manifestUrl, resolveUpdates } from "../src/server/updates-core.ts";
import { createUpdatesRuntime } from "../src/server/updates-runtime.ts";
import type { Log } from "../src/diagnostics/logger.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { freePort } from "../src/testing/server-test.ts";

const platform = { os: Deno.build.os, arch: Deno.build.arch };
const silentLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Log;

Deno.test("kind manifest: the client asks for the name publish writes", () => {
  const base = manifestUrl("https://r.example/rel", "prod", platform);
  assertEquals(
    kindManifestUrl(base, "electron-zip"),
    `https://r.example/rel/prod/${
      kindManifestFileName(platform, "electron-zip")
    }`,
  );
});

/** A file:// channel with the exe's manifest and, optionally, the zip's. */
async function channel(withKind: boolean) {
  const root = await tempDir("aio-kind-manifest-");
  const dir = join(root, "prod");
  await Deno.mkdir(dir, { recursive: true });
  const write = async (target: "binary" | "electron-zip", name: string) => {
    const m = await buildShipManifest({
      name: "app",
      version: "2.0.0",
      binary: new TextEncoder().encode(`APP 2.0.0 ${target}`),
      sources: [],
      channel: "prod",
      target,
      platform,
      url: target === "binary" ? "app.exe" : "app.zip",
    });
    await Deno.writeTextFile(join(dir, name), JSON.stringify(m));
  };
  await write("binary", `${platform.os}-${platform.arch}.json`);
  if (withKind) {
    await write("electron-zip", kindManifestFileName(platform, "electron-zip"));
  }
  return { root, source: toFileUrl(root).href };
}

Deno.test("kind manifest: an electron-zip install reads its own, else the platform's", async () => {
  for (const withKind of [true, false]) {
    const { root, source } = await channel(withKind);
    try {
      const base = manifestUrl(source, "prod", platform);
      assertEquals(
        await installManifestUrl(base, "electron-zip"),
        withKind ? kindManifestUrl(base, "electron-zip") : base,
      );
      // Every other kind reads the platform's manifest, unprobed.
      assertEquals(await installManifestUrl(base, "binary"), base);
    } finally {
      await dropTempDir(root);
    }
  }
});

Deno.test("kind manifest: a zip install is OFFERED the zip release beside a binary one", async () => {
  const { root, source } = await channel(true);
  try {
    const dataDir = join(root, "data");
    await Deno.mkdir(dataDir);
    const rt = createUpdatesRuntime({
      config: resolveUpdates({ source, channel: "prod", allowUnsigned: true }),
      dataDir,
      appVersion: "1.0.0",
      local: { schema: 1, cells: {} },
      exposed: false,
      log: silentLog,
      argv: [],
      installedTarget: "electron-zip",
      canInstall: ["electron-zip"],
      exit: () => {},
      relaunch: () => {},
      shutdown: () => Promise.resolve(),
    });
    const r = await rt.check({ dismissed: null });
    assertEquals(r.kind, "offer", JSON.stringify(r));
  } finally {
    await dropTempDir(root);
  }
});

// Over HTTP an absent kind manifest is a status, not a throw — and not always
// 404: a private S3 bucket answers 403 for a key that does not exist. Any
// non-2xx keeps the platform's manifest, exactly as before the kind existed.
Deno.test("kind manifest: over HTTP only a 2xx kind manifest is read", async () => {
  for (const status of [200, 403, 404, 500]) {
    const port = freePort();
    const server = Deno.serve(
      { port, hostname: "127.0.0.1", onListen: () => {} },
      (req) =>
        new URL(req.url).pathname.endsWith(".electron-zip.json")
          ? new Response("{}", { status })
          : new Response("{}"),
    );
    try {
      const base = manifestUrl(`http://127.0.0.1:${port}`, "prod", platform);
      assertEquals(
        await installManifestUrl(base, "electron-zip"),
        status === 200 ? kindManifestUrl(base, "electron-zip") : base,
        `HTTP ${status}`,
      );
    } finally {
      await server.shutdown();
    }
  }
});

// Every channel published before the kind manifest existed answers "absent"
// on every check: the probe must not double its requests for good. Only "no
// such file" (404, 410) is believed for a day; a 403, a 408, a 429 or a 5xx
// can be a bad moment, and is asked again.
Deno.test("kind manifest: a channel that answered absent is not asked again each check", async () => {
  const cases = [[404, 1], [410, 1], [403, 2], [408, 2], [429, 2], [500, 2]];
  for (const [status, probes] of cases) {
    const port = freePort();
    let asked = 0;
    const server = Deno.serve(
      { port, hostname: "127.0.0.1", onListen: () => {} },
      (req) =>
        new URL(req.url).pathname.endsWith(".electron-zip.json")
          ? (asked++, new Response("{}", { status }))
          : new Response("{}"),
    );
    try {
      const base = manifestUrl(
        `http://127.0.0.1:${port}/absent-${status}`,
        "prod",
        platform,
      );
      for (let i = 0; i < 2; i++) {
        assertEquals(await installManifestUrl(base, "electron-zip"), base);
      }
      assertEquals(asked, probes, `HTTP ${status}`);
    } finally {
      await server.shutdown();
    }
  }
});

// A probe that times out has heard nothing — not "absent". Reading the
// platform's manifest on it offered a zip install the `.exe` it refuses, on
// every check of a slow channel; and it would wait the manifest's deadline a
// second time. The check fails instead, after ONE deadline.
Deno.test("kind manifest: a probe that times out fails the check — never the platform's manifest", async () => {
  const port = freePort();
  const { promise: release, resolve } = Promise.withResolvers<void>();
  let platformAsked = false;
  const server = Deno.serve(
    { port, hostname: "127.0.0.1", onListen: () => {} },
    async (req) => {
      if (!new URL(req.url).pathname.endsWith(".electron-zip.json")) {
        platformAsked = true;
      }
      await release;
      return new Response("{}");
    },
  );
  try {
    const base = manifestUrl(`http://127.0.0.1:${port}`, "prod", platform);
    const e = await assertRejects(() =>
      installManifestUrl(base, "electron-zip", 300)
    );
    assertStringIncludes(String(e), "did not answer within 0.3s");
    assertEquals(platformAsked, false);
  } finally {
    resolve();
    await server.shutdown();
  }
});

// A channel that answers slower than a few seconds (and inside the manifest
// deadline) is heard: its kind manifest is read.
Deno.test("kind manifest: a slow channel's answer is waited for, like the manifest's", async () => {
  const port = freePort();
  const server = Deno.serve(
    { port, hostname: "127.0.0.1", onListen: () => {} },
    async () => (
      await new Promise((r) => setTimeout(r, 6_000)), new Response("{}")
    ),
  );
  try {
    const base = manifestUrl(`http://127.0.0.1:${port}`, "prod", platform);
    assertEquals(
      await installManifestUrl(base, "electron-zip"),
      kindManifestUrl(base, "electron-zip"),
    );
  } finally {
    await server.shutdown();
  }
});
