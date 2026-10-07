// Hunt r10: a swap that FAILS leaves the rollback marker armed for an update
// that never happened.
//
// `swapArtifact` writes `update-pending.json` BEFORE the first rename (so a
// crash mid-swap can be undone), then copies the running artifact aside and
// renames the new one in. When that copy fails — disk full is the ordinary
// cause, reproduced here with a real ENOSPC from /dev/full — the swap throws
// and `apply()` rejects, but nothing removes the marker. The OLD build keeps
// running, and on its next boots:
//   - a healthy boot logs "update 1.0.0 → 2.0.0 confirmed healthy" about a
//     version that was never installed, and
//   - two unhealthy boots (a port collision, a flaky disk) "roll back" by
//     moving the half-written `.old-1.0.0` over the GOOD running artifact and
//     deleting the good one.
import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { buildShipManifest } from "../src/build/ship.ts";
import { createUpdatesRuntime } from "../src/server/updates-runtime.ts";
import { resolveUpdates } from "../src/server/updates-core.ts";
import { readPending } from "../src/server/updates-apply.ts";
import { judgePendingUpdate } from "../src/server/updates-boot.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import type { Log } from "../src/diagnostics/logger.ts";

const silentLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Log;

const platform = { os: Deno.build.os, arch: Deno.build.arch };

Deno.test({
  name:
    "hunt r10: a swap that fails (ENOSPC) does not leave an armed rollback marker",
  ignore: Deno.build.os === "windows", // ENOSPC from a symlink to /dev/full: Windows has no such device
  fn: async () => {
    const newBytes = new TextEncoder().encode("#!/bin/sh\necho 2.0.0\n");
    const manifest = await buildShipManifest({
      name: "app",
      version: "2.0.0",
      binary: newBytes,
      sources: [],
      channel: "prod",
      target: "binary",
      platform,
      url: "app-2.0.0",
    });
    const port = freePort();
    const server = Deno.serve(
      { port, hostname: "127.0.0.1", onListen: () => {} },
      (req) =>
        new URL(req.url).pathname.endsWith(".json")
          ? new Response(JSON.stringify(manifest))
          : new Response(newBytes),
    );
    const root = await tempDir("aio-r10-swapfail-");
    try {
      const dataDir = join(root, "data");
      await Deno.mkdir(dataDir, { recursive: true });
      const current = join(root, "app");
      const oldText = "#!/bin/sh\necho 1.0.0\n";
      await Deno.writeTextFile(current, oldText);
      await Deno.chmod(current, 0o755);
      // The kept-aside copy lands on a full disk.
      await Deno.symlink("/dev/full", `${current}.old-1.0.0`);

      const rt = createUpdatesRuntime({
        config: resolveUpdates({
          source: `http://127.0.0.1:${port}`,
          channel: "prod",
          allowUnsigned: true,
        }),
        dataDir,
        appName: "app",
        appVersion: "1.0.0",
        local: { schema: 1, cells: {} },
        exposed: false,
        log: silentLog,
        argv: [],
        artifact: current,
        canInstall: ["binary"],
        exit: () => {},
        relaunch: () => {},
        shutdown: () => Promise.resolve(),
      });
      const checked = await rt.check({ dismissed: null });
      assertEquals(checked.kind, "offer");

      await assertRejects(() => rt.apply({}));
      // The swap failed; 1.0.0 is still what is installed and running.
      assertEquals(await Deno.readTextFile(current), oldText);

      assertEquals(
        readPending(dataDir),
        null,
        "the failed swap left update-pending.json claiming 1.0.0 → 2.0.0",
      );

      // What the armed marker does to the build that is still running.
      for (let boot = 0; boot < 3; boot++) {
        await judgePendingUpdate(dataDir, silentLog);
      }
      const st = await Deno.lstat(current);
      assertEquals(
        st.isFile,
        true,
        "the good 1.0.0 artifact was replaced by the failed kept-aside copy",
      );
    } finally {
      await server.shutdown();
      await dropTempDir(root);
    }
  },
});
