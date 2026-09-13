// The logger's `started` line names what the app ACTUALLY listens on.
//
// A local Electron app on a Unix socket binds zero TCP ports by default, yet
// `app.log` said `started cells=c port=49725` — `app.port` keeps a number for
// such an app (a frozen surface fact), and the line printed it. Anyone reading
// the log tried that port and got a refused connection. The boot report had
// already learned to print no number for this case; the log line had not.
//
// Real `aio.run` children (the Electron binary is a stand-in that sleeps), so
// the line under test is the one the shipped boot writes.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import { freePort } from "../src/testing/server-test.ts";
import { _setStartSocket, AioLogger } from "../src/diagnostics/logger-core.ts";

const REPO = dirname(dirname(fromFileUrl(import.meta.url)));

async function bootAndReadStarted(extraArgs: string[]): Promise<{
  line: string;
  appPort: string;
}> {
  const dir = await Deno.makeTempDir({ prefix: "aio-started-line-" });
  const apps = join(dir, "apps");
  const home = join(dir, "home");
  await Deno.mkdir(apps);
  const appId = `sl-${crypto.randomUUID().slice(0, 8)}`;
  await Deno.writeTextFile(
    join(dir, "app.ts"),
    `import { aio, cell } from "${REPO}/mod.ts";
const c = cell("c", { state: { n: 1 }, methods: { inc(s: { n: number }) { s.n++; } } });
const app = await aio.run({ cells: [c], appId: ${JSON.stringify(appId)},
  persist: false, appDir: ${JSON.stringify(home)} });
console.log("APPPORT=" + app.port);
await new Promise(() => {});
`,
  );
  await Deno.writeTextFile(
    join(dir, "App.tsx"),
    `export default function App() { return <div>Hi</div>; }\n`,
  );
  const electron = join(dir, "electron");
  await Deno.writeTextFile(electron, `#!/bin/sh\nexec sleep 120\n`);
  await Deno.chmod(electron, 0o755);

  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      "--config",
      join(REPO, "deno.json"),
      join(dir, "app.ts"),
      "--client=electron",
      ...extraArgs,
    ],
    cwd: dir,
    env: {
      ...Deno.env.toObject(),
      AIO_APPS_DIR: apps,
      ELECTRON_PATH: electron,
    },
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  let out = "";
  const drain = (s: ReadableStream<Uint8Array>) =>
    s.pipeTo(
      new WritableStream({
        write: (c) => {
          out = (out + new TextDecoder().decode(c)).slice(-16000);
        },
      }),
    ).catch(() => {});
  const drained = Promise.all([drain(child.stdout), drain(child.stderr)]);
  try {
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const log = await Deno.readTextFile(join(home, "logs", "app.log"))
        .catch(() => "");
      const line = log.split("\n").find((l) => / started {2}cells=/.test(l));
      const appPort = out.match(/APPPORT=(\S+)/)?.[1];
      if (line && appPort) return { line, appPort };
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`no started line within 90s; output:\n${out}`);
  } finally {
    child.kill("SIGTERM");
    await child.status;
    await drained;
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

Deno.test({
  name:
    "started line: a zero-port app names its socket, not a port it never bound",
  // Windows: the local socket is a named pipe; the UDS shape is what is pinned.
  ignore: Deno.build.os === "windows",
  async fn() {
    const { line, appPort } = await bootAndReadStarted([]);
    assertStringIncludes(line, "socket=");
    assert(!/ port=/.test(line), `names a port it never bound: ${line}`);
    // `app.port` is surface — untouched: still the number it always was.
    assert(/^\d+$/.test(appPort), `app.port changed: ${appPort}`);
  },
});

Deno.test({
  name: "started line: an app with a named TCP port still names that port",
  ignore: Deno.build.os === "windows",
  async fn() {
    const port = freePort();
    const { line, appPort } = await bootAndReadStarted([`--port=${port}`]);
    assertStringIncludes(line, ` port=${port}`);
    assertEquals(appPort, String(port));
  },
});

Deno.test("started line: AioLogger.onStart names the socket only for the logger it was set on", async () => {
  const dir = await Deno.makeTempDir({ prefix: "aio-started-unit-" });
  const startedLine = async (
    sub: string,
    use: (l: AioLogger) => void,
  ): Promise<string> => {
    const l = new AioLogger({
      dir: join(dir, sub),
      console: false,
      heartbeat: 0,
    });
    await l.init();
    use(l);
    await l.flush();
    return (await Deno.readTextFile(join(dir, sub, "app.log"))).trim();
  };
  try {
    const onSocket = await startedLine("uds", (l) => {
      _setStartSocket(l, "/run/x.sock");
      l.onStart(["c"]);
    });
    assertStringIncludes(onSocket, "socket=/run/x.sock");
    assert(!onSocket.includes("port="), onSocket);
    const onTcp = await startedLine("tcp", (l) => l.onStart(["c"], 8000));
    assertStringIncludes(onTcp, "port=8000");
    assert(!onTcp.includes("socket="), onTcp);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
