// The production local-peer lockdown, END TO END — the claim the boot log
// makes ("only this app's own window may connect"), attacked from outside.
//
// A real `aio.run` app is booted the way a production desktop app runs
// (`--prod --client=electron`, local socket, no TCP port) with a STAND-IN
// window: `$ELECTRON_PATH` names a script that becomes a small Deno program,
// which reads the socket paths out of the generated Electron main script it is
// handed — exactly what the real window uses — and opens a session. No window
// is ever opened on any display.
//
// This test process is the adversary: another process of the SAME user. It
// enumerates EVERY socket in the app's lock dir — not the ones it expects, the
// ones that exist — and puts every protocol to each of them. The unit tests
// pin the gate; this pins that no door was left outside it, which is the bug
// that shipped: the NDJSON socket refused a foreign process while the HTTP
// socket beside it upgraded the same process to a WebSocket, handed it the
// full state and dispatched its action.
//
// Linux only: the stand-in is a `sh` script and the lock dir is enumerated
// through the filesystem. macOS shares the code path (unverified there);
// Windows pipes are not enumerable this way.
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { dirname, join } from "@std/path";
import { realElectronBin } from "../src/electron/electron-spawn.ts";
import { localPeerLockdownPlan } from "../src/server/aio-server.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { childEnv } from "./e2e-app-harness.ts";
import { permissiveUmask } from "./permissive-umask.ts";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const NOTE = "hkept-e2e-note";
const ROUTE_BODY = "route-body-e2e";
const enc = new TextEncoder();
const dec = new TextDecoder();

// ── The claim, as a table ────────────────────────────────────────────────────

Deno.test("lockdown plan: the claim is printed only when the sockets are the only doors", () => {
  const base = {
    prod: true,
    localElectronUds: true,
    allowLocalPeers: false,
    zeroPort: true,
    port: 8000,
    cdp: undefined,
  };
  const full = localPeerLockdownPlan(base);
  assertEquals(full.gated, true);
  assertEquals(full.warn, []);
  assertStringIncludes(full.info.join(" "), "only this app's own window");

  // A named port: the socket is still gated, the claim is NOT made.
  const port = localPeerLockdownPlan({ ...base, zeroPort: false });
  assertEquals(port.gated, true);
  assertEquals(port.info, [], "the claim is false beside an open TCP port");
  assertStringIncludes(port.warn.join(" "), "TCP port 8000");
  assertStringIncludes(port.warn.join(" "), "local socket ONLY");

  // A DevTools port drives the window from any local process.
  const cdp = localPeerLockdownPlan({ ...base, cdp: 9333 });
  assertEquals([cdp.gated, cdp.info.length], [true, 0]);
  assertStringIncludes(cdp.warn.join(" "), "DevTools port 9333");

  // The opt-out: no gate, and it says so.
  const off = localPeerLockdownPlan({ ...base, allowLocalPeers: true });
  assertEquals([off.gated, off.info.length], [false, 0]);
  assertStringIncludes(off.warn.join(" "), "allowLocalPeers");

  // …and ONLY the boolean opens the door. A security key read by truthiness
  // fails open on what an env var or a JSON file hands over.
  for (const v of ["yes", "true", "false", "0", 1, {}, null]) {
    const typo = localPeerLockdownPlan({ ...base, allowLocalPeers: v });
    assertEquals(typo.gated, true, `allowLocalPeers: ${JSON.stringify(v)}`);
    assertStringIncludes(typo.info.join(" "), "only this app's own window");
    assertStringIncludes(typo.warn.join(" "), "is not a boolean");
    assertStringIncludes(typo.warn.join(" "), "stays ON");
    // Said in dev too, where it will not bite until the app is packaged.
    assertStringIncludes(
      localPeerLockdownPlan({ ...base, prod: false, allowLocalPeers: v })
        .warn.join(" "),
      "is not a boolean",
    );
  }
  assertEquals(
    localPeerLockdownPlan({ ...base, allowLocalPeers: undefined }).warn,
    [],
  );

  // Dev, and anything that is not a local Electron socket: nothing at all.
  for (const o of [{ prod: false }, { localElectronUds: false }]) {
    assertEquals(localPeerLockdownPlan({ ...base, ...o }), {
      gated: false,
      info: [],
      warn: [],
    });
  }
});

// ── The fixture: an app, and a stand-in for its window ───────────────────────

/** The stand-in window. Handed the generated main script as argv[0], like
 *  Electron is; speaks the session a window speaks, and reports what it was
 *  given on stdout. Reconnects when the server stays silent — the same
 *  handshake watch the real window runs. */
const WINDOW_TS = `
const script = Deno.readTextFileSync(Deno.args[0]);
const lit = (name) => {
  const k = "const " + name + " = ";
  const i = script.indexOf(k) + k.length;
  return JSON.parse(script.slice(i, script.indexOf(";", i)));
};
const SOCK = lit("SOCK"), HTTP_SOCK = lit("HTTP_SOCK");
const say = (s) => console.log("[window] " + s);
const te = new TextEncoder(), td = new TextDecoder();
say("pid " + Deno.pid);
async function route() {
  const c = await Deno.connect({ transport: "unix", path: HTTP_SOCK });
  await c.write(te.encode("GET /api/hello HTTP/1.1\\r\\nHost: app\\r\\nConnection: close\\r\\n\\r\\n"));
  let out = ""; const b = new Uint8Array(65536);
  try { while (true) { const n = await c.read(b); if (n === null) break; out += td.decode(b.subarray(0, n)); } } catch { /* closed */ }
  try { c.close(); } catch { /* closed */ }
  say("http " + out.split("\\r\\n")[0] + " | " + (out.split("\\r\\n\\r\\n")[1] ?? "").trim());
}
for (let attempt = 0; attempt < 20; attempt++) {
  const c = await Deno.connect({ transport: "unix", path: SOCK });
  let spoke = false, acted = false, buf = "";
  const watch = setTimeout(() => { if (!spoke) { say("no handshake — reconnecting"); try { c.close(); } catch { /* closed */ } } }, 2000);
  const b = new Uint8Array(1 << 16);
  try {
    while (true) {
      const n = await c.read(b); if (n === null) break;
      spoke = true; buf += td.decode(b.subarray(0, n));
      const lines = buf.split("\\n"); buf = lines.pop();
      for (const l of lines) {
        if (!l) continue;
        const f = JSON.parse(l);
        say(f.t + " " + JSON.stringify(f.d));
        if (f.t === "state" && Deno.env.get("E2E_WINDOW_EXITS")) Deno.exit(0);
        if (f.t === "state" && !acted) {
          acted = true;
          await c.write(te.encode(JSON.stringify({ v: 2, t: "action", d: { type: "c:inc", cid: "w1" } }) + "\\n"));
        }
        if (f.t === "ack" && HTTP_SOCK) await route();
      }
    }
  } catch { /* closed */ }
  clearTimeout(watch);
  await new Promise((r) => setTimeout(r, 200));
}
`;

