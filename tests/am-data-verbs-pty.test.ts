// Every DATA verb, at its CALL SITE, on a real terminal: what the app wrote
// (a ZWJ family emoji, a Hebrew RLM, its own 256-colour escape) reaches the
// person byte-exact. The sinks are pinned in am-output-data.test.ts; this pins
// that each verb CALLS the data sink — `am dispatch`, `am errors` and
// `am trigger` went through the message sink, and on a tty turned the app's
// ZWJ/RLM into `?` and its colours into `?[38;5;208m`.
//
// `script` gives the child a pty (so `am` is in pretty mode and every
// `isTerminal()` branch is the terminal one). The app is a stub on loopback
// answering the trojan routes and CDP — no app process, no window.
import { assert } from "@std/assert";
import { join } from "@std/path";
import { freePort } from "../src/testing/server-test.ts";
import { writeLock } from "../src/server/single-instance-lock.ts";
import { appDirs } from "../src/server/app-dirs.ts";
import { resolveAmAppId } from "../src/am/am-utils.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { dropFixtureLock } from "./fixture-lock-helper.ts";

const ZWJ = "👨‍👩‍👧";
const RLM = "‏";
const C256 = "\x1b[38;5;208m";
const PLANT = `Z${ZWJ} ${RLM}R ${C256}C\x1b[0m`;
const AM = join(import.meta.dirname!, "..", "src", "am.ts");
const ignore = !["linux", "darwin"].includes(Deno.build.os) ||
  !(() => {
    try {
      return new Deno.Command("script", { args: ["-V"], stderr: "null" })
        .outputSync(),
        true;
    } catch {
      return false;
    }
  })();

/** The stub app: trojan routes + `/json` and a CDP socket on one port. */
function stubApp(port: number, appId: string) {
  const node = {
    component: "App",
    elements: [{
      name: `A${ZWJ}${RLM}`,
      path: `App:A${ZWJ}${RLM}`,
      tag: "div",
      events: ["click"],
      text: PLANT,
    }],
    children: [],
  };
  const routes: Record<string, unknown> = {
    "/__aio/health": { appId, status: "ok" },
    "/__aio/error": { errors: [PLANT] },
    "/__aio/trojan/state": { c: { deep: { deeper: { s: PLANT } } } },
    "/__aio/trojan/dispatch": { ok: true, result: { s: PLANT }, unsaved: null },
    "/__aio/trojan/clients": [{ index: 1, type: "browser" }],
    "/__aio/trojan/trigger/1": {
      ok: true,
      path: "A",
      action: "click",
      text: PLANT,
    },
    "/__aio/trojan/surface/server": [node],
    "/__aio/trojan/timeline": {
      entries: [{
        seq: 1,
        type: "c:m",
        ts: Date.now(),
        payload: { args: [PLANT] },
        diff: [{ path: "c.s", before: "", after: PLANT }],
      }],
    },
    "/json": [{
      id: "p1",
      type: "page",
      url: `http://localhost:${port}/`,
      webSocketDebuggerUrl: `ws://127.0.0.1:${port}/ws/p1`,
    }],
  };
  const ac = new AbortController();
  const server = Deno.serve(
    { port, hostname: "127.0.0.1", signal: ac.signal, onListen() {} },
    async (req) => {
      const p = new URL(req.url).pathname;
      // A trigger on the path "FAIL" is answered as a failed one: `ok:false`
      // with the element list, the reply `am` prints and exits 1 on.
      if (p === "/__aio/trojan/trigger/1") {
        const body = await req.json() as { path?: string };
        if (body.path === "FAIL") {
          return Response.json({ ok: false, available: [PLANT] });
        }
      }
      if (p === "/ws/p1") {
        const { socket, response } = Deno.upgradeWebSocket(req);
        socket.onmessage = (e) => {
          const m = JSON.parse(String(e.data)) as { id: number };
          socket.send(JSON.stringify({
            id: m.id,
            result: { result: { type: "object", value: { s: PLANT } } },
          }));
        };
        return response;
      }
      return p in routes
        ? Response.json(routes[p])
        : new Response("no", { status: 404 });
    },
  );
  return { close: () => ac.abort(), finished: server.finished };
}

/** `am <args>` on a pty; stdout+stderr as the terminal received them. With
 *  `until`, reads until it appears and then hangs up (a follow never ends). */
