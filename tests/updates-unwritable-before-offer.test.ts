// A release this install cannot apply is never OFFERED — `.katana/updates.md`:
// every install layout "either applies updates or says exactly why it cannot,
// before the offer is shown — including when the install directory is not
// writable by the user running it".
//
// Measured on a real compiled app in a folder its user could not write: the
// check answered `available`, the button was shown, and only the click said
// "cannot stage an update in <dir>: it is not writable". The writability probe
// ran in the download, after the offer.
import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { buildShipManifest, generateSigningKey } from "../src/build/ship.ts";
import { createUpdatesRuntime } from "../src/server/updates-runtime.ts";
import { resolveUpdates } from "../src/server/updates-core.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { programBytes, writeProgram } from "./fake-program-helper.ts";
import type { Log } from "../src/diagnostics/logger.ts";

const platform = { os: Deno.build.os, arch: Deno.build.arch };
const body = (v: string) =>
  `#!/bin/sh\nif [ "$1" = "--version" ]; then echo ${v}; exit 0; fi\necho ${v}\n`;
const silent = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Log;

Deno.test({
  name:
    "updates: an install folder its user cannot write is said by the check, never offered",
  // Windows has no mode bits to take away; root writes through 0555.
  ignore: Deno.build.os === "windows" || Deno.uid() === 0,
  fn: async () => {
    const root = await tempDir("aio-upd-unwritable-");
    const install = join(root, "install");
    try {
      const releases = join(root, "releases");
      const dataDir = join(root, "data");
      await Deno.mkdir(join(releases, "prod"), { recursive: true });
      await Deno.mkdir(dataDir);
      await Deno.mkdir(install);
      const artifact = join(install, "app");
      await writeProgram(artifact, body("1.0.0"));
      const bytes = await programBytes(body("2.0.0"));
      const manifest = await buildShipManifest({
        name: "app",
        version: "2.0.0",
        binary: bytes,
        sources: [],
        sign: await generateSigningKey(),
        channel: "prod",
        target: "binary",
        platform,
        url: "app-2.0.0",
      });
      await Deno.writeFile(join(releases, "prod", "app-2.0.0"), bytes);
      await Deno.writeTextFile(
        join(releases, "prod", `${platform.os}-${platform.arch}.json`),
        JSON.stringify(manifest),
      );
      const rt = createUpdatesRuntime({
        config: resolveUpdates({ source: `file://${releases}` }),
        dataDir,
        appVersion: "1.0.0",
        local: { schema: 1, cells: {} },
        exposed: false,
        log: silent,
        argv: [],
        artifact,
        canInstall: ["binary"],
        exit: () => {},
        relaunch: () => {},
        shutdown: () => Promise.resolve(),
      });

      await Deno.chmod(install, 0o555);
      const r = await rt.check({ dismissed: null });
      assertEquals(r.kind, "error");
      const said = r.kind === "error" ? r.error : "";
      assertStringIncludes(said, "2.0.0 is available");
      assertStringIncludes(said, install);
      assertStringIncludes(said, "not writable");
      // Nothing to apply: the release was never staged as an offer.
      let failed = "";
      await rt.apply().catch((e) => (failed = String(e)));
      assertStringIncludes(failed, "no verified update is staged");

      // Writable again: the very same release is offered.
      await Deno.chmod(install, 0o755);
      assertEquals((await rt.check({ dismissed: null })).kind, "offer");
    } finally {
      await Deno.chmod(install, 0o755).catch(() => {}); // aio-ok: absent if setup failed early
      await dropTempDir(root);
    }
  },
});
