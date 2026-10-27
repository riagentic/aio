// `updates: "github:OWNER/REPO"` — a repository's GitHub releases are a source
// (field report, aio-launcher §1). Release assets are flat, so the manifest is
// `releases/latest/download/<os>-<arch>.json` (`prod`) or
// `releases/download/<channel>/…` (any other channel = the release tagged with
// its name), and GitHub answers every asset with a redirect to ANOTHER host.
// A fake GitHub on loopback does the same: check → offer → apply, through the
// cross-host redirect. A manifest naming an artifact on another host is still
// refused.
//
// And a newer release skipped as a prerelease says so once (aio-launcher §3):
// it read exactly like "up to date".
import { programBytes, writeProgram } from "./fake-program-helper.ts";
import { assert, assertEquals, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { buildShipManifest, generateSigningKey } from "../src/build/ship.ts";
import { createUpdatesRuntime } from "../src/server/updates-runtime.ts";
import {
  _githubHost,
  classifySource,
  manifestUrl,
  resolveUpdates,
} from "../src/server/updates-core.ts";
import { freePort } from "../src/testing/server-test.ts";
import type { Log } from "../src/diagnostics/logger.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const platform = { os: Deno.build.os, arch: Deno.build.arch };
const file = `${platform.os}-${platform.arch}.json`;
const appBody = (v: string) =>
  `#!/bin/sh\nif [ "$1" = "--version" ]; then echo ${v}; exit 0; fi\necho APP ${v}\n`;

Deno.test("updates github: the source reads a release's flat assets", () => {
  assertEquals(classifySource("github:owner/app"), "manifest");
  assertEquals(classifySource("github:owner/app", "manifest"), "manifest");
  for (const bad of ["github:owner", "github:owner/app/x", "github:/app"]) {
    assertThrows(() => classifySource(bad), Error, "github:OWNER/REPO");
  }
  assertThrows(
    () => classifySource("github:owner/app", "git"),
    Error,
    'kind: "git"',
  );
  const p = { os: "linux", arch: "x86_64" };
  assertEquals(
    manifestUrl("github:owner/app", "prod", p),
    "https://github.com/owner/app/releases/latest/download/linux-x86_64.json",
  );
  assertEquals(
    manifestUrl("github:owner/app", "beta", p),
    "https://github.com/owner/app/releases/download/beta/linux-x86_64.json",
  );
});

/** A GitHub stand-in, hop for hop: `releases/latest/download/<f>` redirects
 *  (302) on the SAME host to `releases/download/<latest tag>/<f>`, which
 *  redirects to an asset host on another port that serves `files[tag][f]` —
 *  with an ETag, answering a matching `If-None-Match` with 304. `latest` is
 *  the tag "latest" points at, and can move. */
async function fakeGithub(files: Record<string, Record<string, Uint8Array>>) {
  const state = { latest: "latest" };
  const assetPort = freePort();
  const assets = Deno.serve(
    { port: assetPort, hostname: "127.0.0.1", onListen: () => {} },
    (req) => {
      const [, tag, name] = new URL(req.url).pathname.split("/");
      const body = files[tag!]?.[name!];
      if (!body) return new Response("no", { status: 404 });
      const etag = `"${tag}-${name}-${body.length}"`;
      return req.headers.get("if-none-match") === etag
        ? new Response(null, { status: 304, headers: { etag } })
        : new Response(body as BodyInit, { headers: { etag } });
    },
  );
  const port = freePort();
  const gh = Deno.serve(
    { port, hostname: "127.0.0.1", onListen: () => {} },
    (req) => {
      const m =
        /^\/owner\/app\/releases\/(?:latest\/download|download\/([^/]+))\/([^/]+)$/
          .exec(new URL(req.url).pathname);
      if (!m) return new Response("no", { status: 404 });
      return Response.redirect(
        m[1] === undefined
          ? `http://127.0.0.1:${port}/owner/app/releases/download/${state.latest}/${
            m[2]
          }`
          : `http://127.0.0.1:${assetPort}/${m[1]}/${m[2]}`,
        302,
      );
    },
  );
  return {
    state,
    base: `http://127.0.0.1:${port}`,
    assetBase: `http://127.0.0.1:${assetPort}`,
    stop: async () => {
      await gh.shutdown();
      await assets.shutdown();
    },
  };
}

async function release(
  version: string,
  url?: string,
  channel = "prod",
  target: "binary" | "android" = "binary",
) {
  const bytes = await programBytes(appBody(version));
  const name = `app-${version}`;
  const manifest = await buildShipManifest({
    name: "app",
    version,
    binary: bytes,
    sources: [],
    sign: await generateSigningKey(),
    channel,
    target,
    platform,
    url: url ?? name,
  });
  return {
    [name]: bytes,
    [file]: new TextEncoder().encode(JSON.stringify(manifest)),
  };
}

function logInto(lines: string[]): Log {
  const put = (_c: string, m: string) => void lines.push(m);
  return {
    info: put,
    warn: put,
    error: put,
    debug: () => {},
  } as unknown as Log;
}

async function runtime(
  channel: string,
  run: (
    rt: ReturnType<typeof createUpdatesRuntime>,
    artifact: string,
    lines: string[],
    more: {
      gh: Awaited<ReturnType<typeof fakeGithub>>;
      /** A new process on the same data dir — an app restart. */
      restart: () => ReturnType<typeof createUpdatesRuntime>;
    },
  ) => Promise<void>,
  files: Record<string, Record<string, Uint8Array>>,
) {
  const gh = await fakeGithub(files);
  const before = _githubHost.base;
  _githubHost.base = gh.base;
  const root = await tempDir("aio-github-source-");
  try {
    const dataDir = join(root, "data");
    await Deno.mkdir(dataDir);
    const artifact = join(root, "app");
    await writeProgram(artifact, appBody("1.0.0"));
    const lines: string[] = [];
    const make = () =>
      createUpdatesRuntime({
        config: resolveUpdates({ source: "github:owner/app", channel }),
        dataDir,
        appName: "app",
        appVersion: "1.0.0",
        local: { schema: 1, cells: {} },
        exposed: false,
        log: logInto(lines),
        argv: [],
        artifact,
        canInstall: ["binary"],
        exit: () => {},
        relaunch: () => {},
        shutdown: () => Promise.resolve(),
      });
    await run(make(), artifact, lines, { gh, restart: make });
  } finally {
    _githubHost.base = before;
    await gh.stop();
    await dropTempDir(root);
  }
}

Deno.test("updates github: the latest release is offered and installed through GitHub's cross-host redirect", async () => {
  await runtime("prod", async (rt, artifact) => {
    const got = await rt.check({ dismissed: null });
    assertEquals(got.kind, "offer", JSON.stringify(got));
    await rt.apply();
    await rt.handover;
    assertEquals(
      await Deno.readFile(artifact),
      await programBytes(appBody("2.0.0")),
    );
  }, { latest: await release("2.0.0") });
});

Deno.test("updates github: a channel other than prod reads the release tagged with its name", async () => {
  await runtime("beta", async (rt) => {
    const got = await rt.check({ dismissed: null });
    assert(got.kind === "offer", JSON.stringify(got));
    assertEquals(got.update.version, "3.0.0");
  }, {
    latest: await release("2.0.0"),
    beta: await release("3.0.0", undefined, "beta"),
  });
});

Deno.test("updates github: a manifest naming its artifact on another host is still refused", async () => {
  await runtime("prod", async (rt) => {
    const got = await rt.check({ dismissed: null });
    assert(got.kind === "error", JSON.stringify(got));
    assert(got.error.includes("different host"), got.error);
  }, { latest: await release("2.0.0", "https://example.invalid/app-2.0.0") });
});

Deno.test("updates: a newer release skipped as a prerelease is said once, naming the switch", async () => {
  await runtime("prod", async (rt, _a, lines) => {
    for (let i = 0; i < 2; i++) {
      assertEquals((await rt.check({ dismissed: null })).kind, "current");
    }
    const said = lines.filter((l) => l.startsWith("skipped 2.0.0-rc.1"));
    assertEquals(said.length, 1, lines.join("\n"));
    assert(said[0]!.includes("prerelease: true"), said[0]);
    assert(said[0]!.includes('channel "prod"'), said[0]);
  }, { latest: await release("2.0.0-rc.1") });
});

// The offered release is the one installed: "latest" moved to a newer release
// between the offer and `apply` (an unversioned artifact name, as `am publish`
// can write) — resolved against "latest" again, the bytes were the NEW
// release's and the digest refused the update. Relative URLs resolve against
// the last same-origin hop: the tag's own folder.
Deno.test("updates github: apply installs the OFFERED release after latest moved on", async () => {
  const v2 = await release("2.0.0", "app-bin");
  const v3 = await release("3.0.0", "app-bin");
  v2["app-bin"] = await programBytes(appBody("2.0.0"));
  v3["app-bin"] = await programBytes(appBody("3.0.0"));
  await runtime("prod", async (rt, artifact, _lines, { gh }) => {
    const got = await rt.check({ dismissed: null });
    assert(got.kind === "offer", JSON.stringify(got));
    assertEquals(got.update.version, "2.0.0");
    gh.state.latest = "v3";
    await rt.apply();
    await rt.handover;
    assertEquals(
      await Deno.readFile(artifact),
      await programBytes(appBody("2.0.0")),
    );
  }, { v2, v3, latest: v2 });
});

// A restart answers the cached verdict with a 304 — and the new process still
// says, once, why a newer release is not offered.
Deno.test("updates github: a skipped prerelease is said again after a restart, when the check is a 304", async () => {
  await runtime("prod", async (rt, _a, lines, { restart }) => {
    assertEquals((await rt.check({ dismissed: null })).kind, "current");
    const next = restart();
    for (let i = 0; i < 2; i++) {
      assertEquals((await next.check({ dismissed: null })).kind, "current");
    }
    const said = lines.filter((l) => l.startsWith("skipped 2.0.0-rc.1"));
    assertEquals(said.length, 2, lines.join("\n"));
  }, { latest: await release("2.0.0-rc.1") });
});

Deno.test("updates github: an Enterprise Managed User owner (`_`) is a source", () => {
  assertEquals(classifySource("github:acme_corp/app"), "manifest");
});

// A release this install cannot apply names the file to fetch by hand — the
// TAG's own URL, the one apply would download, not `latest/download/…`.
Deno.test("updates github: a by-hand install names the offered tag's file", async () => {
  const v2 = await release("2.0.0", undefined, "prod", "android");
  await runtime("prod", async (rt, _a, _l, { gh }) => {
    gh.state.latest = "v2";
    const got = await rt.check({ dismissed: null });
    const text = JSON.stringify(got);
    assert(text.includes("/releases/download/v2/app-2.0.0"), text);
  }, { v2 });
});
