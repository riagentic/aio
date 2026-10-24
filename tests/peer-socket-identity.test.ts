// peer() over the local socket (the Electron default: no TCP port) carries the
// caller's PROVEN identity, like a TCP handshake: an identity hello as the
// connection's first frame, the same proof, the same decider, the same
// `resolvePeer`. Parity: the same call to the same app, once over TCP and once
// over its socket, sees the same peer, user, access decision, view and hooks.
// A refused proof fails the caller loud and runs nothing behind it — never
// anonymous. Real apps (subprocesses), real sockets, real control keys.
import { assert, assertEquals } from "@std/assert";
import { fromFileUrl, join, toFileUrl } from "@std/path";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { childEnv } from "./e2e-app-harness.ts";

const ROOT = fromFileUrl(new URL("..", import.meta.url));

Deno.test({
  name:
    "peer identity: TCP and the local socket see the same peer, user, access decision and view; a forged hello runs nothing",
  // Linux: "no desktop session" boots an Electron app without a window (an
  // empty DISPLAY). Windows: the socket is a NAMED PIPE, and the "window" a
  // stand-in that opens nothing (`ELECTRON_PATH`) — the hello there is the
  // same code over a different local transport. macOS would open a window.
  ignore: Deno.build.os === "darwin",
  async fn() {
    const dir = await tempDir("peer-socket-identity-");
    const standIn = Deno.build.os === "windows"
      ? await windowStandIn(dir)
      : undefined;
    const mod = toFileUrl(join(ROOT, "mod.ts")).href;
    const src = (p: string) => toFileUrl(join(ROOT, "src", p)).href;
    const tag = `${Deno.pid}x${Date.now() % 100000}`;
    const caller = `psicaller${tag}`;
    await Deno.writeTextFile(
      join(dir, "App.tsx"),
      "export default function App() { return null; }\n",
    );
    // One callee, booted twice: socket-only (electron, no display) and TCP.
    await Deno.writeTextFile(
      join(dir, "callee.ts"),
      `import { aio, cell } from "${mod}";
const [appId, client, hooks] = Deno.args;
const seen = { resolved: [], asked: [], connected: [] };
const c = cell("svc", {
  state: { opened: 0, secret: "s3", pub: "o" },
  access: (u, m) => {
    if (m !== "seen") seen.asked.push(u ? u.id + "/" + u.role : "anon");
    return u?.role === "app";
  },
  visible: {
    include: ["opened", "secret", "pub"],
    forUser: (s, u) => u?.role === "app" ? s : { opened: s.opened, pub: s.pub },
  },
  methods: {
    open(s) { return ++s.opened; },
    seen() { return seen; },
  },
});
// Open to anyone: a call that ran anonymously would count here.
const pubc = cell("pubc", { state: { hits: 0 }, methods: { hit(s) { return ++s.hits; } } });
await aio.run({ appId, cells: [c, pubc], client, persist: false,
  // The socket runs onConnect only when asked (1.0.24 ran it on WS alone).
  localConnectHooks: hooks === "hooks",
  resolvePeer: (p) => { seen.resolved.push(p.app); return { id: p.app, role: "app" }; },
  onConnect: (u) => { seen.connected.push(u?.id ?? "anon"); },
});
`,
    );
    await Deno.writeTextFile(
      join(dir, "caller.ts"),
      `import { aio, cell } from "${mod}";
import { peer } from "${src("server-entry.ts")}";
import { _connectCliUDS } from "${src("server/cli-client.ts")}";
import { instances } from "${src("server/single-instance-lock.ts")}";
const c = cell("me", { state: { x: 0 }, methods: { getX(s) { return s.x; } } });
await aio.run({ appId: "${caller}", cells: [c], client: "server-only", persist: false });
const out = {};
for (const [name, target] of [["uds", Deno.args[0]], ["tcp", Deno.args[1]], ["udsDefault", Deno.args[2]]]) {
  let p = null;
  for (let i = 0; i < 300 && !p; i++) {
    p = await peer(target);
    if (!p) await new Promise((r) => setTimeout(r, 100));
  }
  const r = {};
  try {
    const live = instances(target).find((i) => i.status === "started");
    r.door = live.port > 0 ? "port" : "socket";
    r.call = await p.call("svc", "open");
    r.described = "svc" in (await p.describe()).cells;
    for (let i = 0; i < 100 && p.state?.svc?.secret === undefined; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    r.secret = p.state?.svc?.secret;
    r.seen = await p.call("svc", "seen");
    if (name === "uds") {
      // A forged hello: refused, and the call written behind it never runs.
      const forged = "v1 ${caller} " + Deno.pid + " " + "0".repeat(64);
      const link = _connectCliUDS(live.socketPath, {
        readyTimeoutMs: 10_000, proof: () => Promise.resolve(forged),
      });
      // Queued now, written right behind the hello — before its verdict.
      const t0 = Date.now();
      const behind = link.call("pubc", "hit").then(() => "ran", (e) => "refused");
      r.forged = await link.ready.then(() => "ready", (e) =>
        String(e.message).includes("refused this caller") ? "refused" : e.message);
      r.forgedFast = Date.now() - t0 < 3000;
      r.behind = await behind;
      link.close();
      r.after = await p.call("pubc", "hit");
    }
  } catch (e) { r.error = e.message; }
  p?.close();
  out[name] = r;
}
console.log("RESULT " + JSON.stringify(out));
Deno.exit(0);
`,
    );
    const env = {
      ...childEnv({ AIO_APPS_DIR: join(dir, "apps") }),
      DISPLAY: "",
      WAYLAND_DISPLAY: "",
      ...(standIn ? { ELECTRON_PATH: standIn } : {}),
    };
    const run = (args: string[], stdout: "piped" | "null") =>
      new Deno.Command(Deno.execPath(), {
        args: ["run", "-A", "--config", join(ROOT, "deno.json"), ...args],
        cwd: dir,
        env,
        stdout,
        stderr: "null",
      }).spawn();
    const udsId = `psiuds${tag}`;
    const tcpId = `psitcp${tag}`;
    const udsDefId = `psiudsd${tag}`;
    const apps = [
      run([join(dir, "callee.ts"), udsId, "electron", "hooks"], "null"),
      run([join(dir, "callee.ts"), tcpId, "server-only", "hooks"], "null"),
      // The default: no `localConnectHooks` — the socket runs no onConnect.
      run([join(dir, "callee.ts"), udsDefId, "electron"], "null"),
    ];
    try {
      const { stdout } = await run(
        [join(dir, "caller.ts"), udsId, tcpId, udsDefId],
        "piped",
      ).output();
      const line = new TextDecoder().decode(stdout).split("\n")
        .find((l) => l.startsWith("RESULT "));
      assert(line, "the caller printed no result");
      const out = JSON.parse(line.slice(7));
      const want = {
        call: 1,
        described: true,
        secret: "s3",
        seen: {
          resolved: [caller],
          // the call, then describe()'s probe of the same method
          asked: [`${caller}/app`, `${caller}/app`],
          connected: [caller],
        },
      };
      const { door: tcpDoor, ...tcp } = out.tcp;
      const { door: udsDoor, forged, forgedFast, behind, after, ...uds } =
        out.uds;
      assertEquals([tcpDoor, udsDoor], ["port", "socket"]);
      assertEquals(tcp, want);
      assertEquals(uds, tcp, "the socket sees what TCP sees");
      // Without `localConnectHooks` the socket is as 1.0.24: no onConnect.
      const { door: defDoor, ...udsDefault } = out.udsDefault;
      assertEquals(defDoor, "socket");
      assertEquals(udsDefault, {
        ...want,
        seen: { ...want.seen, connected: [] },
      }, "by default onConnect does not run for a socket peer");
      assertEquals({ forged, forgedFast, behind, after }, {
        forged: "refused",
        forgedFast: true,
        behind: "refused",
        after: 1, // the forged connection's call never ran
      });
    } finally {
      for (const a of apps) {
        a.kill("SIGTERM");
        await a.status;
      }
      await dropTempDir(dir);
    }
  },
});

