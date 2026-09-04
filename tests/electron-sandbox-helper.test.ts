// The chrome-sandbox check must look where CHROMIUM looks — and only when
// Chromium would look at all.
//
// `sandboxUsable` exists for Ubuntu 24.04+ (and every container): unprivileged
// user namespaces are restricted, so Chromium falls back to its SUID helper —
// `chrome-sandbox` beside the REAL binary — and aborts on start when that file
// is not root-owned setuid, which an npm/deno install can never make it. The
// launcher then adds `--no-sandbox`, loudly. Two things were wrong with it:
//
//  1. It derived the helper's path from the binary it was about to spawn — and
//     in dev that binary is `node_modules/.bin/electron`, a Node shim (`cli.js`)
//     that spawns `<pkg>/dist/electron`. So it stat'd
//     `node_modules/.bin/chrome-sandbox`, found nothing, concluded "no helper,
//     nothing to misconfigure", and launched without the flag: on exactly the
//     machines the check was written for, `deno task dev` opened no window
//     (FATAL:setuid_sandbox_host.cc … SIGTRAP), while the packaged binary — a
//     real path — was handled. The helper is now resolved through the shim the
//     way `electronBinReady` already does: `<pkg>/dist/<path.txt>`.
//  2. It never asked whether the namespace route was open. Where it is (every
//     stock Debian, Fedora, Arch, Ubuntu ≤ 23.04) Chromium sandboxes through
//     user namespaces and never consults the helper, so an unprivileged
//     helper there is no reason to drop the sandbox — `--no-sandbox` would be a
//     real loss of isolation for nothing. Availability is MEASURED
//     (`usernsAvailable`): the sysctls that close it, then the clone itself.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  chromeSandboxPath,
  electronShimRoot,
  realElectronBin,
  sandboxUsable,
  usernsAvailable,
} from "../src/electron/electron-spawn.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

/** The namespace route is CLOSED — the machines this check exists for. */
const RESTRICTED = () => Promise.resolve(false);
const OPEN = () => Promise.resolve(true);

Deno.test("electron sandbox: the .bin/electron launcher is recognised, in every spelling", () => {
  assertEquals(electronShimRoot("node_modules/.bin/electron"), ".");
  assertEquals(electronShimRoot("./node_modules/.bin/electron"), ".");
  assertEquals(
    electronShimRoot("/srv/app/node_modules/.bin/electron"),
    "/srv/app",
  );
  assertEquals(
    electronShimRoot("node_modules\\.bin\\electron.cmd"),
    ".",
    "the Windows launcher",
  );
  assertEquals(
    electronShimRoot("C:\\app\\node_modules\\.bin\\electron.cmd"),
    "C:\\app",
  );
  // Real binaries are not the shim — nothing to resolve.
  assertEquals(electronShimRoot("/opt/app/electron/electron"), null);
  assertEquals(
    electronShimRoot(
      "/home/u/.cache/aio/tools/electron/44.0.0-linux-x64/electron",
    ),
    null,
  );
  assertEquals(
    chromeSandboxPath("/x/node_modules/electron/dist/electron"),
    "/x/node_modules/electron/dist/chrome-sandbox",
  );
});

/** A dev checkout's node_modules, as `deno install npm:electron` lays it out:
 *  the launcher is a symlink to the package's cli.js; the binary and its
 *  sandbox helper live in dist/, named by path.txt. The helper is a plain
 *  file owned by whoever ran the install — never root, never setuid. */
async function devLayout(root: string): Promise<{ real: string }> {
  const pkg = join(root, "node_modules", "electron");
  await Deno.mkdir(join(pkg, "dist"), { recursive: true });
  await Deno.mkdir(join(root, "node_modules", ".bin"), { recursive: true });
  await Deno.writeTextFile(join(pkg, "path.txt"), "electron\n");
  await Deno.writeTextFile(join(pkg, "cli.js"), "// spawns dist/electron");
  const real = join(pkg, "dist", "electron");
  await Deno.writeTextFile(real, "#!/bin/sh\n");
  await Deno.writeTextFile(join(pkg, "dist", "chrome-sandbox"), "#!/bin/sh\n");
  await Deno.chmod(real, 0o755);
  await Deno.chmod(join(pkg, "dist", "chrome-sandbox"), 0o755); // present, NOT setuid root
  await Deno.symlink(
    "../electron/cli.js",
    join(root, "node_modules", ".bin", "electron"),
  );
  return { real };
}

