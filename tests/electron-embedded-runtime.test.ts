// A self-contained desktop exe unpacks the Electron it CARRIES — never the
// network.
//
// Field report (real Windows 11, 2026-09-17): double-clicking the Windows
// exe printed "downloading runtime 44.3.0 for win32-x64 (~100 MB, once per
// machine)…" and then nothing, forever: no progress, no timeout. Had the
// download finished, the unpack would have failed too — a clean Windows has
// none of `unzip`/`bsdtar`/`python3` (zip-extract.test.ts pins the built-in
// reader that replaced them). These tests pin the embedded path and a
// download that reports progress and gives up loudly on a dead connection.
import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  bakedEmbeddedRuntime,
  electronBinIn,
  electronRuntimeDir,
  electronSlug,
  electronZipName,
  EMBEDDED_RUNTIME_ZIP,
  embeddedRuntimeFetch,
  ensureElectronRuntime,
  ensureElectronZip,
  fetchVerifiedZip,
  FUSED_SUFFIX,
} from "../src/electron/electron-runtime-fetch.ts";
import { FUSE_SENTINEL, fusesAreOff } from "../src/electron/electron-fuses.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { findElectronBin } from "../src/electron/electron-spawn.ts";
import type { Log } from "../src/electron/electron-shared.ts";

const V = "9.9.9";
const FUSE_WIRE = `${FUSE_SENTINEL}\x01\x09101100011`;
const SLUG = electronSlug();

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest(
    "SHA-256",
    bytes.slice().buffer as ArrayBuffer,
  );
  return Array.from(new Uint8Array(d))
    .map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A private cache and an empty cwd for the duration of `fn`. */
async function isolated<T>(fn: (tmp: string) => Promise<T>): Promise<T> {
  const tmp = await tempDir("electron-embedded-");
  const cwd = Deno.cwd();
  const xdg = Deno.env.get("XDG_CACHE_HOME");
  const ep = Deno.env.get("ELECTRON_PATH");
  Deno.chdir(tmp);
  Deno.env.set("XDG_CACHE_HOME", join(tmp, "cache"));
  Deno.env.delete("ELECTRON_PATH");
  try {
    return await fn(tmp);
  } finally {
    Deno.chdir(cwd);
    if (xdg === undefined) Deno.env.delete("XDG_CACHE_HOME");
    else Deno.env.set("XDG_CACHE_HOME", xdg);
    if (ep !== undefined) Deno.env.set("ELECTRON_PATH", ep);
    await dropTempDir(tmp);
  }
}

/** A zip holding this host's Electron executable name — enough for the
 *  installer's "is it an Electron runtime" check. */
async function runtimeZip(tmp: string): Promise<string> {
  const stage = join(tmp, "zip-stage");
  const bin = electronBinIn(stage);
  await Deno.mkdir(join(bin, ".."), { recursive: true });
  // With Electron's fuse wire as shipped (RunAsNode, NODE_OPTIONS and
  // --inspect on), so the installer has real bytes to turn off.
  await Deno.writeTextFile(bin, `#!/bin/sh\n${FUSE_WIRE}`);
  const zip = join(tmp, "runtime.zip");
  const p = await new Deno.Command("zip", {
    args: ["-q", "-r", zip, "."],
    cwd: stage,
    stdout: "null",
    stderr: "null",
  }).output();
  assert(p.success, "zip is needed to build the test archive");
  return zip;
}

/** A `dist/` as a self-contained build leaves it inside the binary. */
async function embeddedDist(
  tmp: string,
  zip: string,
  sha256: string,
  name = electronZipName(V, SLUG),
): Promise<string> {
  const dist = join(tmp, "dist");
  await Deno.mkdir(dist, { recursive: true });
  await Deno.copyFile(zip, join(dist, EMBEDDED_RUNTIME_ZIP));
  await Deno.writeTextFile(
    join(dist, "electron.json"),
    JSON.stringify({ version: V, embedded: { name, sha256 } }),
  );
  return dist;
}

