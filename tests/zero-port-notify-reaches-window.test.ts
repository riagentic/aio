// The packaged desktop shape (prod, zero TCP ports, the page read off disk —
// `skipHttp`) runs no HTTP server, so its ServerHandle is a stub. That stub
// once had no `broadcastUi`: `notify()` and `appIcon()` reached nobody with
// the window open. `_udsOnlyBroadcastUi` is pinned as a function in
// tests/app-icon-replay.test.ts; THIS pins the boot wiring — a real
// `--prod --client=electron` boot over the unix socket, a client on that
// socket, a method that notifies and sets the icon, and both frames arriving.
import { childEnv } from "./e2e-app-harness.ts";
import { within } from "./within.ts";
import { assert } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import { descendantPids } from "../src/server/single-instance-lock.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { EXE, writeProgram } from "./fake-program-helper.ts";
import { spec } from "./module-spec-helper.ts";
import { connectRW, localIdle } from "./local-endpoint-helper.ts";

const REPO = dirname(dirname(fromFileUrl(import.meta.url)));
const DENO_JSON = join(REPO, "deno.json");

Deno.test({
  name:
    "zero-port prod app: notify() and appIcon() reach a window connected on the socket",
  async fn() {
    const dir = await tempDir("aio-skiphttp-notify-");
    const apps = join(dir, "apps");
    const home = join(dir, "home");
    await Deno.mkdir(apps);
    await Deno.mkdir(join(dir, "dist"));
    // A readable dist/ is what makes this the `skipHttp` shape.
    await Deno.writeTextFile(join(dir, "dist", "app.js"), "// bundle\n");
    const appId = `zn-${crypto.randomUUID().slice(0, 8)}`;
    await Deno.writeTextFile(
      join(dir, "app.ts"),
      `import { aio, appIcon, cell, notify } from "${spec(REPO)}/mod.ts";
const c = cell("c", { state: { n: 0 }, methods: {
  ping(s: any) {
    s.n++;
    s.$do(notify({ title: "zn-hello" }));
    s.$do(appIcon({ window: "/zn.png" }));
  },
} });
await aio.run({ cells: [c], appId: ${JSON.stringify(appId)},
  persist: false, appDir: ${JSON.stringify(home)},
  // The test client is not the Electron process the prod gate admits.
  electron: { allowLocalPeers: true } });
await new Promise(() => {});
`,
    );
    await Deno.writeTextFile(
      join(dir, "App.tsx"),
      `export default function App() { return <div>Hi</div>; }\n`,
    );
    const electron = join(dir, `electron${EXE}`);
    await writeProgram(electron, `#!/bin/sh\nexec sleep 120\n`);
    const env = childEnv({
      ...Deno.env.toObject(),
      AIO_APPS_DIR: apps,
      ELECTRON_PATH: electron,
    });
    const child = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        "--config",
        DENO_JSON,
        join(dir, "app.ts"),
        "--client=electron",
        "--prod",
      ],
      cwd: dir,
      env: Deno.env.get("WAYLAND_DISPLAY")
        ? env
        : { ...env, WAYLAND_DISPLAY: "aio-skiphttp-standin" },
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
      ).catch(() => {}); // aio-ok: the stream ends with the child
    const drained = Promise.all([drain(child.stdout), drain(child.stderr)]);
    const appLog = () =>
      Deno.readTextFile(join(home, "logs", "app.log")).catch(() => ""); // aio-ok: not written yet
    let kids: number[] = [];
    let conn: Awaited<ReturnType<typeof connectRW>> | undefined;
    try {
      const deadline = Date.now() + 90_000;
      let log = "";
      while (!/HTTP server skipped/.test(log = await appLog())) {
        assert(Date.now() < deadline, `never booted skipHttp:\n${out}`);
        await new Promise((r) => setTimeout(r, 200));
      }
      const sock = /transport: (?:UDS|named pipe) at (\S+)/.exec(log)?.[1];
      assert(sock, `no socket path in the log:\n${log}`);
      kids = await descendantPids(child.pid);
      conn = await connectRW(sock);
      await conn.write(
        new TextEncoder().encode(
          JSON.stringify({
            v: 2,
            t: "action",
            d: { type: "c:ping", payload: {}, cid: "zn-1" },
          }) + "\n",
        ),
      );
      let text = "";
      const c = conn;
      const both = () =>
        text.includes('"t":"notify"') && text.includes('"t":"icon"');
      const read = async () => {
        const buf = new Uint8Array(65536);
        while (!both()) {
          const n = await c.read(buf);
          if (n === null) return;
          text += new TextDecoder().decode(buf.subarray(0, n));
        }
      };
      await within(read(), 15_000, null);
      assert(text.includes("zn-hello"), `notify never arrived:\n${text}`);
      assert(text.includes("/zn.png"), `appIcon never arrived:\n${text}`);
    } finally {
      conn?.close();
      try {
        child.kill("SIGKILL");
      } catch { /* aio-ok: already ended */ }
      await child.status;
      // The stand-in window holds the piped stdout open: it goes first.
      for (const pid of kids) {
        try {
          Deno.kill(pid, "SIGKILL");
        } catch { /* aio-ok: ended with its app */ }
      }
      await drained;
      await localIdle();
      await dropTempDir(dir);
    }
  },
});