type Fixture = { dir: string; app: string; home: string; stub: string };

async function fixture(): Promise<Fixture> {
  const dir = await tempDir("peer-e2e-");
  const app = join(dir, "app");
  await Deno.mkdir(join(app, "src"), { recursive: true });
  const head = JSON.parse(await Deno.readTextFile(join(ROOT, "deno.json")));
  const imports: Record<string, string> = {};
  for (const [k, v] of Object.entries(head.imports as Record<string, string>)) {
    imports[k] = v.startsWith("./") ? `${ROOT}/${v.slice(2)}` : v;
  }
  await Deno.writeTextFile(
    join(app, "deno.json"),
    JSON.stringify({ compilerOptions: head.compilerOptions, imports }),
  );
  await Deno.writeTextFile(
    join(app, "src", "App.tsx"),
    `export default function App() { return <p>myapp</p>; }\n`,
  );
  await Deno.writeTextFile(
    join(app, "src", "app.ts"),
    `import { aio, cell } from "aio";
const c = cell("c", {
  state: { n: 1, note: ${JSON.stringify(NOTE)} },
  methods: { inc(s: { n: number }) { s.n++; } },
});
await aio.run({
  appId: "myapp",
  cells: [c],
  persist: false,
  routes: { "/api/hello": () => new Response(${JSON.stringify(ROUTE_BODY)}) },
  onStop: () => console.log("[app] onStop ran"),
  ...(Deno.env.get("E2E_ALLOW_PEERS")
    ? {
      electron: {
        // "true" is the boolean; anything else is passed AS WRITTEN — what a
        // config assembled from an env var or a JSON file holds.
        allowLocalPeers: (Deno.env.get("E2E_ALLOW_PEERS") === "true"
          ? true
          : Deno.env.get("E2E_ALLOW_PEERS")) as boolean,
      },
    }
    : {}),
});
`,
  );
  await Deno.writeTextFile(join(dir, "window.ts"), WINDOW_TS);
  // `exec`: the stand-in BECOMES the process the server spawned, as Electron
  // does. (The wrapper that does not is its own case below.)
  const stub = join(dir, "electron");
  await Deno.writeTextFile(
    stub,
    `#!/bin/sh\nexec '${Deno.execPath()}' run -A '${dir}/window.ts' "$@"\n`,
  );
  await Deno.chmod(stub, 0o755);
  return { dir, app, home: join(dir, "home"), stub };
}

type Running = {
  /** The app's own process. */
  pid: number;
  log: () => string;
  /** Resolve once `re` matches the combined output; throw (with the log) when
   *  the app exits or `ms` passes first. */
  until: (re: RegExp, ms?: number) => Promise<RegExpExecArray>;
  status: Promise<Deno.CommandStatus>;
  stop: () => Promise<void>;
};

function boot(
  f: Fixture,
  o: {
    args?: string[];
    env?: Record<string, string>;
    perms?: string[];
    electronPath?: string;
    /** Replaces `--client=electron` (a production app on a TCP port). */
    client?: string;
  } = {},
): Running {
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      ...(o.perms ?? ["-A"]),
      "src/app.ts",
      o.client ?? "--client=electron",
      "--prod",
      ...(o.args ?? []),
    ],
    cwd: f.app,
    env: childEnv({
      // A display NAME so the launch happens at all; the stand-in opens no
      // window on it or anywhere else.
      WAYLAND_DISPLAY: "aio-standin",
      ELECTRON_PATH: o.electronPath ?? f.stub,
      AIO_APPS_DIR: f.home,
      ...o.env,
    }),
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  let log = "";
  let exited = false;
  const pump = async (s: ReadableStream<Uint8Array>) => {
    for await (const x of s) log += dec.decode(x);
  };
  const pumps = Promise.all([pump(child.stdout), pump(child.stderr)]);
  const status = child.status.then((s) => {
    exited = true;
    return s;
  });
  return {
    pid: child.pid,
    log: () => log,
    status,
    async until(re, ms = 60_000) {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        const m = re.exec(log);
        if (m) return m;
        if (exited) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      // Only an app that EXITED has a last word still in the pipe; waiting
      // for the pipes of one that is running would wait for ever.
      if (exited) await pumps.catch(() => {});
      const m = re.exec(log);
      if (m) return m;
      throw new Error(`never saw ${re} — the app's output:\n${log}`);
    },
    async stop() {
      if (!exited) {
        try {
          child.kill("SIGTERM");
        } catch { /* already gone */ }
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const st = await Promise.race([
        status,
        new Promise<null>((r) => timer = setTimeout(() => r(null), 20_000)),
      ]).finally(() => clearTimeout(timer));
      if (!st) {
        child.kill("SIGKILL");
        await status;
      }
      await pumps;
    },
  };
}

// ── The adversary ────────────────────────────────────────────────────────────

/** Open `path`, send `bytes`, and return everything received until the peer
 *  closes, `done` says enough arrived, or `ms` passes. */
