// updates-set-channel-rederives.test.ts — `setChannel` is a channel change, not
// a rename.
//
// `intervalMs` and `prerelease` are derived from the channel at boot
// (`resolveUpdates`). `setChannel` swapped only the name, so an install moved
// from prod to dev kept prod's 6h poll and its "a prerelease is not offered"
// rule: the dev channel — which exists to be shipped alphas into — reported
// its rc as "current" until the next restart re-resolved the pinned channel.
// And the name was taken unchecked: a manifest channel is a PATH segment, so
// `"../prod"` pointed the install outside its source and was pinned there.
import { assert, assertEquals, assertRejects } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import { buildShipManifest, generateSigningKey } from "../src/build/ship.ts";
import { createUpdatesRuntime } from "../src/server/updates-runtime.ts";
import { resolveUpdates } from "../src/server/updates-core.ts";
import { readTrust } from "../src/server/updates-check.ts";
import type { Log } from "../src/diagnostics/logger.ts";
import { tempDir } from "../src/testing/temp-dir.ts";

const platform = { os: Deno.build.os, arch: Deno.build.arch };
const silentLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Log;

/** A directory source holding one unsigned-allowed release on `channel`. */
async function publish(root: string, channel: string, version: string) {
  const dir = join(root, "rel", channel);
  await Deno.mkdir(dir, { recursive: true });
  const bytes = new TextEncoder().encode(`APP ${version}`);
  const m = await buildShipManifest({
    name: "app",
    version,
    binary: bytes,
    sources: [],
    sign: await generateSigningKey(),
    channel,
    target: "binary",
    platform,
    url: `app-${version}`,
    data: { schema: 1, cells: { todos: { version: 1, migratesFrom: 1 } } },
  });
  await Deno.writeFile(join(dir, `app-${version}`), bytes);
  await Deno.writeTextFile(
    join(dir, `${platform.os}-${platform.arch}.json`),
    JSON.stringify(m),
  );
}

async function runtime() {
  const root = await tempDir("aio-upd-chan-");
  const dataDir = join(root, "data");
  await Deno.mkdir(dataDir, { recursive: true });
  const artifact = join(root, "app");
  await Deno.writeTextFile(artifact, "APP 1.0.0");
  const config = resolveUpdates({
    source: toFileUrl(join(root, "rel")).href,
    channel: "prod",
    allowUnsigned: true,
  });
  const rt = createUpdatesRuntime({
    config,
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
  return { root, dataDir, config, rt };
}

Deno.test("updates: setChannel('dev') follows dev's prerelease rule and cadence, not prod's", async () => {
  const { root, config, rt } = await runtime();
  await publish(root, "dev", "2.0.0-rc.1");
  assertEquals(config.prerelease, false);
  assertEquals(config.intervalMs, 21_600_000);

  await rt.setChannel("dev");
  const r = await rt.check({ dismissed: null });
  assertEquals(
    r.kind,
    "offer",
    `the dev channel offers its rc — got ${JSON.stringify(r)}`,
  );
  // The live config the boot poller reschedules from.
  assertEquals(config.channel, "dev");
  assertEquals(config.intervalMs, 60_000);
  assertEquals(config.prerelease, true);

  // Back to prod: the derived values follow back.
  await rt.setChannel("prod");
  assertEquals(config.intervalMs, 21_600_000);
  assertEquals(config.prerelease, false);
});

Deno.test("updates: setChannel keeps what the app PINNED (check, prerelease)", async () => {
  const { config, rt } = await runtime();
  config.declared = { check: 5000, prerelease: false };
  config.intervalMs = 5000;
  await rt.setChannel("dev");
  assertEquals(config.intervalMs, 5000);
  assertEquals(config.prerelease, false);
});

Deno.test("updates: setChannel refuses a name that is not a channel, loudly, and pins nothing", async () => {
  const { dataDir, config, rt } = await runtime();
  for (const bad of ["../prod", "", "a/b", "-x"]) {
    const e = await assertRejects(() => rt.setChannel(bad), Error);
    assert(
      e.message.includes("setChannel") &&
        e.message.includes(JSON.stringify(bad)),
      e.message,
    );
  }
  assertEquals(rt.channel, "prod");
  assertEquals(config.channel, "prod");
  assert(readTrust(dataDir).channel !== "../prod");
});

Deno.test("updates: a git channel is a REF — `release/2.x` is followed, an option or `..` is refused", async () => {
  const root = await tempDir("aio-upd-chan-git-");
  const dataDir = join(root, "data");
  await Deno.mkdir(dataDir, { recursive: true });
  const rt = createUpdatesRuntime({
    config: resolveUpdates({ source: "https://example.invalid/app.git" }),
    dataDir,
    appVersion: "1.0.0",
    local: { schema: 1, cells: {} },
    exposed: false,
    log: silentLog,
    argv: [],
    exit: () => {},
    relaunch: () => {},
    shutdown: () => Promise.resolve(),
  });
  assertEquals(rt.kind, "git");
  await rt.setChannel("release/2.x");
  assertEquals(rt.channel, "release/2.x");
  for (const bad of ["--upload-pack=x", "a..b", "main.lock", "has space", ""]) {
    await assertRejects(() => rt.setChannel(bad), Error, "setChannel");
  }
  assertEquals(rt.channel, "release/2.x");
});
