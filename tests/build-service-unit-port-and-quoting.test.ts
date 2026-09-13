// The generated systemd unit: the port it pins, and the values it quotes.
//
// 1. `--port=3000` was written into EVERY unit (writeServiceFile never passed a
//    port to serviceExecFlags). `--port` outranks `aio.run({ port })`, so an app
//    declaring port 8123 — or a fleet whose `build.server` said `host:8123` —
//    was installed as a service on 3000, where none of its clients look.
// 2. `Environment=HOME=/home/a b` is two assignments to systemd, and `b` is not
//    one: "Invalid environment assignment, ignoring: b", and HOME was never set.
//    `%` in HOME / the title / the user is a specifier, silently rewritten.
//
// The port half is proven through the REAL CLI parser, the quoting half
// through systemd's own verifier where the host has one.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  serviceExecFlags,
  servicePort,
  writeServiceFile,
} from "../src/build/build-compile.ts";
import { parseCli } from "../src/server/aio-cli.ts";
import { BUILD_VERSION_ENV } from "../src/server/app-version.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

async function unit(
  cfg: Record<string, unknown>,
): Promise<{ dir: string; text: string }> {
  const dir = await tempDir("aio-unit-port-");
  await writeServiceFile(
    {
      binaryName: "svc",
      appTitle: "Svc",
      outDir: dir,
      root: dir,
      doRemote: true,
      doHeadless: true,
      ...cfg,
    } as unknown as Parameters<typeof writeServiceFile>[0],
  );
  return { dir, text: await Deno.readTextFile(join(dir, "svc.service")) };
}

/** ExecStart's flags, as systemd hands them to the binary. */
const execFlags = (text: string): string[] =>
  text.split("\n").find((l) => l.startsWith("ExecStart="))!
    .slice("ExecStart=".length).trim().split(/\s+/).slice(1);

Deno.test("service unit: no port declared anywhere → no --port, the runtime's chain decides", async () => {
  const { dir, text } = await unit({ bakedServer: null });
  try {
    const cli = parseCli(execFlags(text));
    assertEquals(cli.port, undefined, `ExecStart pins a port: ${text}`);
    assertEquals(cli.expose, true);
    assertEquals(cli.client, "server-only");
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("service unit: build.server's explicit port is the port the service binds", async () => {
  const { dir, text } = await unit({ bakedServer: "http://10.0.0.5:8123" });
  try {
    assertEquals(parseCli(execFlags(text)).port, 8123);
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("servicePort: only an EXPLICIT port pins one", () => {
  assertEquals(servicePort("https://relay.example.com:8443"), 8443);
  assertEquals(servicePort("https://relay.example.com"), undefined);
  assertEquals(servicePort(null), undefined);
  assertEquals(servicePort(undefined), undefined);
  assertEquals(
    parseCli(serviceExecFlags({ doRemote: false, doHeadless: false })).port,
    undefined,
  );
});

Deno.test("service unit: HOME, the title and the user are quoted/escaped for systemd", async () => {
  const prev = { HOME: Deno.env.get("HOME"), USER: Deno.env.get("USER") };
  Deno.env.set("HOME", '/home/my user/100%/q"x\\y');
  Deno.env.set("USER", "svc%user");
  let dir = "";
  try {
    const r = await unit({ appTitle: "Svc 100% done" });
    dir = r.dir;
    // Verified against systemd 255 by loading the unit and reading the
    // environment the started process saw: `/home/my user/100%/q"x\y`.
    assertStringIncludes(
      r.text,
      '\nEnvironment="HOME=/home/my user/100%%/q\\"x\\\\y"\n',
    );
    assertStringIncludes(r.text, "\nDescription=Svc 100%% done (aio)\n");
    assertStringIncludes(r.text, "\nUser=svc%%user\n");
    const verdict = await systemdVerify(join(dir, "svc.service"));
    if (verdict !== null) {
      assert(
        !/Invalid environment assignment|Failed to (parse|resolve)/i.test(
          verdict,
        ),
        `systemd rejected part of the unit:\n${verdict}\n--- unit ---\n${r.text}`,
      );
    }
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
    if (dir) await dropTempDir(dir);
  }
});

/** systemd's own verifier, when this machine has one. Null otherwise. */
async function systemdVerify(path: string): Promise<string | null> {
  try {
    const r = await new Deno.Command("systemd-analyze", {
      args: ["verify", path],
      stdout: "piped",
      stderr: "piped",
    }).output();
    return new TextDecoder().decode(r.stderr) +
      new TextDecoder().decode(r.stdout);
  } catch {
    // aio-ok: no systemd-analyze on this host — the exact-text checks above
    // are the gate everywhere.
    return null;
  }
}

Deno.test("service unit: a per-target name is the unit's Description; a fleet child prints no stale install steps", async () => {
  // `--name=relay` is how a per-target `name` reaches the builder. The unit
  // read `Description=spapp (aio)` — the PROJECT's title on another app's
  // unit. And the "Install:" steps named the staged files the fleet was about
  // to rename; the fleet prints the placed names instead.
  const origArgs = Deno.args;
  const prevEnv = Deno.env.get(BUILD_VERSION_ENV);
  const lines: string[] = [];
  const origLog = console.log;
  Object.defineProperty(Deno, "args", {
    value: ["--name=relay"],
    configurable: true,
  });
  Deno.env.set(BUILD_VERSION_ENV, "{}");
  console.log = (...a: unknown[]) => lines.push(a.map(String).join(" "));
  let dir = "";
  try {
    const r = await unit({ appTitle: "spapp" });
    dir = r.dir;
    assertStringIncludes(r.text, "\nDescription=relay (aio)\n");
    assert(
      !lines.join("\n").includes("Install:"),
      `a fleet child printed install steps:\n${lines.join("\n")}`,
    );
  } finally {
    console.log = origLog;
    Object.defineProperty(Deno, "args", {
      value: origArgs,
      configurable: true,
    });
    if (prevEnv === undefined) Deno.env.delete(BUILD_VERSION_ENV);
    else Deno.env.set(BUILD_VERSION_ENV, prevEnv);
    if (dir) await dropTempDir(dir);
  }
});