async function exchange(
  path: string,
  bytes: string,
  ms: number,
  done?: (got: string) => boolean,
): Promise<string> {
  const c = await Deno.connect({ transport: "unix", path });
  let got = "";
  const timer = setTimeout(() => {
    try {
      c.close();
    } catch { /* already closed */ }
  }, ms);
  try {
    if (bytes) await c.write(enc.encode(bytes));
    const b = new Uint8Array(1 << 16);
    while (true) {
      const n = await c.read(b);
      if (n === null) break;
      got += dec.decode(b.subarray(0, n));
      if (done?.(got)) break;
    }
  } catch { /* closed by the deadline, or by the server */ }
  clearTimeout(timer);
  try {
    c.close();
  } catch { /* already closed */ }
  return got;
}

const frame = (t: string, d: unknown) => JSON.stringify({ v: 2, t, d }) + "\n";

/** Every frame that opens a session, reads state or runs code. */
const SESSION_FRAMES = frame("proto", { v: 3, min: 3, ver: "0.0.0" }) +
  frame("subs", { subs: ["*"] }) +
  frame("resync", {}) +
  frame("action", { type: "c:inc", cid: "atk" }) +
  frame("sfn", { cid: "s1", ns: "a", name: "b", args: [] }) +
  frame("tt-cmd", "pause") +
  frame("op", { id: "o", cell: "c", action: "inc", hlc: [1, 0, "x"] }) +
  frame("sync-req", { clientId: "x" }) +
  frame("client-state", { n: 99 });

const PATHS = [
  "/",
  "/app.js",
  "/api/hello",
  "/ws",
  "/__aio/health",
  "/__aio/vitals",
  "/__aio/metrics",
  "/__aio/snapshot",
  "/__aio/icon",
  "/__aio/trojan/state",
  "/__aio/trojan/dispatch",
  "/__aio/trojan/shutdown",
  "/__aio/trojan/sql",
];

/** Paths that LOOK like the one a foreign `ctl` may ask. Only the query form
 *  is it. */
const CTL_LOOKALIKES = [
  "/__aio/health?x=1",
  "/__aio/health/../vitals",
  "/__aio/health/",
  "//__aio/health",
  "/__aio/health%3fx",
  "/__aio/vitals?/__aio/health",
  "http://x/__aio/health",
];

const H = "Host: localhost\r\n";
/** Raw HTTP a foreign process may throw at a door. */
const RAW_HTTP: [string, string][] = [
  [
    "two requests in one write",
    `GET /api/hello HTTP/1.1\r\n${H}\r\nGET / HTTP/1.1\r\n${H}\r\n`,
  ],
  [
    "keep-alive, then a second request",
    `GET / HTTP/1.1\r\n${H}Connection: keep-alive\r\n\r\n` +
    `GET /api/hello HTTP/1.1\r\n${H}Connection: close\r\n\r\n`,
  ],
  [
    "Transfer-Encoding and Content-Length",
    `POST /api/hello HTTP/1.1\r\n${H}Content-Length: 4\r\n` +
    `Transfer-Encoding: chunked\r\n\r\n0\r\n\r\nGET /api/hello HTTP/1.1\r\n${H}\r\n`,
  ],
  [
    "Content-Length that hides a request",
    `POST /api/hello HTTP/1.1\r\n${H}Content-Length: 0\r\n\r\n` +
    `GET /api/hello HTTP/1.1\r\n${H}\r\n`,
  ],
  [
    "a header without a colon",
    `GET /api/hello HTTP/1.1\r\n${H}nocolon\r\n\r\n`,
  ],
  ["HTTP/0.9", "GET /api/hello\r\n\r\n"],
  ["the HTTP/2 preface", "PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n"],
  ["CONNECT", `CONNECT localhost:443 HTTP/1.1\r\n${H}\r\n`],
  ["absolute-form", `GET http://app/api/hello HTTP/1.1\r\n${H}\r\n`],
  [
    "Expect: 100-continue",
    `POST /api/hello HTTP/1.1\r\n${H}Expect: 100-continue\r\nContent-Length: 3\r\n\r\n`,
  ],
  [
    "an 8 MB body",
    `POST /api/hello HTTP/1.1\r\n${H}Content-Length: ${8 << 20}\r\n\r\n` +
    "x".repeat(8 << 20),
  ],
  [
    "a 1 MB header",
    `GET /api/hello HTTP/1.1\r\nX: ${"a".repeat(1 << 20)}\r\n\r\n`,
  ],
  ["a head that never ends", `GET /api/hello HTTP/1.1\r\n${H}X-Slow: `],
  ["one byte", "G"],
];

/** Attack ONE socket with every protocol, whatever it is for. Throws on the
 *  first thing a foreign process must not get. */