Deno.test("embedded runtime: installs from the carried zip, with its checksum, and no network", async () => {
  await isolated(async (tmp) => {
    const zip = await runtimeZip(tmp);
    const sha = await sha256Hex(await Deno.readFile(zip));
    const dist = await embeddedDist(tmp, zip, sha);
    const rt = await bakedEmbeddedRuntime(dist);
    assertEquals(rt, {
      name: electronZipName(V, SLUG),
      sha256: sha,
      path: join(dist, EMBEDDED_RUNTIME_ZIP),
    });
    // Anything but the zip and its manifest is a 404, never a real request.
    const f = embeddedRuntimeFetch(rt!);
    assertEquals((await f("https://example.com/other")).status, 404);
    const dir = await ensureElectronRuntime(V, SLUG, {
      fetch: f,
      log: () => {},
    });
    assertEquals(dir, electronRuntimeDir(V, SLUG));
    assert((await Deno.stat(electronBinIn(dir))).isFile);
  });
});

Deno.test("embedded runtime: the carried runtime is unpacked with its fuses off, apart from an unfused one already cached", async () => {
  await isolated(async (tmp) => {
    const zip = await runtimeZip(tmp);
    const sha = await sha256Hex(await Deno.readFile(zip));
    const rt = (await bakedEmbeddedRuntime(await embeddedDist(tmp, zip, sha)))!;
    // An unfused runtime of the same version already sits under the plain
    // name (a download, or an app built before fuses).
    const plain = await ensureElectronRuntime(V, SLUG, {
      fetch: embeddedRuntimeFetch(rt),
      log: () => {},
    });
    assert(!fusesAreOff(await Deno.readFile(electronBinIn(plain))));
    const dir = await ensureElectronRuntime(V, SLUG, {
      embedded: rt,
      log: () => {},
    });
    assertEquals(dir, electronRuntimeDir(V, SLUG) + FUSED_SUFFIX);
    assert(fusesAreOff(await Deno.readFile(electronBinIn(dir))));
  });
});

Deno.test("embedded runtime: bytes that do not match the baked checksum are refused", async () => {
  await isolated(async (tmp) => {
    const zip = await runtimeZip(tmp);
    const dist = await embeddedDist(tmp, zip, "0".repeat(64));
    const rt = (await bakedEmbeddedRuntime(dist))!;
    await assertRejects(
      () =>
        ensureElectronRuntime(V, SLUG, {
          fetch: embeddedRuntimeFetch(rt),
          log: () => {},
        }),
      Error,
      "integrity check FAILED",
    );
  });
});

Deno.test("embedded runtime: no record is null; a record without its zip is an error", async () => {
  await isolated(async (tmp) => {
    assertEquals(await bakedEmbeddedRuntime(undefined), null);
    const dist = join(tmp, "dist");
    await Deno.mkdir(dist);
    await Deno.writeTextFile(join(dist, "electron.json"), `{"version":"${V}"}`);
    assertEquals(await bakedEmbeddedRuntime(dist), null);
    await Deno.writeTextFile(
      join(dist, "electron.json"),
      JSON.stringify({ version: V, embedded: { name: "x.zip", sha256: "ab" } }),
    );
    await assertRejects(() => bakedEmbeddedRuntime(dist), Error, "rebuild");
  });
});

Deno.test("findElectronBin (compiled): a carried runtime is unpacked, and the download rung is never reached", async () => {
  await isolated(async (tmp) => {
    const zip = await runtimeZip(tmp);
    const dist = await embeddedDist(
      tmp,
      zip,
      await sha256Hex(await Deno.readFile(zip)),
    );
    let downloads = 0;
    const said: string[] = [];
    const bin = await findElectronBin({
      info: (m) => said.push(m),
      error: (m) => said.push(m),
    }, {
      compiled: true,
      distDir: dist,
      execPath: join(tmp, "app.exe"),
      fetchRuntime: () => {
        downloads++;
        return Promise.reject(new Error("downloaded"));
      },
    });
    assertEquals(
      bin,
      electronBinIn(electronRuntimeDir(V, SLUG) + FUSED_SUFFIX),
    );
    assertEquals(downloads, 0);
    // It says what it does: unpacking, not downloading.
    assert(said.some((l) => l.includes("this app carries")), said.join("\n"));
    assert(!said.some((l) => l.includes("downloading")), said.join("\n"));
  });
});

