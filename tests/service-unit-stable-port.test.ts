// A service unit's port: stable when the app declares none, the app's own when
// it does.
//
// Before a8e5d0b98 every unit said `--port=3000`, and `--port` outranks
// `aio.run({ port })`, so an app declaring 8123 was installed on 3000. That
// commit dropped the flag — and the service then booted on a RANDOM port every
// restart (`ExecStart=/usr/local/bin/svc --expose --client=server-only`:
// :49167, then :57074). `AIO_PORT` would override the declaration exactly like
// the flag did, so the unit sets the chain's bottom rung instead:
// `--port` > `AIO_PORT` > `aio.run({ port })` > `AIO_DEFAULT_PORT` > free.
//
// Proven through the generated unit text AND a real boot fed the unit's own
// ExecStart flags and Environment= lines.
import { assert, assertEquals, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { writeServiceFile } from "../src/build/build-compile.ts";
import {
  _resetParsedCli,
  DEFAULT_PORT_ENV,
  envDefaultPort,
  parseCli,
} from "../src/server/aio-cli.ts";
import { aio } from "../src/server/aio.ts";
import { cell } from "../src/state/cell-create.ts";
import { _resetAioRuntime } from "../src/state/runtime-reset.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

async function unit(cfg: Record<string, unknown>): Promise<string> {
  const dir = await tempDir("aio-unit-stable-port-");
  const warn = console.warn;
  console.warn = () => {};
  try {
    await writeServiceFile(
      {
        binaryName: "svc",
        appTitle: "Svc",
        outDir: dir,
        root: dir,
        doRemote: false,
        doHeadless: true,
        ...cfg,
      } as unknown as Parameters<typeof writeServiceFile>[0],
    );
    return await Deno.readTextFile(join(dir, "svc.service"));
  } finally {
    console.warn = warn;
    await dropTempDir(dir);
  }
}

const execFlags = (text: string): string[] =>
  text.split("\n").find((l) => l.startsWith("ExecStart="))!
    .slice("ExecStart=".length).trim().split(/\s+/).slice(1);

/** The unit's Environment= assignments, unquoted the way systemd reads them. */
const unitEnv = (text: string): Record<string, string> =>
  Object.fromEntries(
    text.split("\n").filter((l) => l.startsWith("Environment=")).map((l) => {
      let v = l.slice("Environment=".length);
      if (v.startsWith('"')) v = v.slice(1, -1);
      const eq = v.indexOf("=");
      return [v.slice(0, eq), v.slice(eq + 1)];
    }),
  );

Deno.test("service unit: no port anywhere → no --port, and a stable AIO_DEFAULT_PORT", async () => {
  const text = await unit({ bakedServer: null });
  assertEquals(parseCli(execFlags(text)).port, undefined, text);
  assertEquals(unitEnv(text)[DEFAULT_PORT_ENV], "3000", text);
  // Not AIO_PORT: that rung outranks aio.run({ port }), like --port did.
  assertEquals(unitEnv(text).AIO_PORT, undefined, text);
});

Deno.test("service unit: build.server's port is pinned, with no default rung beside it", async () => {
  const text = await unit({ bakedServer: "http://10.0.0.5:8123" });
  assertEquals(parseCli(execFlags(text)).port, 8123);
  assertEquals(unitEnv(text)[DEFAULT_PORT_ENV], undefined, text);
});

Deno.test("envDefaultPort: unset is undefined, a port is a port, garbage is refused", () => {
  const prev = Deno.env.get(DEFAULT_PORT_ENV);
  try {
    Deno.env.delete(DEFAULT_PORT_ENV);
    assertEquals(envDefaultPort(), undefined);
    Deno.env.set(DEFAULT_PORT_ENV, " 3000 ");
    assertEquals(envDefaultPort(), 3000);
    for (const bad of ["havoc", "3000.5", "70000", "-1"]) {
      Deno.env.set(DEFAULT_PORT_ENV, bad);
      assertThrows(() => envDefaultPort(), Error, "is not a port");
    }
  } finally {
    if (prev === undefined) Deno.env.delete(DEFAULT_PORT_ENV);
    else Deno.env.set(DEFAULT_PORT_ENV, prev);
  }
});

/** Boot once the way systemd would start the unit: its ExecStart flags as
 *  Deno.args, its Environment= lines in the environment. Returns the bound port. */
async function bootLikeTheUnit(
  text: string,
  defaultPort: number,
  declared: number | undefined,
): Promise<number> {
  const dir = await tempDir("aio-unit-boot-");
  const argsDesc = Object.getOwnPropertyDescriptor(Deno, "args")!;
  const prevEnv = {
    AIO_PORT: Deno.env.get("AIO_PORT"),
    [DEFAULT_PORT_ENV]: Deno.env.get(DEFAULT_PORT_ENV),
  };
  Object.defineProperty(Deno, "args", {
    value: execFlags(text),
    configurable: true,
    enumerable: true,
  });
  _resetParsedCli();
  Deno.env.delete("AIO_PORT");
  // The unit's value is 3000; a test binds what freePort() hands it.
  assertEquals(unitEnv(text)[DEFAULT_PORT_ENV], "3000");
  Deno.env.set(DEFAULT_PORT_ENV, String(defaultPort));
  const log = { log: console.log, info: console.info, warn: console.warn };
  console.log = console.info = console.warn = () => {};
  try {
    _resetAioRuntime();
    const c = cell("svcport", {
      state: { n: 0 },
      methods: {
        inc(s: { n: number }) {
          s.n++;
        },
      },
    });
    const app = await aio.run({
      cells: [c],
      appId: "svc-stable-port",
      libraryMode: true,
      persist: false,
      baseDir: dir,
      ...(declared !== undefined ? { port: declared } : {}),
    });
    try {
      return app.port!;
    } finally {
      await app.close();
    }
  } finally {
    Object.assign(console, log);
    Object.defineProperty(Deno, "args", argsDesc);
    _resetParsedCli();
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
    await dropTempDir(dir);
  }
}

Deno.test({
  name:
    "service unit boot: two restarts of a no-port app bind the SAME port; a declared port still wins",
  async fn() {
    const text = await unit({ bakedServer: null });
    const stable = freePort();
    const first = await bootLikeTheUnit(text, stable, undefined);
    const second = await bootLikeTheUnit(text, stable, undefined);
    assertEquals(first, stable, "the no-port app ignored AIO_DEFAULT_PORT");
    assertEquals(second, first, "a restart moved the service's port");

    const declared = freePort();
    assert(declared !== stable);
    assertEquals(
      await bootLikeTheUnit(text, stable, declared),
      declared,
      "the unit's default outranked aio.run({ port })",
    );
  },
});
