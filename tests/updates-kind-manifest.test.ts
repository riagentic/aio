// A Windows Electron release is TWO install kinds: the self-contained `.exe`
// (`binary`, in the platform's `windows-x86_64.json`) and the `.zip`
// (`electron-zip`). An install unpacked from the zip refuses a `binary`
// release, so while publish shipped only the exe's manifest, every zip install
// saw every release as "incompatible", forever. Publish now writes
// `<os>-<arch>.electron-zip.json` beside it; a zip install reads that first
// and falls back to the platform's manifest when the channel has none.
import { assertEquals, assertStringIncludes } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import { buildShipManifest, kindManifestFileName } from "../src/build/ship.ts";
import {
  fetchInstallManifest,
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
      const zip = await fetchInstallManifest(base, "electron-zip");
      assertEquals(
        zip.url,
        withKind ? kindManifestUrl(base, "electron-zip") : base,
      );
      assertEquals(
        zip.got.kind === "ok" && zip.got.manifest.target,
        withKind ? "electron-zip" : "binary",
      );
      // Every other kind reads the platform's manifest.
      const bin = await fetchInstallManifest(base, "binary");
      assertEquals(bin.url, base);
      assertEquals(bin.got.kind === "ok" && bin.got.manifest.target, "binary");
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

/** A channel over HTTP: every request is counted by path, the platform's
 *  manifest is always served, and `kind` answers for the zip's. */
async function httpChannel(
  kind: (req: Request) => Response | Promise<Response>,
) {
  const texts: Record<string, string> = {};
  for (const target of ["binary", "electron-zip"] as const) {
    texts[target] = JSON.stringify(
      await buildShipManifest({
        name: "app",
        version: "2.0.0",
        binary: new TextEncoder().encode(`APP 2.0.0 ${target}`),
        sources: [],
        channel: "prod",
        target,
        platform,
        url: target === "binary" ? "app.exe" : "app.zip",
      }),
    );
  }
  const port = freePort();
  const asked = { kind: 0, platform: 0 };
  const server = Deno.serve(
    { port, hostname: "127.0.0.1", onListen: () => {} },
    (req) => {
      if (new URL(req.url).pathname.endsWith(".electron-zip.json")) {
        asked.kind++;
        return kind(req);
      }
      asked.platform++;
      return new Response(texts.binary);
    },
  );
  return {
    asked,
    kindText: texts["electron-zip"]!,
    base: (path = "") =>
      manifestUrl(`http://127.0.0.1:${port}${path}`, "prod", platform),
    close: () => server.shutdown(),
  };
}

// Over HTTP an absent kind manifest is a status, not a throw — and not always
// 404: a private S3 bucket answers 403 for a key that does not exist. Any
// non-2xx keeps the platform's manifest, exactly as before the kind existed.
Deno.test("kind manifest: over HTTP only a 2xx kind manifest is read", async () => {
  for (const status of [200, 403, 404, 500]) {
    const ch = await httpChannel(() => new Response(ch.kindText, { status }));
    try {
      const base = ch.base();
      const { url, got } = await fetchInstallManifest(base, "electron-zip");
      assertEquals(
        url,
        status === 200 ? kindManifestUrl(base, "electron-zip") : base,
        `HTTP ${status}`,
      );
      assertEquals(
        got.kind === "ok" && got.manifest.target,
        status === 200 ? "electron-zip" : "binary",
        `HTTP ${status}`,
      );
    } finally {
      await ch.close();
    }
  }
});

// A poll is ONE request. The kind manifest used to be probed for (a GET whose
// body was thrown away) and then fetched: measured on a real channel, 462
// manifest GETs in pairs, two per poll, for as long as the app ran.
Deno.test("kind manifest: a channel that has one is asked ONCE per check — never probed, then fetched", async () => {
  const ch = await httpChannel((req) =>
    req.headers.get("if-none-match") === '"k1"'
      ? new Response(null, { status: 304 })
      : new Response(ch.kindText, { headers: { etag: '"k1"' } })
  );
  const root = await tempDir("aio-kind-manifest-");
  try {
    for (let check = 1; check <= 3; check++) {
      const got = await fetchInstallManifest(ch.base(), "electron-zip");
      assertEquals(got.got.kind, "ok");
      assertEquals(ch.asked, { kind: check, platform: 0 });
    }
    // The same through a whole check of a running install — and its cached
    // validator rides on that one request (a 304 costs no body).
    ch.asked.kind = 0;
    const rt = createUpdatesRuntime({
      config: resolveUpdates({
        source: ch.base().replace(/\/prod\/[^/]+$/, ""),
        channel: "prod",
        allowUnsigned: true,
      }),
      dataDir: root,
      appName: "app",
      appVersion: "2.0.0",
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
    for (let check = 1; check <= 3; check++) {
      const r = await rt.check({ dismissed: null });
      assertEquals(r.kind, "current", JSON.stringify(r));
      assertEquals(ch.asked, { kind: check, platform: 0 });
    }
  } finally {
    await ch.close();
    await dropTempDir(root);
  }
});

// Every channel published before the kind manifest existed answers "absent"
// on every check: the kind manifest must not double its requests for good.
// Only "no such file" (404, 410) is believed for a day; a 403, a 408, a 429
// or a 5xx can be a bad moment, and is asked again.
Deno.test("kind manifest: a channel that answered absent is not asked again each check", async () => {
  const cases = [[404, 1], [410, 1], [403, 2], [408, 2], [429, 2], [500, 2]];
  for (const [status, asks] of cases) {
    const ch = await httpChannel(() => new Response("{}", { status }));
    try {
      const base = ch.base(`/absent-${status}`);
      for (let i = 0; i < 2; i++) {
        assertEquals(
          (await fetchInstallManifest(base, "electron-zip")).url,
          base,
        );
      }
      assertEquals(ch.asked, { kind: asks!, platform: 2 }, `HTTP ${status}`);
    } finally {
      await ch.close();
    }
  }
});

// A channel that cannot be reached at all is the platform fetch's to report,
// as it always was: its error names the platform's manifest.
Deno.test("kind manifest: an unreachable channel is reported by the platform's fetch", async () => {
  const base = manifestUrl(
    `http://127.0.0.1:${freePort()}`,
    "prod",
    platform,
  );
  const { url, got } = await fetchInstallManifest(base, "electron-zip");
  assertEquals(url, base);
  assertEquals(got.kind, "error");
});

// A kind manifest that IS served and is wrong fails the check: falling back
// to the platform's would offer a zip install the `.exe` it refuses.
Deno.test("kind manifest: a served kind manifest that is not a manifest fails the check", async () => {
  const ch = await httpChannel(() => new Response("{}"));
  try {
    const base = ch.base();
    const { url, got } = await fetchInstallManifest(base, "electron-zip");
    assertEquals(url, kindManifestUrl(base, "electron-zip"));
    assertEquals(got.kind, "error");
    assertEquals(ch.asked, { kind: 1, platform: 0 });
  } finally {
    await ch.close();
  }
});

// A kind fetch that times out has heard nothing — not "absent". Reading the
// platform's manifest on it offered a zip install the `.exe` it refuses, on
// every check of a slow channel; and it would wait the manifest's deadline a
// second time. The check fails instead, after ONE deadline.
Deno.test("kind manifest: a kind fetch that times out fails the check — never the platform's manifest", async () => {
  const { promise: release, resolve } = Promise.withResolvers<void>();
  const ch = await httpChannel(async () => {
    await release;
    return new Response("{}");
  });
  try {
    const base = ch.base();
    const { url, got } = await fetchInstallManifest(
      base,
      "electron-zip",
      undefined,
      300,
    );
    assertEquals(url, kindManifestUrl(base, "electron-zip"));
    assertStringIncludes(
      got.kind === "error" ? got.error : "",
      "did not answer within 0.3s",
    );
    assertEquals(ch.asked.platform, 0);
  } finally {
    resolve();
    await ch.close();
  }
});

// A channel that answers slower than a few seconds (and inside the manifest
// deadline) is heard: its kind manifest is read.
Deno.test("kind manifest: a slow channel's answer is waited for, like the manifest's", async () => {
  const ch = await httpChannel(async () => (
    await new Promise((r) => setTimeout(r, 6_000)), new Response(ch.kindText)
  ));
  try {
    const base = ch.base();
    const { url, got } = await fetchInstallManifest(base, "electron-zip");
    assertEquals(url, kindManifestUrl(base, "electron-zip"));
    assertEquals(got.kind, "ok");
  } finally {
    await ch.close();
  }
});
