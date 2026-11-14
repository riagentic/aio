// A persistence-schema bump was not treated as a migration, so no backup was
// taken before it.
//
// `dataCompatibility` weighed only per-cell versions, and the applier
// recomputed `migrates` from cell versions alone. A build with
// PERSIST_SCHEMA_VERSION 2 (and no cell bump) therefore installed with
// `migrates: false`: it rewrote the store at boot with no backup, and a
// rollback put back a build that refuses the newer-schema store. Now a schema
// increase IS a migration in the one verdict, and the applier uses that verdict.
import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { buildShipManifest, generateSigningKey } from "../src/build/ship.ts";
import { createUpdatesRuntime } from "../src/server/updates-runtime.ts";
import {
  dataCompatibility,
  resolveUpdates,
} from "../src/server/updates-core.ts";
import { readPending } from "../src/server/updates-apply.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import type { Log } from "../src/diagnostics/logger.ts";
import { programBytes, writeProgram } from "./fake-program-helper.ts";

const CELLS = { todos: { version: 1, migratesFrom: 1 } };

Deno.test("dataCompatibility: a persistence-schema increase migrates", () => {
  const v = dataCompatibility(
    { schema: 1, cells: { todos: 1 } },
    { schema: 2, cells: CELLS },
  );
  assertEquals(v.ok, true);
  assertEquals(v.migrates, true);
  // Same schema, same cells: nothing migrates.
  assertEquals(
    dataCompatibility({ schema: 1, cells: { todos: 1 } }, {
      schema: 1,
      cells: CELLS,
    }).migrates,
    false,
  );
});

const silentLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Log;

const appBody = (v: string) =>
  `#!/bin/sh\nif [ "$1" = "--version" ]; then echo ${v}; exit 0; fi\necho APP ${v}\n`;

Deno.test("apply: a schema-bump release backs the store up before swapping", async () => {
  const root = await tempDir("aio-upd-schema-");
  try {
    const platform = { os: Deno.build.os, arch: Deno.build.arch };
    const dataDir = join(root, "data");
    const releases = join(root, "releases");
    const channelDir = join(releases, "prod");
    await Deno.mkdir(dataDir, { recursive: true });
    await Deno.mkdir(channelDir, { recursive: true });
    const artifact = join(root, "app");
    await writeProgram(artifact, appBody("1.0.0"));

    const keys = await generateSigningKey();
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
      // The store format moves 1 → 2; no cell version changes.
      data: { schema: 2, cells: CELLS },
    });
    await Deno.writeFile(join(channelDir, "app-2.0.0"), bytes);
    await Deno.writeTextFile(
      join(channelDir, `${platform.os}-${platform.arch}.json`),
      JSON.stringify(manifest, null, 2),
    );

    const snapshots: string[] = [];
    const rt = createUpdatesRuntime({
      config: resolveUpdates({ source: `file://${releases}`, channel: "prod" }),
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
      snapshot: async (path) => {
        snapshots.push(path);
        await Deno.writeTextFile(path, "SNAPSHOT");
      },
    });
    const got = await rt.check({ dismissed: null });
    assertEquals(got.kind, "offer");
    if (got.kind === "offer") assertEquals(got.update.migrates, true);

    await rt.apply();
    await (rt.handover ?? Promise.resolve());

    // The store was snapshotted, and the rollback marker carries it — putting
    // the old binary back cannot read a v2 store, so the rollback needs this.
    assertEquals(snapshots.length, 1);
    assertStringIncludes(snapshots[0]!, "pre-1.0.0-state.db");
    assertEquals(readPending(dataDir)?.backup, snapshots[0]);
  } finally {
    await dropTempDir(root);
  }
});
