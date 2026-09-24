// A FAILED shutdown during an update handover is said out loud.
//
// `deferHandOver` (src/server/updates-runtime.ts) awaits the app's shutdown,
// then relaunches; a rejection is caught there and logged "update handover
// FAILED", and the relaunch is skipped (never start a successor onto a
// half-stopped app — the rule `aio.restart()` follows too). But aio.ts handed
// the runtime `() => shutdown().catch(() => {})`, so the rejection never got
// there: the FAILED line was unreachable and the failure silent. Pinned in two
// halves — the runtime's reaction, and aio.ts handing it the unswallowed
// shutdown.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { buildShipManifest, generateSigningKey } from "../src/build/ship.ts";
import { createUpdatesRuntime } from "../src/server/updates-runtime.ts";
import { resolveUpdates } from "../src/server/updates-core.ts";
import type { Log } from "../src/diagnostics/logger.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const platform = { os: Deno.build.os, arch: Deno.build.arch };
const ROOT = new URL("..", import.meta.url).pathname;
const appBody = (v: string) =>
  `#!/bin/sh\nif [ "$1" = "--version" ]; then echo ${v}; exit 0; fi\necho APP ${v}\n`;

Deno.test("updates handover: a shutdown that rejects logs 'update handover FAILED', never relaunches, and still exits", async () => {
  const root = await tempDir("aio-handover-fail-");
  try {
    const dataDir = join(root, "data");
    await Deno.mkdir(dataDir);
    const artifact = join(root, "app");
    await Deno.writeTextFile(artifact, appBody("1.0.0"));
    await Deno.chmod(artifact, 0o755);
    const keys = await generateSigningKey();
    const dir = join(root, "releases", "prod");
    await Deno.mkdir(dir, { recursive: true });
    const bytes = new TextEncoder().encode(appBody("2.0.0"));
    const manifest = await buildShipManifest({
      name: "app",
      version: "2.0.0",
      binary: bytes,
      sources: [],
      sign: keys,
      channel: "prod",
      target: "binary",
      platform,
      url: "app-2.0.0",
      data: { schema: 1, cells: { todos: { version: 1, migratesFrom: 1 } } },
    });
    await Deno.writeFile(join(dir, "app-2.0.0"), bytes);
    await Deno.writeTextFile(
      join(dir, `${platform.os}-${platform.arch}.json`),
      JSON.stringify(manifest),
    );

    const errors: string[] = [];
    const log = {
      info: () => {},
      warn: () => {},
      debug: () => {},
      error: (...a: unknown[]) => void errors.push(a.map(String).join(" ")),
    } as unknown as Log;
    const exits: number[] = [];
    const relaunched: string[] = [];
    const rt = createUpdatesRuntime({
      config: resolveUpdates({
        source: `file://${join(root, "releases")}`,
        channel: "prod",
      }),
      dataDir,
      appName: "app",
      appVersion: "1.0.0",
      local: { schema: 1, cells: { todos: 1 } },
      exposed: false,
      log,
      argv: [],
      artifact,
      canInstall: ["binary"],
      exit: (code) => void exits.push(code),
      relaunch: ({ artifact }) => void relaunched.push(artifact),
      shutdown: () => Promise.reject(new Error("final snapshot failed")),
    });
    assertEquals((await rt.check({ dismissed: null })).kind, "offer");
    await rt.apply();
    await rt.handover;

    const failed = errors.find((e) => e.includes("update handover FAILED"));
    assert(failed, `the failed shutdown was silent:\n${errors.join("\n")}`);
    assertStringIncludes(failed, "final snapshot failed");
    assertEquals(relaunched, [], "relaunched onto a half-stopped app");
    assertEquals(exits, [0]);
  } finally {
    await dropTempDir(root);
  }
});

Deno.test("updates handover: aio.ts hands the updates runtime its shutdown unswallowed", async () => {
  const src = await Deno.readTextFile(ROOT + "src/server/aio.ts");
  const call = /startUpdates\(\{[\s\S]*?\n {4}\}\)/.exec(src)?.[0];
  assert(call, "aio.ts: the startUpdates({...}) call was not found");
  const line = call.split("\n").find((l) => /^\s*shutdown\b/.test(l));
  assert(line, `no shutdown passed to startUpdates:\n${call}`);
  assertEquals(
    line.trim(),
    "shutdown,",
    "the app's shutdown must reach deferHandOver as-is — a wrapper that " +
      "catches makes 'update handover FAILED' unreachable",
  );
});