async function onPty(
  args: string[],
  cwd: string,
  until?: (text: string) => boolean,
  whenStarted?: () => Promise<void>,
): Promise<string> {
  const argv = [Deno.execPath(), "run", "-A", AM, ...args];
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const child = new Deno.Command("script", {
    args: Deno.build.os === "darwin"
      ? ["-q", "/dev/null", ...argv]
      : ["-q", "-e", "-c", argv.map(q).join(" "), "/dev/null"],
    cwd,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  let text = "";
  const dec = new TextDecoder();
  const kill = setTimeout(() => {
    try {
      child.kill("SIGTERM");
    } catch { /* aio-ok: already exited */ }
  }, 30_000);
  try {
    let started = false;
    for await (const chunk of child.stdout) {
      text += dec.decode(chunk, { stream: true });
      if (until && !started && text.length > 0 && whenStarted) {
        started = true;
        await whenStarted();
      }
      if (until?.(text)) {
        child.kill("SIGTERM");
        break;
      }
    }
    await child.stderr.cancel();
    await child.status;
  } finally {
    clearTimeout(kill);
  }
  return text;
}

Deno.test({
  name: "data verbs on a tty: the app's ZWJ, RLM and 256-colour survive",
  ignore,
  async fn() {
    const root = await tempDir("am-pty-");
    const prev = Deno.env.get("AIO_APPS_DIR");
    Deno.env.set("AIO_APPS_DIR", join(root, "apps"));
    const appId = resolveAmAppId("ptyapp");
    const port = freePort();
    const app = stubApp(port, appId);
    try {
      writeLock({
        appId,
        pid: Deno.pid,
        port,
        startedAt: Date.now(),
        status: "started",
        cwd: root,
        cdpPort: port,
      });
      const logs = appDirs(appId).logs;
      await Deno.mkdir(logs, { recursive: true });
      await Deno.writeTextFile(join(logs, "error.log"), PLANT + "\n");
      await Deno.writeTextFile(join(logs, "stdout.log"), "first\n");
      const app_ = `--app=${appId}`;
      const verbs: [string, string[]][] = [
        ["state", ["state", app_]],
        ["dispatch", ["dispatch", "c:m", app_]],
        ["errors", ["errors", app_]],
        ["trigger", ["trigger", "A", "click", app_]],
        ["surface", ["surface", "server", app_]],
      ];
      const failed: string[] = [];
      const check = (verb: string, said: string, colour = true) => {
        const ok = said.includes(ZWJ) && said.includes(RLM) &&
          (!colour || said.includes(C256));
        if (!ok) failed.push(`${verb}: ${JSON.stringify(said.slice(0, 600))}`);
      };
      for (const [verb, args] of verbs) check(verb, await onPty(args, root));
      // `am eval` and `am timeline` render values as JSON, which spells ESC as
      // \u001b — the colour is text there by design; the ZWJ and the RLM are
      // not escaped, and survive.
      check("eval", await onPty(["eval", "x", app_], root), false);
      check("timeline", await onPty(["timeline", app_], root), false);
      // `am record` with no file prints the generated SOURCE (args as JSON).
      check("record", await onPty(["record", app_], root), false);
      // Element NAMES are the UI's text; a name carries no colour.
      check(
        "surface --names",
        await onPty(["surface", "server", "--names", app_], root),
        false,
      );
      // A trigger the client answered `ok:false` — the reply is still DATA.
      check(
        "trigger (failed)",
        await onPty(["trigger", "FAIL", "click", app_], root),
      );
      // `am logs -f`: the planted line is APPENDED after the follow started,
      // so it reaches the terminal through the stream sink.
      check(
        "logs -f",
        await onPty(
          ["logs", "-f", app_],
          root,
          (t) => /Z[^\n]*R [^\n]*C/.test(t), // the planted line, however mangled
          async () => {
            await new Promise((r) => setTimeout(r, 500));
            await Deno.writeTextFile(join(logs, "stdout.log"), PLANT + "\n", {
              append: true,
            });
          },
        ),
      );
      assert(failed.length === 0, failed.join("\n"));
    } finally {
      app.close();
      await app.finished;
      dropFixtureLock(appId);
      if (prev === undefined) Deno.env.delete("AIO_APPS_DIR");
      else Deno.env.set("AIO_APPS_DIR", prev);
      await dropTempDir(root);
    }
  },
});
