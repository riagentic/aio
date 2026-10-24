// A packaged desktop app (prod, zero TCP ports, the page read off disk — the
// `skipHttp` shape) runs NO HTTP server, and its socket answered every control
// request "no control plane". So the one control request a release build is
// meant to serve — the stop, under the per-boot control credential — never
// reached it: `am stop`, `am kill` and a takeover all fell back to a signal.
// On Windows that is TerminateProcess: no `onStop`, no final flush. Measured on
// Windows 11 (2026-10-24): `am stop` and `am kill` of a one-click Electron app
// said `"how": "killed"` / `"hard"`, its data dir held no control.key, and its
// log had no shutdown line.
import { childEnv } from "./e2e-app-harness.ts";
import { within } from "./within.ts";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import { descendantPids } from "../src/server/single-instance-lock.ts";
import { skipHttpControl } from "../src/server/server-static.ts";
import {
  armLocalControl,
  disarmLocalControl,
  LOCAL_CONTROL_HEADER,
} from "../src/server/server-auth.ts";
import { readControlKey } from "../src/server/app-key.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { EXE, writeProgram } from "./fake-program-helper.ts";
import { spec } from "./module-spec-helper.ts";

const REPO = dirname(dirname(fromFileUrl(import.meta.url)));
const DENO_JSON = join(REPO, "deno.json");

Deno.test("skipHttpControl: the stop under this boot's credential is taken; nothing else is served", async () => {
  const dir = await tempDir("aio-skiphttp-ctl-");
  const prev = Deno.env.get("AIO_APPS_DIR");
  Deno.env.set("AIO_APPS_DIR", dir);
  const appId = `sh-${crypto.randomUUID().slice(0, 8)}`;
  const asked: string[] = [];
  const refused: boolean[] = [];
  const control = skipHttpControl(
    (by) => void asked.push(by),
    (p) => void refused.push(p),
  );
  const stop = (headers: Record<string, string>) =>
    control(
      new Request("http://uds.invalid/__aio/trojan/shutdown", {
        method: "POST",
        headers,
      }),
    );
  try {
    armLocalControl({ appId, prod: true });
    const key = readControlKey(appId);
    assert(key.error === undefined, key.error);
    // No credential, a wrong one: refused loudly, nothing stopped.
    assertEquals((await stop({})).status, 404);
    assertEquals((await stop({ [LOCAL_CONTROL_HEADER]: "nope" })).status, 404);
    assertEquals(refused, [false, true]);
    // Not the stop: still nothing of the trojan.
    const state = await control(
      new Request("http://uds.invalid/__aio/trojan/state"),
    );
    assertEquals(state.status, 503);
    await new Promise((r) => setTimeout(r, 0));
    assertEquals(asked, []);
    const ok = await stop({
      [LOCAL_CONTROL_HEADER]: key.key,
      "X-Aio-Stop-By": "takeover",
    });
    assertEquals(ok.status, 200);
    await new Promise((r) => setTimeout(r, 0));
    assertEquals(asked, ["takeover"]);
  } finally {
    disarmLocalControl(appId);
    if (prev === undefined) Deno.env.delete("AIO_APPS_DIR");
    else Deno.env.set("AIO_APPS_DIR", prev);
    await dropTempDir(dir);
  }
});

Deno.test({
  name:
    "zero-port prod app: `am stop` reaches its stop over the socket — a clean shutdown, not a signal",
  async fn() {
    const dir = await tempDir("aio-skiphttp-stop-");
    const apps = join(dir, "apps");
    const home = join(dir, "home");
    await Deno.mkdir(apps);
    await Deno.mkdir(join(dir, "dist"));
    // A readable dist/ is what makes this the `skipHttp` shape.
    await Deno.writeTextFile(join(dir, "dist", "app.js"), "// bundle\n");
    const appId = `zs-${crypto.randomUUID().slice(0, 8)}`;
    await Deno.writeTextFile(
      join(dir, "app.ts"),
      `import { aio, cell } from "${spec(REPO)}/mod.ts";
const c = cell("c", { state: { n: 1 }, methods: { inc(s: { n: number }) { s.n++; } } });
await aio.run({ cells: [c], appId: ${JSON.stringify(appId)},
  persist: false, appDir: ${JSON.stringify(home)},
  onStop: () => console.log("ONSTOP-RAN") });
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
      ).catch(() => {});
    const drained = Promise.all([drain(child.stdout), drain(child.stderr)]);
    const appLog = () =>
      Deno.readTextFile(join(home, "logs", "app.log")).catch(() => "");
    let kids: number[] = [];
    try {
      const deadline = Date.now() + 90_000;
      while (!/HTTP server skipped/.test(await appLog())) {
        assert(Date.now() < deadline, `never booted skipHttp:\n${out}`);
        await new Promise((r) => setTimeout(r, 200));
      }
      kids = await descendantPids(child.pid);
      const r = await new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "-A",
          "--config",
          DENO_JSON,
          join(REPO, "src/am.ts"),
          "stop",
          `--app=${appId}`,
          "--json",
        ],
        cwd: REPO,
        env: { ...env, ELECTRON_PATH: "" },
        stdout: "piped",
        stderr: "piped",
      }).output();
      const said = new TextDecoder().decode(r.stdout).trim();
      assertEquals(r.code, 0, `${said} ${new TextDecoder().decode(r.stderr)}`);
      assertEquals(JSON.parse(said).how, "graceful", said);
      const status = await within(child.status, 30_000, null);
      assert(status, `the app did not exit after the stop:\n${out}`);
      assertEquals(status.code, 0, out);
      assertStringIncludes(
        await appLog(),
        "stop requested over the control API (am stop)",
      );
      assertStringIncludes(out, "ONSTOP-RAN");
    } finally {
      try {
        child.kill("SIGKILL");
      } catch { /* aio-ok: the stop already ended it */ }
      await child.status;
      await drained;
      for (const pid of kids) {
        try {
          Deno.kill(pid, "SIGKILL");
        } catch { /* aio-ok: ended with its app */ }
      }
      await dropTempDir(dir);
    }
  },
});