/** Windows: an "Electron" that opens no window and connects to nothing (a
 *  window on the socket would be one more `onConnect`), compiled once. It
 *  lives exactly as long as the app that spawned it — `kill()` there ends the
 *  app at once, with no shutdown to stop its child — and never past 5 min. */
async function windowStandIn(dir: string): Promise<string> {
  const src = join(dir, "standin.ts");
  const exe = join(dir, "standin.exe");
  await Deno.writeTextFile(
    src,
    `const parent = Number(Deno.env.get("AIO_PARENT_PID"));
const alive = async () => {
  const o = await new Deno.Command("tasklist", {
    args: ["/FI", "PID eq " + parent, "/NH"], stdout: "piped", stderr: "null",
  }).output();
  return new TextDecoder().decode(o.stdout).includes(" " + parent + " ");
};
const t0 = Date.now();
while (parent > 0 && Date.now() - t0 < 300_000 && await alive()) {
  await new Promise((r) => setTimeout(r, 1000));
}
`,
  );
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["compile", "-A", "--no-check", "--no-config", "-o", exe, src],
    stdout: "null",
    stderr: "piped",
  }).output();
  assert(
    out.success,
    `the stand-in did not compile: ${new TextDecoder().decode(out.stderr)}`,
  );
  return exe;
}