async function attack(sock: string): Promise<void> {
  const leaks = (s: string) => s.includes(NOTE) || s.includes(ROUTE_BODY);

  // 1. The WebSocket upgrade — the door that handed out state and dispatched.
  const ws = await exchange(
    sock,
    "GET /ws HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\n" +
      "Connection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
      "Sec-WebSocket-Version: 13\r\n\r\n",
    1500,
  );
  assert(
    !ws.startsWith("HTTP/1.1 101") && !leaks(ws),
    `${sock} upgraded a foreign process to a WebSocket: ${ws.slice(0, 300)}`,
  );

  // 2. HTTP: no page, no route, no health document, no state.
  const http = await Promise.all(PATHS.map(async (p) => ({
    p,
    res: await exchange(
      sock,
      `GET ${p} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`,
      1500,
    ),
  })));
  for (const { p, res } of http) {
    assert(
      !/^HTTP\/1\.1 [23]/.test(res) && !leaks(res),
      `HTTP GET ${p} over ${sock} was served to a foreign process: ` +
        res.slice(0, 300),
    );
  }

  // 2b. HTTP as an attacker writes it: smuggling shapes, half-requests, a
  // request that never ends. On the door that speaks HTTP every one is the
  // SAME answer — 403, decided at accept, before a byte is parsed — and the
  // connection is closed, never held. On the state socket they are noise.
  const isHttpDoor = sock.endsWith(".http.sock");
  const raw = await Promise.all(RAW_HTTP.map(async ([name, bytes]) => ({
    name,
    res: await exchange(sock, bytes, 6000),
  })));
  for (const { name, res } of raw) {
    assert(
      !/^HTTP\/1\.1 [123]/.test(res) && !leaks(res),
      `"${name}" over ${sock} was served to a foreign process: ` +
        res.slice(0, 300),
    );
    if (isHttpDoor) {
      assert(
        res.startsWith("HTTP/1.1 403"),
        `"${name}" over ${sock} was not refused by the gate: ` +
          JSON.stringify(res.slice(0, 200)),
      );
      assertEquals(
        res.split("HTTP/1.1 ").length,
        2,
        `"${name}" was answered more than once: ${res.slice(0, 300)}`,
      );
    }
  }

  // 3. A session: nothing at accept, nothing for any session frame.
  const session = await exchange(sock, SESSION_FRAMES, 900);
  assertEquals(
    session,
    "",
    `${sock} answered a foreign process's session frames`,
  );

  // 4. `ctl`: the allow-list, and only it.
  const ctl: { id: string; method: string; path: string }[] = [];
  for (const path of [...PATHS, ...CTL_LOOKALIKES]) {
    for (const method of ["GET", "POST"]) {
      ctl.push({ id: `${ctl.length}`, method, path });
    }
  }
  const replies = await exchange(
    sock,
    ctl.map((c) =>
      frame("ctl", {
        id: c.id,
        path: c.path,
        method: c.method,
        ...(c.method === "POST" ? { body: "{}" } : {}),
      })
    ).join(""),
    3000,
    (got) => got.split("\n").length > ctl.length,
  );
  // The HTTP door does not speak NDJSON: it tells this foreign peer what it
  // tells every one — 403, after the bounded wait for a request head.
  if (replies.startsWith("HTTP/1.1 403")) {
    assert(!leaks(replies), `${sock} leaked app data: ${replies}`);
    return;
  }
  for (const line of replies.split("\n")) {
    if (!line) continue;
    const r = JSON.parse(line) as {
      t: string;
      d: { id: string; status: number; body: string };
    };
    assertEquals(r.t, "ctlr", `${sock} sent a foreign process: ${line}`);
    const asked = ctl[Number(r.d.id)]!;
    const what = `ctl ${asked.method} ${asked.path} over ${sock}`;
    assert(!leaks(r.d.body), `${what} leaked app data: ${r.d.body}`);
    if (
      asked.method === "GET" &&
      (asked.path === "/__aio/health" || asked.path === "/__aio/health?x=1")
    ) {
      assertEquals(r.d.status, 200, `${what}: ${r.d.body}`);
      assertEquals(
        JSON.parse(r.d.body),
        { status: "healthy", appId: "myapp" },
        `${what} must say only "up" and "which app"`,
      );
    } else {
      assert(
        r.d.status !== 200,
        `${what} answered ${r.d.status} to a foreign process: ${r.d.body}`,
      );
    }
  }
}

const linuxOnly = Deno.build.os !== "linux";

/** Can this process — the same user, a different process — read `pid`'s open
 *  descriptors? What `PR_SET_DUMPABLE 0` takes away. */
async function procReadable(pid: number): Promise<boolean> {
  try {
    for await (const _ of Deno.readDir(`/proc/${pid}/fd`)) break;
    return true;
  } catch (e) {
    if (e instanceof Deno.errors.PermissionDenied) return false;
    throw e;
  }
}