Deno.test("findElectronBin (compiled): a carried runtime for another platform fails loudly — no download", async () => {
  await isolated(async (tmp) => {
    const zip = await runtimeZip(tmp);
    const other = SLUG.startsWith("win32") ? "linux-x64" : "win32-x64";
    const dist = await embeddedDist(
      tmp,
      zip,
      await sha256Hex(await Deno.readFile(zip)),
      electronZipName(V, other),
    );
    const errors: string[] = [];
    const log: Log = { info: () => {}, error: (m) => errors.push(m) };
    let downloads = 0;
    const bin = await findElectronBin(log, {
      compiled: true,
      distDir: dist,
      execPath: join(tmp, "app.exe"),
      fetchRuntime: () => {
        downloads++;
        return Promise.reject(new Error("downloaded"));
      },
    });
    assertEquals(bin, null);
    assertEquals(downloads, 0);
    assert(errors.some((e) => e.includes("another platform")), errors.join());
  });
});

Deno.test("fetchVerifiedZip: reports progress, and a dead connection fails loudly instead of hanging", async () => {
  const body = new Uint8Array(1000);
  const sums = `${await sha256Hex(body)} *${electronZipName(V, SLUG)}\n`;
  const lines: string[] = [];
  const ok: typeof fetch = (input) =>
    Promise.resolve(
      String(input).endsWith("SHASUMS256.txt")
        ? new Response(sums)
        : new Response(
          new ReadableStream({
            start(c) {
              for (let i = 0; i < 10; i++) c.enqueue(body.subarray(0, 100));
              c.close();
            },
          }),
          { headers: { "content-length": "1000" } },
        ),
    );
  const got = await fetchVerifiedZip(V, SLUG, {
    log: (m) => lines.push(m),
    fetch: ok,
  });
  assertEquals(got.bytes.length, 1000);
  assert(lines.some((l) => l.includes("50%")), lines.join("\n"));
  assert(lines.some((l) => l.includes("100%")), lines.join("\n"));

  // Headers arrive, then the body never does.
  let aborted = false;
  const dead: typeof fetch = (_input, init) => {
    init?.signal?.addEventListener("abort", () => aborted = true);
    return Promise.resolve(
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(body.subarray(0, 10));
          },
        }),
        { headers: { "content-length": "1000" } },
      ),
    );
  };
  await assertRejects(
    () =>
      fetchVerifiedZip(V, SLUG, { log: () => {}, fetch: dead, stallMs: 50 }),
    Error,
    "no data for",
  );
  assert(aborted, "the stalled request is cancelled, not left open");
});

Deno.test("ensureElectronZip: downloads once, re-verifies the cached copy, replaces a corrupt one", async () => {
  await isolated(async () => {
    const body = new Uint8Array([1, 2, 3, 4]);
    const sums = `${await sha256Hex(body)} *${electronZipName(V, SLUG)}\n`;
    let downloads = 0;
    const f: typeof fetch = (input) => {
      if (String(input).endsWith("SHASUMS256.txt")) {
        return Promise.resolve(new Response(sums));
      }
      downloads++;
      return Promise.resolve(new Response(body.slice()));
    };
    const a = await ensureElectronZip(V, SLUG, { fetch: f, log: () => {} });
    assertEquals(a.path, `${electronRuntimeDir(V, SLUG)}.zip`);
    assertEquals(a.sha256, await sha256Hex(body));
    await ensureElectronZip(V, SLUG, { fetch: f, log: () => {} });
    assertEquals(downloads, 1, "a verified cached zip is reused");
    await Deno.writeFile(a.path, new Uint8Array([9]));
    const b = await ensureElectronZip(V, SLUG, { fetch: f, log: () => {} });
    assertEquals(
      downloads,
      2,
      "a cached zip that no longer hashes is refetched",
    );
    assertEquals(await Deno.readFile(b.path), body);
  });
});

Deno.test("embedded runtime: a configured mirror does not send it to the network", async () => {
  // The embedded fetch answers the installer's two URLs by suffix, so
  // $ELECTRON_MIRROR changes nothing about where the bytes come from.
  await isolated(async (tmp) => {
    const zip = await runtimeZip(tmp);
    const dist = await embeddedDist(
      tmp,
      zip,
      await sha256Hex(await Deno.readFile(zip)),
    );
    const rt = (await bakedEmbeddedRuntime(dist))!;
    const dir = await ensureElectronRuntime(V, SLUG, {
      fetch: embeddedRuntimeFetch(rt),
      mirror: "https://mirror.invalid/electron/",
      log: () => {},
    });
    assert((await Deno.stat(electronBinIn(dir))).isFile);
  });
});
