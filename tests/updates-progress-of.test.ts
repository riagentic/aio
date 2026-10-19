// An update's progress says WHICH download it measures.
//
// With `electronRuntime: "online"`, an update whose new version pins another
// Electron downloads the app (progress 0→1), then that Electron (0→1 again),
// both under `status: "downloading"`. Without `progressOf` a person watching
// saw the bar fill, drop to 0 and fill again. The applier says "app" before
// the first leg, "runtime" before the second, null once both are done, and
// hands over the runtime download's size the moment its response states it.
import { programBytes, writeProgram } from "./fake-program-helper.ts";
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { buildShipManifest, generateSigningKey } from "../src/build/ship.ts";
import { createUpdatesRuntime } from "../src/server/updates-runtime.ts";
import { resolveUpdates } from "../src/server/updates-core.ts";
import type { UpdatesCell } from "../src/state/updates-cell.ts";
import type { Log } from "../src/diagnostics/logger.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const platform = { os: Deno.build.os, arch: Deno.build.arch };
const appBody = (v: string) =>
  `#!/bin/sh\nif [ "$1" = "--version" ]; then echo ${v}; exit 0; fi\necho APP ${v}\n`;
const quiet = {
  info: () => {},
  warn: () => {},
  debug: () => {},
  error: () => {},
} as unknown as Log;

/** Apply a 1.0.0 → 2.0.0 binary update whose Electron pre-download is the
 *  fake below, reporting into `cell`. Resolves with the exit codes. */
async function applyWith(cell: UpdatesCell): Promise<number[]> {
  const root = await tempDir("aio-progress-of-");
  try {
    const dataDir = join(root, "data");
    await Deno.mkdir(dataDir);
    const artifact = join(root, "app");
    await writeProgram(artifact, appBody("1.0.0"));
    const keys = await generateSigningKey();
    const dir = join(root, "releases", "prod");
    await Deno.mkdir(dir, { recursive: true });
    const bytes = await programBytes(appBody("2.0.0"));
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
    });
    await Deno.writeFile(join(dir, "app-2.0.0"), bytes);
    await Deno.writeTextFile(
      join(dir, `${platform.os}-${platform.arch}.json`),
      JSON.stringify(manifest),
    );
    const exits: number[] = [];
    const rt = createUpdatesRuntime({
      config: resolveUpdates({
        source: `file://${join(root, "releases")}`,
        channel: "prod",
      }),
      cell,
      dataDir,
      appName: "app",
      appVersion: "1.0.0",
      local: { schema: 1, cells: {} },
      exposed: false,
      log: quiet,
      argv: [],
      artifact,
      canInstall: ["binary"],
      exit: (code) => void exits.push(code),
      relaunch: () => {},
      shutdown: () => Promise.resolve(),
      // The runtime leg as `prefetchSharedElectron` drives it when the new
      // version pins an Electron the store lacks.
      prefetchElectron: (_exe, o) => {
        o.onDownload?.();
        o.onTotal?.(158_000_000);
        o.onProgress?.(0);
        o.onProgress?.(1);
        return Promise.resolve();
      },
    });
    assertEquals((await rt.check({ dismissed: null })).kind, "offer");
    await rt.apply();
    await rt.handover;
    return exits;
  } finally {
    await dropTempDir(root);
  }
}

Deno.test("updates progressOf: 'app' before the app download, 'runtime' before the Electron one with its size, null before the swap", async () => {
  const calls: string[] = [];
  const cell = new Proxy({}, {
    get: (_t, name) => (arg: unknown) =>
      void calls.push(`${String(name)}(${JSON.stringify(arg)})`),
  }) as unknown as UpdatesCell;
  assertEquals(await applyWith(cell), [0]);
  // The app leg's own progress calls are left out: a file:// download may
  // report any number of them.
  const legs = calls.filter((c) => !c.startsWith("setProgress("));
  assertEquals(legs, [
    'setPhase("downloading")',
    'setProgressOf("app")',
    'setProgressOf("runtime")',
    "setRuntimeBytes(158000000)",
    "setProgressOf(null)",
    'setPhase("applying")',
  ]);
  // The runtime leg's progress follows its "runtime" mark.
  const runtimeAt = calls.indexOf('setProgressOf("runtime")');
  assertEquals(
    calls.slice(runtimeAt).filter((c) => c.startsWith("setProgress(")),
    ["setProgress(0)", "setProgress(1)"],
  );
});

Deno.test("updates progressOf: a cell that throws on every report never breaks the apply", async () => {
  const cell = new Proxy({}, {
    get: () => () => {
      throw new Error("not bound");
    },
  }) as unknown as UpdatesCell;
  assertEquals(await applyWith(cell), [0]);
});