Deno.test({
  name:
    "lockdown e2e: every socket in the lock dir refuses a foreign process; the window is served",
  ignore: linuxOnly,
  async fn() {
    const f = await fixture();
    const app = boot(f);
    try {
      // The window gets its session: handshake, state, a dispatched method,
      // and its own route over the HTTP socket.
      await app.until(/\[window\] proto /);
      await app.until(/\[window\] state \{"c":\{"n":1,/);
      await app.until(/\[window\] ack \{"cid":"w1","ok":true/);
      await app.until(/\[window\] state \{"c":\{"n":2,/);
      const route = await app.until(/\[window\] http (.*)/);
      assertEquals(route[1], `HTTP/1.1 200 OK | ${ROUTE_BODY}`);
      assertStringIncludes(
        app.log(),
        "local-peer lockdown: only this app's own window may connect",
      );

      // Every socket that EXISTS — found, not assumed.
      const main = (await app.until(/transport: UDS at (\S+)/))[1]!;
      const socks: string[] = [];
      for await (const e of Deno.readDir(dirname(main))) {
        const p = join(dirname(main), e.name);
        if ((await Deno.lstat(p)).isSocket) socks.push(p);
      }
      assert(
        socks.includes(main) && socks.some((s) => s.endsWith(".http.sock")),
        `this fixture must have BOTH local doors (state + http): ${socks}`,
      );
      for (const s of socks.sort()) await attack(s);

      // Nothing the adversary sent was dispatched: the window would have been
      // broadcast the next state.
      await new Promise((r) => setTimeout(r, 300));
      assert(
        !/\[window\] state \{"c":\{"n":3,/.test(app.log()),
        `a foreign process's action was dispatched:\n${app.log()}`,
      );
      // …and each refusal was said, with its reason.
      assertStringIncludes(app.log(), `it is pid ${Deno.pid}; the window is`);

      // The memory behind the socket: the app made itself non-dumpable, so a
      // process of the same user cannot read its descriptors or environment.
      assertStringIncludes(app.log(), "(this process is non-dumpable)");
      assertEquals(await procReadable(app.pid), false);
    } finally {
      await app.stop();
      await dropTempDir(f.dir);
    }
  },
});

Deno.test({
  name:
    "lockdown e2e: a dev-tree launcher (node_modules/.bin/electron) is not the window — the binary is spawned",
  ignore: linuxOnly,
  async fn() {
    const f = await fixture();
    // npm's layout: `.bin/electron` is a shim that STARTS the binary path.txt
    // names, as a child. Armed with the shim's pid, the gate refused the
    // app's own window forever.
    const pkg = join(f.app, "node_modules", "electron");
    await Deno.mkdir(join(pkg, "dist"), { recursive: true });
    await Deno.mkdir(join(f.app, "node_modules", ".bin"));
    await Deno.writeTextFile(join(pkg, "path.txt"), "electron");
    await Deno.copyFile(f.stub, join(pkg, "dist", "electron"));
    await Deno.chmod(join(pkg, "dist", "electron"), 0o755);
    const shim = join(f.app, "node_modules", ".bin", "electron");
    await Deno.writeTextFile(
      shim,
      `#!/bin/sh\n'${pkg}/dist/electron' "$@"\n`,
    );
    await Deno.chmod(shim, 0o755);
    const app = boot(f, { electronPath: "" });
    try {
      await app.until(/launching Electron \(dev, UDS\)/);
      await app.until(/\[window\] state \{"c":\{"n":1,/);
      // The window was served, so it was never the refused peer.
      assert(
        !/local-peer lockdown.*refus/i.test(app.log()),
        `the app's own window was refused:\n${app.log()}`,
      );
    } finally {
      await app.stop();
      await dropTempDir(f.dir);
    }
  },
});

Deno.test("lockdown: the dev launcher resolves to the binary under $ELECTRON_OVERRIDE_DIST_PATH, with or without path.txt", async () => {
  // The process that is armed is the one that is spawned. The shim's rule
  // for an override is `<override>/<path.txt, or "electron">`; resolving it
  // only when path.txt existed spawned the SHIM for the layout an override
  // is for — and the window, its child, was refused.
  const dir = await tempDir("peer-bin-");
  try {
    const pkg = join(dir, "node_modules", "electron");
    const shim = join(dir, "node_modules", ".bin", "electron");
    const dist = join(dir, "custom-dist");
    await Deno.mkdir(pkg, { recursive: true });
    await Deno.mkdir(dist);
    await Deno.writeTextFile(join(dist, "electron"), "");
    await Deno.writeTextFile(join(dist, "named"), "");
    assertEquals(await realElectronBin(shim, dist), join(dist, "electron"));
    await Deno.writeTextFile(join(pkg, "path.txt"), "named\n");
    assertEquals(await realElectronBin(shim, dist), join(dist, "named"));
    // No override, and a binary that is not there: the launcher, as given.
    assertEquals(await realElectronBin(shim, undefined), shim);
    await Deno.remove(join(pkg, "path.txt"));
    assertEquals(await realElectronBin(shim, undefined), shim);
    assertEquals(await realElectronBin(shim, join(dir, "nowhere")), shim);
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test({
  name:
    "lockdown e2e: a wrapper that does not exec the window is refused LOUDLY, with the way out",
  ignore: linuxOnly,
  async fn() {
    const f = await fixture();
    const wrapper = join(f.dir, "wrapper");
    await Deno.writeTextFile(wrapper, `#!/bin/sh\n'${f.stub}' "$@"\n`);
    await Deno.chmod(wrapper, 0o755);
    const app = boot(f, { electronPath: wrapper });
    try {
      const line = (await app.until(/ERROR .*local-peer lockdown: refused.*/))[
        0
      ];
      assertStringIncludes(line, "CHILD of the process this app launched");
      assertStringIncludes(line, "$ELECTRON_PATH");
      await app.until(/\[window\] no handshake/);
      assert(!app.log().includes("[window] state"), app.log());
    } finally {
      await app.stop();
      await dropTempDir(f.dir);
    }
  },
});

Deno.test({
  name:
    "lockdown e2e: when the window exits the gate is disarmed — its pid is no longer the trusted one",
  ignore: linuxOnly,
  async fn() {
    const f = await fixture();
    const app = boot(f, {
      args: ["--keep-server"],
      env: { E2E_WINDOW_EXITS: "1" },
    });
    try {
      const main = (await app.until(/transport: UDS at (\S+)/))[1]!;
      const pid = (await app.until(/\[window\] pid (\d+)/))[1]!;
      await app.until(/\[window\] state /);
      await app.until(/electron closed/);
      // The server outlives its window. Whatever process is handed that pid
      // next must not be the window: the gate names NO process now.
      assertEquals(await exchange(main, SESSION_FRAMES, 700), "");
      const refused = (await app.until(/local-peer lockdown: refused.*/))[0];
      assertStringIncludes(refused, "has not registered its process yet");
      assert(
        !refused.includes(`the window is ${pid}`),
        `pid ${pid} is still the trusted one after its process exited`,
      );
    } finally {
      await app.stop();
      await dropTempDir(f.dir);
    }
  },
});

Deno.test({
  name:
    "lockdown e2e: without --allow-ffi the app refuses to start, naming the flag",
  ignore: linuxOnly,
  async fn() {
    const f = await fixture();
    const app = boot(f, {
      perms: [
        "--no-prompt",
        "--allow-read",
        "--allow-write",
        "--allow-env",
        "--allow-net",
        "--allow-run",
        "--allow-sys",
      ],
    });
    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const st = await Promise.race([
        app.status,
        new Promise<null>((r) => timer = setTimeout(() => r(null), 60_000)),
      ]).finally(() => clearTimeout(timer));
      assert(st, `the app kept running ungated:\n${app.log()}`);
      assert(st.code !== 0, `exit 0 for a refused boot:\n${app.log()}`);
      await app.stop();
      assertStringIncludes(app.log(), "local-peer lockdown cannot start");
      assertStringIncludes(app.log(), "--allow-ffi");
      assertStringIncludes(app.log(), "allowLocalPeers");
      assert(
        !app.log().includes("launching Electron"),
        `a window was launched for a server that serves no one:\n${app.log()}`,
      );
    } finally {
      await app.stop();
      await dropTempDir(f.dir);
    }
  },
});

Deno.test({
  name:
    "lockdown e2e: beside a named port the socket is still gated, and the log does not claim more",
  ignore: linuxOnly,
  async fn() {
    const f = await fixture();
    const app = boot(f, { args: [`--port=${freePort()}`] });
    try {
      const main = (await app.until(/transport: UDS at (\S+)/))[1]!;
      await app.until(/\[window\] state \{"c":\{"n":1,/);
      assertStringIncludes(app.log(), "covers this app's local socket ONLY");
      assert(
        !app.log().includes("only this app's own window may connect"),
        `the full claim was printed beside an open TCP port:\n${app.log()}`,
      );
      assertEquals(await exchange(main, SESSION_FRAMES, 700), "");
    } finally {
      await app.stop();
      await dropTempDir(f.dir);
    }
  },
});

Deno.test({
  name:
    "lockdown e2e: electron.allowLocalPeers opts out — a companion process gets a session, and the log says so",
  ignore: linuxOnly,
  async fn() {
    const f = await fixture();
    const app = boot(f, { env: { E2E_ALLOW_PEERS: "true" } });
    try {
      const main = (await app.until(/transport: UDS at (\S+)/))[1]!;
      await app.until(/\[window\] state \{"c":\{"n":1,/);
      assertStringIncludes(app.log(), "local-peer lockdown is OFF");
      // The control for the non-dumpable check above: an ungated app is an
      // ordinary process, readable by its user.
      assertEquals(await procReadable(app.pid), true);
      const got = await exchange(main, "", 3000, (g) => g.includes(NOTE));
      assertStringIncludes(got, '"t":"proto"');
      assertStringIncludes(got, NOTE);
    } finally {
      await app.stop();
      await dropTempDir(f.dir);
    }
  },
});

Deno.test({
  name:
    "lockdown e2e: a non-boolean allowLocalPeers does NOT open the doors, and says so",
  ignore: linuxOnly,
  async fn() {
    const f = await fixture();
    // "yes" is truthy. Read by truthiness it turned the lockdown off.
    const app = boot(f, { env: { E2E_ALLOW_PEERS: "yes" } });
    try {
      // Two safe outcomes, and only two: the config is refused at boot, or
      // the app runs GATED and says the value was not understood. (Which one
      // is the config validator's call; that the door stays shut is not.)
      const first = await app.until(
        /transport: UDS at (\S+)|allowLocalPeers[^\n]*(not true or false)/,
      );
      assert(
        !app.log().includes("local-peer lockdown is OFF"),
        `"yes" turned the lockdown off:\n${app.log()}`,
      );
      if (first[1] === undefined) {
        const st = await app.status;
        assert(st.code !== 0, `exit 0 for a refused config:\n${app.log()}`);
        return;
      }
      const main = first[1];
      await app.until(/\[window\] state \{"c":\{"n":1,/);
      const warned = (await app.until(/WARN .*allowLocalPeers is "yes".*/))[0];
      assertStringIncludes(warned, "not a boolean");
      assertEquals(await exchange(main, SESSION_FRAMES, 700), "");
      const http = main.replace(/\.sock$/, ".http.sock");
      assertStringIncludes(
        await exchange(
          http,
          "GET /api/hello HTTP/1.1\r\nHost: x\r\n\r\n",
          1500,
        ),
        "HTTP/1.1 403",
      );
    } finally {
      await app.stop();
      await dropTempDir(f.dir);
    }
  },
});

Deno.test({
  name:
    "lockdown e2e: beside a DevTools port (--cdp) the socket is still gated, and the log does not claim more",
  ignore: linuxOnly,
  async fn() {
    const f = await fixture();
    const cdp = freePort();
    const app = boot(f, { args: [`--cdp=${cdp}`] });
    try {
      const main = (await app.until(/transport: UDS at (\S+)/))[1]!;
      await app.until(/\[window\] state \{"c":\{"n":1,/);
      const warned =
        (await app.until(/WARN .*local-peer lockdown covers.*/))[0];
      assertStringIncludes(warned, `the DevTools port ${cdp}`);
      assert(
        !app.log().includes("only this app's own window may connect"),
        `the full claim was printed beside an open DevTools port:\n${app.log()}`,
      );
      assertEquals(await exchange(main, SESSION_FRAMES, 700), "");
    } finally {
      await app.stop();
      await dropTempDir(f.dir);
    }
  },
});

// ── The stop: the one control request a production app answers ─────────────
//
// Production has no control API, and the lockdown leaves a foreign peer only
// the health check — so `am stop` could end a production app only by a
// signal. On Linux/macOS that is graceful; on Windows it is `TerminateProcess`:
// no `onStop`, no final flush, no clean lock release. The stop now rides on
// the per-boot, owner-only control credential (`<data>/control.key`): with
// it, a clean stop; without it, or with any other value, nothing.

/** This boot's control credential, read where `am` reads it. */
async function controlKey(f: Fixture): Promise<{ key: string; path: string }> {
  const path = join(f.home, "myapp", "data", "control.key");
  const end = Date.now() + 20_000;
  while (Date.now() < end) {
    try {
      const st = await Deno.stat(path);
      assertEquals(st.mode! & 0o077, 0, `${path} is readable by others`);
      return { key: (await Deno.readTextFile(path)).trim(), path };
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`the app never wrote ${path}`);
}

/** One `ctl` frame, as `am` sends it (`trojanOverUds`), and its reply. */
async function ctlOnce(
  sock: string,
  method: string,
  path: string,
  key?: string,
  extra: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  const got = await exchange(
    sock,
    frame("ctl", {
      id: "1",
      method,
      path,
      headers: {
        "X-AIO": "1",
        ...(key ? { "X-Aio-Control": key } : {}),
        ...extra,
      },
      ...(method === "POST" ? { body: "" } : {}),
    }),
    5000,
    (g) => g.includes("\n"),
  );
  const r = JSON.parse(got.split("\n")[0]!) as {
    t: string;
    d: { status: number; body: string };
  };
  assertEquals(r.t, "ctlr", got);
  return r.d;
}

/** The stop ran the app's whole shutdown: exit 0, `onStop`, the stopped
 *  line, and the credential taken back. */
async function assertGracefulStop(
  app: Running,
  keyPath: string,
  by = "am stop",
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const st = await Promise.race([
    app.status,
    new Promise<null>((r) => timer = setTimeout(() => r(null), 20_000)),
  ]).finally(() => clearTimeout(timer));
  assert(st, `the app did not exit within 20 s of the stop:\n${app.log()}`);
  assertEquals(st.code, 0, app.log());
  // The requester the app names — from a whitelist, never the header's text.
  const line =
    (await app.until(/stop requested over the control API \((.*?)\)/))[1];
  assertEquals(line, by);
  await app.until(/\[app\] onStop ran/);
  await app.until(/app\s+stopped\s+uptime=/);
  await assertRejects(() => Deno.stat(keyPath), Deno.errors.NotFound);
}

/** The refusals, against a live app: nothing but the stop, and only with
 *  this boot's credential. Each must leave the app running. */
async function assertStopRefused(
  ask: (method: string, path: string, key?: string) => Promise<{
    status: number;
    body: string;
  }>,
  app: Running,
  key: string,
  stale?: string,
): Promise<void> {
  const STOP = "/__aio/trojan/shutdown";
  const wrong = (key[0] === "0" ? "1" : "0") + key.slice(1);
  const cases: [string, string, string | undefined][] = [
    ["POST", STOP, undefined],
    ["POST", STOP, wrong],
    ["POST", STOP, key.slice(0, -1)],
    ["GET", STOP, key],
    ["POST", "/__aio/trojan/state", key],
    ["GET", "/__aio/trojan/state", key],
    ["POST", "/__aio/trojan/dispatch", key],
    ["POST", "/__aio/trojan/sql", key],
    ...(stale ? [["POST", STOP, stale] as [string, string, string]] : []),
  ];
  const seen: string[] = [];
  for (const [method, path, k] of cases) {
    const r = await ask(method, path, k);
    seen.push(
      `${method} ${path} ${
        k === key ? "key" : k ? "bad" : "none"
      } → ${r.status}`,
    );
    // 404, and only 404: what `am` reads as "a production app", whatever the
    // app's own routes and pages would have said.
    assert(
      r.status === 404,
      `${method} ${path} (${
        k === key ? "this boot's key" : k ? "a wrong key" : "no key"
      }) ` +
        `answered ${r.status}: ${r.body}`,
    );
    assert(!r.body.includes(NOTE), `${method} ${path} leaked state`);
  }
  assertEquals(seen.length, cases.length);
  // A refused stop leaves a trace — which kind, never the value presented.
  await app.until(/refused a stop request .*no control credential/);
  await app.until(/refused a stop request .*wrong control credential/);
  assert(!app.log().includes(wrong), "a refused key was logged");
  await new Promise((r) => setTimeout(r, 300));
  assert(
    !/stop requested over the control API/.test(app.log()),
    `a refused request stopped the app (${seen.join("; ")}):\n${app.log()}`,
  );
}

Deno.test({
  name:
    "lockdown e2e: the stop — with this boot's control credential a clean stop; without it, or with a stale one, nothing",
  ignore: linuxOnly,
  // Under 022, so the owner-only mode checked below is the code's doing.
  fn: () =>
    permissiveUmask(async () => {
      const f = await fixture();
      let app = boot(f);
      try {
        await app.until(/\[window\] state \{"c":\{"n":1,/);
        const main = (await app.until(/transport: UDS at (\S+)/))[1]!;
        const first = await controlKey(f);
        const ask = (m: string, p: string, k?: string) =>
          ctlOnce(main, m, p, k);
        await assertStopRefused(ask, app, first.key);

        // `am stop`: the credential, presented over the lockdown socket. A
        // requester the app does not know is `am stop`, never echoed.
        const ok = await ctlOnce(
          main,
          "POST",
          "/__aio/trojan/shutdown",
          first.key,
          { "X-Aio-Stop-By": "x) INJECTED" },
        );
        assertEquals([ok.status, JSON.parse(ok.body)], [200, {
          ok: true,
          msg: "shutting down",
        }]);
        await assertGracefulStop(app, first.path);
        assert(!app.log().includes("INJECTED"), app.log());
        await app.stop();

        // The next boot mints a new credential; the old one opens nothing.
        app = boot(f);
        await app.until(/\[window\] state \{"c":\{"n":1,/);
        const main2 = (await app.until(/transport: UDS at (\S+)/))[1]!;
        const second = await controlKey(f);
        assert(second.key !== first.key, "a credential is per boot");
        await assertStopRefused(
          (m, p, k) => ctlOnce(main2, m, p, k),
          app,
          second.key,
          first.key,
        );
        // …and the real `am stop`, from another process, finds it all itself:
        // the socket, the credential, the stop — never the signal.
        const am = await new Deno.Command(Deno.execPath(), {
          args: [
            "run",
            "-A",
            `${ROOT}/src/am.ts`,
            "stop",
            "--app=myapp",
            "--json",
          ],
          cwd: f.app,
          env: childEnv({ AIO_APPS_DIR: f.home }),
          stdout: "piped",
          stderr: "piped",
        }).output();
        const said = dec.decode(am.stdout) + dec.decode(am.stderr);
        assertEquals(am.code, 0, said);
        assertEquals(JSON.parse(dec.decode(am.stdout)).how, "graceful", said);
        await assertGracefulStop(app, second.path);
      } finally {
        await app.stop();
        await dropTempDir(f.dir);
      }
    }),
});

Deno.test({
  name:
    "prod stop over TCP: the same credential, the same one request — and nothing else of the control API",
  ignore: linuxOnly,
  // Under 022, so the owner-only mode checked below is the code's doing.
  fn: () =>
    permissiveUmask(async () => {
      const f = await fixture();
      const port = freePort();
      const app = boot(f, {
        client: "--client=server-only",
        args: [`--port=${port}`],
      });
      try {
        await app.until(/running \(prod/); // the key is minted before the port listens
        const { key, path } = await controlKey(f);
        const ask = async (method: string, p: string, k?: string) => {
          const res = await fetch(`http://127.0.0.1:${port}${p}`, {
            method,
            headers: { "X-AIO": "1", ...(k ? { "X-Aio-Control": k } : {}) },
            ...(method === "POST" ? { body: "" } : {}),
          });
          return { status: res.status, body: await res.text() };
        };
        await assertStopRefused(ask, app, key);
        // A takeover says so (what `stopInstance` sends).
        const res = await fetch(
          `http://127.0.0.1:${port}/__aio/trojan/shutdown`,
          {
            method: "POST",
            headers: {
              "X-AIO": "1",
              "X-Aio-Control": key,
              "X-Aio-Stop-By": "takeover",
            },
            body: "",
          },
        );
        assertEquals(res.status, 200, await res.text());
        await assertGracefulStop(app, path, "takeover by a new launch");
      } finally {
        await app.stop();
        await dropTempDir(f.dir);
      }
    }),
});

// ── A REFUSED stop: said in app.log, before the answer; said by `am` ────────
// Measured on Windows: `am stop` with a wrong key got the 404, fell back to
// its signal — TerminateProcess there — and app.log ended at "running": the
// refusal line was still in the logger's buffer when the process was killed.

/** The app's own log file, as an operator reads it. */
const appLog = (f: Fixture) =>
  Deno.readTextFileSync(join(f.home, "myapp", "logs", "app.log"));

// ONE place decides and logs a refused stop — the server's stop branch; the
// lockdown door only lets `POST /__aio/trojan/shutdown` through to it — on
// every transport, for a wrong key and for none. The reply says so, and the
// line is on disk before the reply leaves.
for (const wire of ["lockdown socket", "TCP"] as const) {
  for (const presented of ["wrong", "none"] as const) {
    Deno.test({
      name:
        `refused stop (${wire}, ${presented} key): the line is in app.log BEFORE the answer — a kill right after cannot lose it`,
      ignore: linuxOnly,
      // Under 022 like the other stop tests: controlKey() checks the mode.
      fn: () =>
        permissiveUmask(async () => {
          const f = await fixture();
          const port = freePort();
          const app = wire === "TCP"
            ? boot(f, {
              client: "--client=server-only",
              args: [`--port=${port}`],
            })
            : boot(f);
          try {
            // The key is minted before the port listens: wait for the banner.
            await app.until(/running \(prod/);
            const { key } = await controlKey(f);
            const wrong = (key[0] === "0" ? "1" : "0") + key.slice(1);
            const k = presented === "wrong" ? wrong : undefined;
            let r: { status: number; body: string };
            if (wire === "TCP") {
              const res = await fetch(
                `http://127.0.0.1:${port}/__aio/trojan/shutdown`,
                {
                  method: "POST",
                  headers: {
                    "X-AIO": "1",
                    ...(k ? { "X-Aio-Control": k } : {}),
                  },
                  body: "",
                },
              );
              r = { status: res.status, body: await res.text() };
            } else {
              await app.until(/\[window\] state \{"c":\{"n":1,/);
              const main = (await app.until(/transport: UDS at (\S+)/))[1]!;
              r = await ctlOnce(main, "POST", "/__aio/trojan/shutdown", k);
            }
            assertEquals(r.status, 404, r.body);
            // The reply SAYS it refused — what `am` reads (`STOP_REFUSED`).
            assertStringIncludes(JSON.parse(r.body).error, "stop refused");
            // What TerminateProcess does: no shutdown, no flush.
            Deno.kill(app.pid, "SIGKILL");
            await app.status;
            const log = appLog(f);
            assertStringIncludes(log, "refused a stop request");
            assertStringIncludes(
              log,
              presented === "wrong"
                ? "wrong control credential"
                : "no control credential",
            );
            assert(!log.includes(wrong), "the presented key was logged");
          } finally {
            await app.stop();
            await dropTempDir(f.dir);
          }
        }),
    });
  }
}

Deno.test({
  name:
    "refused stop: `am stop` says the app refused its credential and how the app ended — never silently",
  ignore: linuxOnly,
  // Under 022 like the other stop tests: controlKey() checks the mode.
  fn: () =>
    permissiveUmask(async () => {
      const f = await fixture();
      const app = boot(f);
      try {
        await app.until(/\[window\] state \{"c":\{"n":1,/);
        const { key, path } = await controlKey(f);
        // A stale key on disk: what a hand edit, or a copy from another boot,
        // leaves. (Rewritten in place: the file keeps its owner-only mode.)
        Deno.writeTextFileSync(
          path,
          (key[0] === "0" ? "1" : "0") + key.slice(1),
        );
        const am = await new Deno.Command(Deno.execPath(), {
          args: [
            "run",
            "-A",
            `${ROOT}/src/am.ts`,
            "stop",
            "--app=myapp",
            "--json",
          ],
          cwd: f.app,
          env: childEnv({ AIO_APPS_DIR: f.home }),
          stdout: "piped",
          stderr: "piped",
        }).output();
        const out = dec.decode(am.stdout), err = dec.decode(am.stderr);
        assertEquals(am.code, 0, out + err);
        assertStringIncludes(err, "the app refused the stop credential");
        assertStringIncludes(err, "is missing or does not match this boot");
        assertStringIncludes(err, "ending it without a clean shutdown");
        // A signal here (Linux); `killed` on Windows, where it is one.
        assertEquals(JSON.parse(out).how, "signal", out);
        await app.status;
        assertStringIncludes(appLog(f), "wrong control credential");
      } finally {
        await app.stop();
        await dropTempDir(f.dir);
      }
    }),
});