Deno.test({
  name:
    "electron sandbox: the launcher resolves to the binary it spawns, and the helper beside THAT decides",
  ignore: Deno.build.os !== "linux" ||
    Deno.env.get("AIO_ELECTRON_SANDBOX") === "1", // the check is short-circuited by design then
  fn: async () => {
    const root = await tempDir("aio-sandbox-");
    try {
      const { real } = await devLayout(root);
      const shim = join(root, "node_modules", ".bin", "electron");
      assertEquals(
        await realElectronBin(shim),
        real,
        "the shim names its binary through path.txt",
      );
      assertEquals(
        await realElectronBin(real),
        real,
        "a real binary is itself",
      );

      // The control: the real path was always judged correctly.
      assertEquals(
        await sandboxUsable(real, Deno.stat, RESTRICTED),
        false,
        "a helper that is not setuid root cannot be used",
      );
      // The defect: through the shim the same helper was invisible, so the
      // launch went out WITHOUT --no-sandbox and Chromium aborted.
      assertEquals(
        await sandboxUsable(shim, Deno.stat, RESTRICTED),
        false,
        "the dev launcher must reach the same verdict as the binary it spawns",
      );
      // Where user namespaces ARE available Chromium never consults the
      // helper: the same unprivileged file is no reason to drop the sandbox.
      assert(
        await sandboxUsable(shim, Deno.stat, OPEN),
        "the namespace route is open: the helper's mode is irrelevant",
      );
      // …and a runtime with no helper at all is still left alone (Chromium
      // picks its own sandbox; there is nothing to misconfigure).
      await Deno.remove(
        join(root, "node_modules", "electron", "dist", "chrome-sandbox"),
      );
      assert(
        await sandboxUsable(shim, Deno.stat, RESTRICTED),
        "no helper: nothing to work around",
      );
    } finally {
      await dropTempDir(root);
    }
  },
});

// The decision table for "can Chromium use the namespace sandbox" — the way
// Chromium decides it, on every distro that closes the route differently.
Deno.test("electron sandbox: user-namespace availability reads the sysctls first, then measures", async () => {
  const table = (files: Record<string, string>) => (p: string) =>
    p in files
      ? Promise.resolve(files[p]!)
      : Promise.reject(new Error("ENOENT"));
  const APPARMOR = "/proc/sys/kernel/apparmor_restrict_unprivileged_userns";
  const CLONE = "/proc/sys/kernel/unprivileged_userns_clone";
  const MAX = "/proc/sys/user/max_user_namespaces";

  // Ubuntu 24.04 stock: the sysctl closes the route — and its confined
  // `unshare` would still pass a probe, which is why the probe is not asked.
  let probed = false;
  assertEquals(
    await usernsAvailable(table({ [APPARMOR]: "1\n" }), () => {
      probed = true;
      return Promise.resolve(true);
    }),
    false,
  );
  assertEquals(probed, false, "a closing sysctl decides without a probe");
  // Debian with the clone knob off; a kernel with no namespaces at all.
  assertEquals(await usernsAvailable(table({ [CLONE]: "0" }), OPEN), false);
  assertEquals(await usernsAvailable(table({ [MAX]: "0" }), OPEN), false);
  // Every sysctl open (or absent): the measurement decides — a container's
  // seccomp profile refuses CLONE_NEWUSER while every file reads "allowed".
  assertEquals(
    await usernsAvailable(
      table({ [APPARMOR]: "0", [CLONE]: "1", [MAX]: "63000" }),
      OPEN,
    ),
    true,
  );
  assertEquals(
    await usernsAvailable(table({}), OPEN),
    true,
    "no sysctl files: the probe decides",
  );
  assertEquals(
    await usernsAvailable(table({}), RESTRICTED),
    false,
    "…and a refused clone closes it",
  );
});
