// `electron: { ignoreDebugEnv }` — a desktop app that does not read `AIO_CDP`,
// `AIO_PORT` or `AIO_DEFAULT_PORT` from the environment.
//
// From a field report (a wallet app's security audit): a packaged app opens a
// DevTools port from an ambient `AIO_CDP` and a loopback TCP listener from an
// ambient `AIO_PORT`, so a variable a tester exported for another aio app
// hands every local process the unlocked window. Ignoring them by default is
// what 1.0.15 did and 1.0.17 reverted, so the app asks for it.
//
// Three layers: the pure decider, a boot from source (a stand-in window —
// nothing opens anywhere), and — opt-in like every artifact test that needs
// the Electron runtime (AIO_BUILD_E2E=1 AIO_BUILD_ELECTRON=1) — the packaged
// app on the contained test display.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  buildFlags,
  childEnv,
  freePort,
  kill,
  makeApp,
} from "./e2e-app-harness.ts";
import {
  _resetParsedCli,
  cdpPort,
  DEFAULT_PORT_ENV,
  ignoredDebugEnv,
} from "../src/server/aio-cli.ts";
import {
  type LockData,
  lockDir,
  readLock,
} from "../src/server/single-instance-lock.ts";
import { testDisplayEnv } from "../src/testing/test-display.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const GATE = Deno.env.get("AIO_BUILD_E2E") === "1" &&
  Deno.env.get("AIO_BUILD_ELECTRON") === "1";
const LINUX = Deno.build.os === "linux";
const WIN = Deno.build.os === "windows";

Deno.test("ignoreDebugEnv: off, or not an Electron client — the environment is read as always", () => {
  const all = () => "1";
  assertEquals(ignoredDebugEnv(undefined, "electron", all), undefined);
  assertEquals(ignoredDebugEnv(false, "electron", all), undefined);
  // A server or a service has no command line: its unit file sets the port.
  for (const client of ["server-only", "browser", "cli"]) {
    assertEquals(ignoredDebugEnv(true, client, all), undefined, client);
  }
});

Deno.test("ignoreDebugEnv: on — every variable that is SET is named, an unset or empty one is not", () => {
  const env = (vars: Record<string, string>) => (name: string) => vars[name];
  assertEquals(ignoredDebugEnv(true, "electron", env({})), {
    ignored: [],
    mistyped: false,
  });
  assertEquals(
    ignoredDebugEnv(
      true,
      "electron",
      env({ AIO_CDP: "1", AIO_PORT: " ", [DEFAULT_PORT_ENV]: "3000" }),
    ),
    { ignored: ["AIO_CDP", DEFAULT_PORT_ENV], mistyped: false },
  );
  // A malformed value is ignored too — never the refusal `envPort` gives it.
  assertEquals(
    ignoredDebugEnv(true, "electron", env({ AIO_PORT: "havoc" }))?.ignored,
    ["AIO_PORT"],
  );
});

Deno.test("ignoreDebugEnv: a value that is not a boolean still closes the door, and is said", () => {
  for (const v of ["yes", "false", 1, 0, null, {}]) {
    assertEquals(
      ignoredDebugEnv(v, "electron", () => undefined),
      { ignored: [], mistyped: true },
      JSON.stringify(v),
    );
  }
});

Deno.test("ignoreDebugEnv: cdpPort does not read AIO_CDP when told to ignore it", () => {
  const prev = Deno.env.get("AIO_CDP");
  try {
    Deno.env.set("AIO_CDP", "9444");
    _resetParsedCli();
    assertEquals(cdpPort("electron", true), undefined);
    assertEquals(cdpPort(), undefined, "decided once: every later read agrees");
    _resetParsedCli();
    assertEquals(cdpPort("electron", false), 9444, "the control");
  } finally {
    _resetParsedCli();
    if (prev === undefined) Deno.env.delete("AIO_CDP");
    else Deno.env.set("AIO_CDP", prev);
  }
});

// ── a real boot ──────────────────────────────────────────────────────────────

/** The counter scaffold; `E2E_IGNORE=1` in its environment sets the key, so
 *  ONE app is both the case and its control. */
async function makeEnvApp(): Promise<string> {
  const dir = await makeApp("counter", "ignore-env-");
  await Deno.writeTextFile(
    join(dir, "src", "app.ts"),
    `import "./cell.ts";\nimport { aio } from "aio";\n` +
      `await aio.run({\n  ui: { theme: "auto" },\n` +
      `  electron: { ignoreDebugEnv: Deno.env.get("E2E_IGNORE") === "1" },\n` +
      `});\n`,
  );
  return dir;
}

