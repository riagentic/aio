// Field report #19: a SOURCE run (`deno run src/app.ts`) at the version the
// channel publishes was offered that same version as an update.
//
// `installedDigest` measured `artifactPath()`, which on a source run is the
// `deno` executable — never the published artifact — so the "same version, new
// build" rule always fired, and the deno digest was recorded as the install's
// `installedSha256` in the dev data dir. A source run has no artifact of its
// own: its digest is unknown, and unknown is never an offer.
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { buildShipManifest, generateSigningKey } from "../src/build/ship.ts";
import { createUpdatesRuntime } from "../src/server/updates-runtime.ts";
import { resolveUpdates } from "../src/server/updates-core.ts";
import {
  readTrust,
  recordInstalledSha256,
} from "../src/server/updates-check.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import type { Log } from "../src/diagnostics/logger.ts";

const silentLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Log;

const platform = { os: Deno.build.os, arch: Deno.build.arch };

for (const recorded of [false, true]) {
  Deno.test(
    `updates: a source run at the published version is never offered it (${
      recorded ? "a stale deno digest already recorded" : "first check"
    })`,
    async () => {
      const root = await tempDir("aio-upd-source-");
      try {
        const dataDir = join(root, "data");
        const dir = join(root, "releases", "prod");
        await Deno.mkdir(dataDir, { recursive: true });
        await Deno.mkdir(dir, { recursive: true });
        const bytes = new TextEncoder().encode("#!/bin/sh\necho 0.1.540\n");
        const manifest = await buildShipManifest({
          name: "app",
          version: "0.1.540",
          binary: bytes,
          sources: [],
          sign: await generateSigningKey(),
          channel: "prod",
          target: "binary",
          platform,
          url: "app-0.1.540",
          data: {
            schema: 1,
            cells: { todos: { version: 1, migratesFrom: 1 } },
          },
        });
        await Deno.writeFile(join(dir, "app-0.1.540"), bytes);
        await Deno.writeTextFile(
          join(dir, `${platform.os}-${platform.arch}.json`),
          JSON.stringify(manifest),
        );
        // What an earlier (buggy) check left in the dev data dir: a digest of
        // the deno executable, which no manifest will ever match.
        if (recorded) recordInstalledSha256(dataDir, "ab".repeat(32));
        const rt = createUpdatesRuntime({
          config: resolveUpdates({
            source: `file://${join(root, "releases")}`,
            channel: "prod",
          }),
          dataDir,
          appVersion: "0.1.540",
          local: { schema: 1, cells: { todos: 1 } },
          exposed: false,
          log: silentLog,
          argv: [],
          // No `artifact`: the process's own — `deno` under this test, exactly
          // like the reported `deno run src/app.ts`.
          installedTarget: "source",
          exit: () => {},
          shutdown: () => Promise.resolve(),
        });
        const got = await rt.check({ dismissed: null });
        assertEquals(got.kind, "current");
        if (!recorded) {
          assertEquals(
            readTrust(dataDir).installedSha256,
            undefined,
            "a source run records no artifact digest",
          );
        }
      } finally {
        await dropTempDir(root);
      }
    },
  );
}