/** This app's lock record, once it is written. */
function lockOf(id: string): LockData | undefined {
  let names: string[] = [];
  try {
    names = [...Deno.readDirSync(lockDir())].map((e) => e.name);
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
  for (const n of names) {
    if (
      !n.endsWith(".lock") || !(n === `${id}.lock` || n.startsWith(`${id}@`))
    ) {
      continue;
    }
    const data = readLock(n.slice(0, -".lock".length));
    if (data) return data;
  }
  return undefined;
}

/** Run `cmd` as the app until its lock is written; the lock and the output. */
async function bootedLock(
  cmd: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
): Promise<{ lock: LockData; out: string }> {
  const proc = new Deno.Command(cmd, {
    args,
    cwd,
    env: childEnv(env),
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  let out = "";
  let exited = false;
  const drain = async (s: ReadableStream<Uint8Array>) => {
    for await (const c of s) out += new TextDecoder().decode(c);
  };
  drain(proc.stdout).catch(() => {});
  drain(proc.stderr).catch(() => {});
  proc.status.then(() => exited = true);
  try {
    const end = Date.now() + 180_000;
    for (;;) {
      // The boot line comes after the lock and the listener: by then every
      // port this boot opens is decided and said.
      const id = /^\s+id\s+(\S+)$/m.exec(out)?.[1];
      const lock = id ? lockOf(id) : undefined;
      if (lock) return { lock, out };
      if (exited || Date.now() > end) {
        throw new Error(`the app never booted:\n${out.slice(-6000)}`);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  } finally {
    await kill(proc);
  }
}

function assertNothingFromEnv(
  r: { lock: LockData; out: string },
  named: string[],
  port: number,
  where: string,
): void {
  assertEquals(
    r.lock.cdpPort,
    undefined,
    `${where}: the lock advertises a DevTools port\n${r.out.slice(-4000)}`,
  );
  assert(
    r.lock.port !== port,
    `${where}: the app bound the ambient port ${port}`,
  );
  assert(
    !/\bcdp\s+127\.0\.0\.1:/.test(r.out),
    `${where}: a cdp line\n${r.out}`,
  );
  const said = r.out.split("\n").filter((l) => l.includes("set and ignored"));
  assertEquals(said.length, 1, `${where}: ONE warning\n${r.out.slice(-4000)}`);
  assertStringIncludes(said[0]!, named.join(", "), where);
  assertStringIncludes(said[0]!, "ignoreDebugEnv", where);
}

Deno.test({
  name:
    "ignoreDebugEnv boot: ambient AIO_CDP / AIO_PORT / AIO_DEFAULT_PORT open nothing and are named once; without the key they do, as before; a typed --cdp still works",
  ignore: WIN, // the stand-in window is a shell script
  sanitizeResources: false, // aio-ok: the spawned app owns its pipes; teardown kills it
  sanitizeOps: false, // aio-ok: the spawned app owns its pipes; teardown kills it
  async fn() {
    const dir = await makeEnvApp();
    const tmp = await tempDir("ignore-env-standin-");
    try {
      // The window: a process that IS what the server launched and opens
      // nothing. A display NAME so the launch happens at all.
      const stub = join(tmp, "electron");
      await Deno.writeTextFile(stub, "#!/bin/sh\nexec sleep 600\n");
      await Deno.chmod(stub, 0o755);
      const port = freePort();
      const ambient = {
        WAYLAND_DISPLAY: "aio-standin",
        ELECTRON_PATH: stub,
        AIO_CDP: "1",
        AIO_PORT: String(port),
        [DEFAULT_PORT_ENV]: String(freePort()),
      };
      const run = (env: Record<string, string>, ...flags: string[]) =>
        bootedLock(
          Deno.execPath(),
          ["run", "-A", "src/app.ts", "--client=electron", ...flags],
          dir,
          { ...ambient, ...env },
        );

      const control = await run({});
      assert(
        control.lock.cdpPort !== undefined && control.lock.port === port,
        `the control: without the key the environment decides — ${
          JSON.stringify(control.lock)
        }\n${control.out.slice(-4000)}`,
      );

      assertNothingFromEnv(
        await run({ E2E_IGNORE: "1" }),
        ["AIO_CDP", "AIO_PORT", DEFAULT_PORT_ENV],
        port,
        "dev",
      );

      const cdp = freePort();
      const typed = await run({ E2E_IGNORE: "1" }, `--cdp=${cdp}`);
      assertEquals(typed.lock.cdpPort, cdp, "a typed --cdp is this launch's");
    } finally {
      await Deno.remove(dir, { recursive: true });
      await dropTempDir(tmp);
    }
  },
});

Deno.test({
  name: "ignoreDebugEnv artifact: the packaged app, started with AIO_CDP=1 " +
    "and AIO_PORT in its environment, records no cdp port and binds no " +
    "ambient port",
  ignore: !GATE || !LINUX || !testDisplayEnv().DISPLAY,
  sanitizeResources: false, // aio-ok: real Electron children own sockets and timers; teardown kills them
  sanitizeOps: false, // aio-ok: real Electron children own sockets and timers; teardown kills them
  async fn() {
    const dir = await makeEnvApp();
    const home = await tempDir("ignore-env-home-");
    try {
      const r = await buildFlags(dir, "--compile", "--electron");
      assertEquals(r.code, 0, `electron build failed:\n${r.out}\n${r.err}`);
      const image = [...Deno.readDirSync(join(dir, "dist"))]
        .map((e) => e.name).find((n) => n.toLowerCase().endsWith(".appimage"));
      assert(image, "no AppImage in dist/");
      const imagePath = join(dir, "dist", image);
      await Deno.chmod(imagePath, 0o755);
      const port = freePort();
      const run = (env: Record<string, string>) =>
        bootedLock(imagePath, [], home, {
          ...testDisplayEnv(),
          HOME: home,
          TMPDIR: home,
          APPIMAGE_EXTRACT_AND_RUN: "1",
          AIO_CDP: "1",
          AIO_PORT: String(port),
          ...env,
        });
      // The control FIRST: the artifact does read the environment, so the
      // absence below is the key's doing and not a build that never looked.
      const control = await run({});
      assert(
        control.lock.cdpPort !== undefined,
        `the control: the packaged app honours AIO_CDP without the key\n${
          control.out.slice(-4000)
        }`,
      );
      assertNothingFromEnv(
        await run({ E2E_IGNORE: "1" }),
        ["AIO_CDP", "AIO_PORT"],
        port,
        "packaged",
      );
    } finally {
      await Deno.remove(dir, { recursive: true });
      await dropTempDir(home);
    }
  },
});
