// `am` against an app that runs on a Unix socket and NOTHING else.
//
// A packaged Electron app binds zero TCP ports by default (alpha66) — the
// window speaks the app's socket, the control plane answers on the same
// socket. That is the SHIPPED shape, and a field report (#9) found `am` unable
// to reach it: `am instances` listed the app as running (`transport: "uds"`)
// while, in the same breath, `am surface --app=<id>` refused with
//
//   am does not know which app to target: no app named "<id>" is running and
//   none declares a port … 4 apps are running: <id> @ uds
//
// One fact, two readers: `am instances` scans every lock file; every other
// command read ONE lock, keyed by the home `am` computed for the id — and an
// app booted from its own `appDir` (a desktop app's normal shape) writes its
// lock as `<id>@<hash8(home)>`, which that key never matches. The sentence was
// false, and the real constraint (none — the socket carries the control
// plane) was never the problem.
//
// The fix is one decider: `controlEndpoint(appId, port)` in am-http.ts, fed
// by `liveLock` (the lock wherever the instance's home is). Every trojan-backed
// command routes through it. These tests pin it end to end — a REAL `aio.run`
// with a REAL UI client connected over the socket — and unit-pin the decider
// so a revert is red without spawning anything.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import { controlEndpoint, trojanGet } from "../src/am/am-http.ts";
import {
  _resetHomePin,
  liveLock,
  resolvePort,
  targetHome,
} from "../src/am/am-utils.ts";
import {
  descendantPids,
  lockKey,
  removeLock,
  writeLock,
} from "../src/server/single-instance-lock.ts";
import { appHome } from "../src/server/app-dirs.ts";

const REPO = dirname(dirname(fromFileUrl(import.meta.url)));
const DENO_JSON = join(REPO, "deno.json");

type Node = {
  name?: string;
  component?: string;
  path?: string;
  text?: string;
  elements?: Node[];
  children?: Node[];
};
/** Depth-first: the first component or element named `name` in a surface. */
function findNamed(nodes: Node[], name: string): Node | undefined {
  for (const n of nodes) {
    if (n.name === name || n.component === name) return n;
    const hit = findNamed([...(n.elements ?? []), ...(n.children ?? [])], name);
    if (hit) return hit;
  }
  return undefined;
}

Deno.test({
  name:
    "am over UDS: surface, trigger, state, dispatch reach a zero-port app booted from its own appDir",
  // Windows: a local aio app listens on a NAMED PIPE, and the window stand-in
  // (tests/fixtures/uds-window-standin.tsx) connects with `Deno.connect({
  // transport: "unix" })` — it has no named-pipe variant yet (that needs the
  // `local-listen.ts` seam). The DECIDER is covered on windows by the unit
  // tests below; this end-to-end case is not.
  ignore: Deno.build.os === "windows",
  async fn() {
    const dir = await Deno.makeTempDir({ prefix: "aio-am-uds-" });
    const apps = join(dir, "apps"); // AIO_APPS_DIR — isolates lock dir + homes
    const home = join(dir, "home"); // the app's OWN appDir: a non-default home
    const appId = `uds-${crypto.randomUUID().slice(0, 8)}`;
    await Deno.mkdir(apps);
    await Deno.writeTextFile(
      join(dir, "app.ts"),
      `import { aio, cell } from "${REPO}/mod.ts";
const c = cell("c", { state: { n: 1 }, visible: "all", methods: {
  inc(s: { n: number }) { s.n++; },
} });
await aio.run({
  cells: [c], appId: ${JSON.stringify(appId)},
  persist: false, appDir: ${JSON.stringify(home)},
});
await new Promise(() => {});
`,
    );
    await Deno.writeTextFile(
      join(dir, "App.tsx"),
      `export default function App() { return <div>Hello</div>; }\n`,
    );
    // The "Electron binary": our window stand-in (see the fixture).
    const electron = join(dir, "electron");
    await Deno.writeTextFile(
      electron,
      `#!/bin/sh\nexec "${Deno.execPath()}" run -A --config "${DENO_JSON}" ` +
        `"${join(REPO, "tests/fixtures/uds-window-standin.tsx")}" "$@"\n`,
    );
    await Deno.chmod(electron, 0o755);

    const env = {
      ...Deno.env.toObject(),
      AIO_APPS_DIR: apps,
      ELECTRON_PATH: electron,
    };
    const child = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        "--config",
        DENO_JSON,
        join(dir, "app.ts"),
        "--client=electron",
      ],
      cwd: dir,
      env,
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    // Drain so the child never blocks on a full pipe; keep the tail for
    // failure messages.
    let log = "";
    const drain = (s: ReadableStream<Uint8Array>) =>
      s.pipeTo(
        new WritableStream({
          write: (c) => {
            log = (log + new TextDecoder().decode(c)).slice(-8000);
          },
        }),
      ).catch(() => {});
    const drained = Promise.all([drain(child.stdout), drain(child.stderr)]);

    const am = async (...args: string[]) => {
      const r = await new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "-A",
          "--config",
          DENO_JSON,
          join(REPO, "src/am.ts"),
          ...args,
          `--app=${appId}`,
          "--json",
        ],
        cwd: REPO, // a FOREIGN cwd: nothing about the app is inferable here
        env: { ...env, ELECTRON_PATH: "" },
        stdout: "piped",
        stderr: "piped",
      }).output();
      const stdout = new TextDecoder().decode(r.stdout).trim();
      const stderr = new TextDecoder().decode(r.stderr).trim();
      let json: unknown = null;
      try {
        json = JSON.parse(stdout);
      } catch { /* not JSON — the assertion below names it */ }
      return { code: r.code, stdout, stderr, json };
    };
    const until = async <T>(
      what: string,
      probe: () => Promise<T | undefined>,
      ms = 90_000,
    ): Promise<T> => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        const v = await probe();
        if (v !== undefined) return v;
        await new Promise((r) => setTimeout(r, 300));
      }
      throw new Error(
        `${what} did not happen within ${ms}ms; app log:\n${log}`,
      );
    };

    try {
      // ── the shipped shape: a lock with a socket and port 0, keyed by home ──
      const inst = await until("the app's lock", async () => {
        const r = await am("instances");
        const rows = Array.isArray(r.json)
          ? r.json as Record<string, unknown>[]
          : [];
        return rows.find((i) => i.appId === appId && i.status === "started");
      });
      assertEquals(inst.transport, "uds");
      assertEquals(
        inst.port,
        0,
        "zero TCP ports — the default for a local electron app",
      );
      assertEquals(inst.home, home, "the lock is keyed by the app's own home");

      // ── every control-plane command, through the socket ──
      const state = await am("state");
      assertEquals(state.code, 0, `am state: ${state.stdout} ${state.stderr}`);
      assertEquals(state.json, { c: { n: 1 } });

      const clients = await until(
        "the window stand-in on the roster",
        async () => {
          const r = await am("clients");
          const rows = Array.isArray(r.json)
            ? r.json as Record<string, unknown>[]
            : [];
          return rows.length ? rows : undefined;
        },
      );
      assertEquals(clients[0]!.transport, "uds");

      const surface = await am("surface");
      assertEquals(
        surface.code,
        0,
        `am surface: ${surface.stdout} ${surface.stderr}`,
      );
      const inc = findNamed(surface.json as Node[], "IncButton");
      assert(inc?.path, `IncButton not on the surface: ${surface.stdout}`);
      assertEquals(findNamed(surface.json as Node[], "Counter")?.text, "0Inc");

      const trig = await am("trigger", inc.path, "click");
      assertEquals(trig.code, 0, `am trigger: ${trig.stdout} ${trig.stderr}`);
      assertEquals((trig.json as { ok?: boolean }).ok, true);
      const after = await am("surface");
      assertEquals(
        findNamed(after.json as Node[], "Counter")?.text,
        "1Inc",
        "the click drove the live window",
      );

      // `am status` disagreed with `am clients` about THIS app.
      //
      // Second field report (cc, an Electron app over UDS), reproduced by its
      // author: `am clients` listed one live electron/uds client while
      // `am status` printed `connections: 0` in the same breath. Two trojan
      // routes, twenty lines apart, one running app, two answers — and nothing
      // tells the operator which is lying. `clients` already merged both
      // transports; `metrics`, which `am status` reads, counted WS only.
      //
      // Asserted HERE because this is the one test with a real UDS client
      // attached: a unit test of the sum would have passed all along.
      const metrics = await am("metrics");
      assertEquals(
        (metrics.json as { connections?: number }).connections,
        clients.length,
        `am status must agree with am clients about the same app: ` +
          `${metrics.stdout}`,
      );

      const disp = await am("dispatch", "c:inc");
      assertEquals(disp.code, 0, `am dispatch: ${disp.stdout} ${disp.stderr}`);
      assertEquals((await am("state", "c.n")).json, 2);

      for (const cmd of [["metrics"], ["errors"], ["timeline"], ["health"]]) {
        const r = await am(...cmd);
        assert(
          r.json !== null &&
            !("error" in (r.json as object) &&
              /not running|does not know/.test(
                String((r.json as { error?: string }).error),
              )),
          `am ${cmd.join(" ")} over UDS: ${r.stdout} ${r.stderr}`,
        );
      }

      // ── the process commands read the SAME fact as `am instances` ──
      // `am status` must never call an app "stopped" that `am instances`
      // lists, and `am start` must never start it a second time: both read
      // the lock keyed by a home `am` never computed for the id.
      const status = await am("status");
      assertEquals(
        status.code,
        0,
        `am status: ${status.stdout} ${status.stderr}`,
      );
      assertEquals((status.json as { status?: string }).status, "started");
      const again = await am("start");
      assert(again.code !== 0, `am start double-started: ${again.stdout}`);
      assertStringIncludes(again.stdout + again.stderr, "already");

      // ── the false sentence is gone from every reply ──
      for (const r of [state, surface, trig, disp, status]) {
        assert(
          !/no app named|stopped/.test(r.stdout + r.stderr),
          `an app that IS running must never be reported as not running: ${r.stdout} ${r.stderr}`,
        );
      }

      // ── and `am stop` stops THAT instance ──
      const stop = await am("stop", "--wait");
      assertEquals(stop.code, 0, `am stop: ${stop.stdout} ${stop.stderr}`);
      await until(
        "the app to exit",
        async () =>
          (await am("instances")).json instanceof Array &&
            !((await am("instances")).json as { appId: string }[]).some((i) =>
              i.appId === appId
            )
            ? true
            : undefined,
      );
      assertEquals(
        (await am("status")).json,
        { appId, status: "stopped", running: [] },
      );
    } finally {
      // The window stand-in is the app's child. Collected BEFORE the kill —
      // once the parent dies its children are reparented and can no longer be
      // found from it — and killed by pid, never by pattern: a `pkill -f` on
      // the fixture's name matched every shell whose command line mentioned
      // the file (measured: it killed the terminal running this test).
      const kids = await descendantPids(child.pid);
      try {
        child.kill("SIGTERM");
      } catch { /* already gone */ }
      const exited = await Promise.race([
        child.status.then(() => true),
        new Promise<false>((r) => setTimeout(() => r(false), 15_000)),
      ]);
      if (!exited) {
        try {
          child.kill("SIGKILL");
        } catch { /* gone */ }
        await child.status;
      }
      await drained;
      for (const pid of kids) {
        try {
          Deno.kill(pid, "SIGKILL");
        } catch { /* the graceful stop already closed it */ }
      }
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

// ── The decider, unit-pinned (red on revert without spawning anything) ──────

/** An isolated lock dir + a lock the way a zero-port app writes it, from a
 *  home `am` would never compute for the id. */
async function foreignHomeLock(opts: { socketPath?: string; port: number }) {
  const apps = await Deno.makeTempDir({ prefix: "aio-am-ep-" });
  const prev = Deno.env.get("AIO_APPS_DIR");
  Deno.env.set("AIO_APPS_DIR", apps);
  const appId = `ep-${crypto.randomUUID().slice(0, 8)}`;
  const home = join(apps, "elsewhere", appId);
  assert(home !== appHome(appId), "the fixture must be a NON-default home");
  const lock = {
    appId,
    pid: Deno.pid,
    port: opts.port,
    startedAt: Date.now(),
    status: "started" as const,
    cwd: apps,
    home,
    ...(opts.socketPath ? { socketPath: opts.socketPath } : {}),
  };
  writeLock(lock);
  return {
    appId,
    home,
    lock,
    [Symbol.asyncDispose]: async () => {
      removeLock(lockKey(appId, home));
      _resetHomePin();
      if (prev === undefined) Deno.env.delete("AIO_APPS_DIR");
      else Deno.env.set("AIO_APPS_DIR", prev);
      await Deno.remove(apps, { recursive: true }).catch(() => {});
    },
  };
}

Deno.test("controlEndpoint: a UDS app booted from its own home resolves to its socket", async () => {
  await using f = await foreignHomeLock({
    socketPath: "/nowhere/app.sock",
    port: 0,
  });
  const ep = controlEndpoint(f.appId, 0);
  assertEquals(ep, {
    kind: "uds",
    socketPath: "/nowhere/app.sock",
    pid: Deno.pid,
    port: 0,
  });
  // …and `resolvePort` — what every command calls first — no longer refuses
  // an app that is running. `explicit: true` is the `--app=<id>` shape from
  // the report: no discovery fallback, only the lock itself.
  assertEquals(resolvePort(undefined, f.appId, { explicit: true }), 0);
});

Deno.test("controlEndpoint: no socket in the lock is a TCP endpoint", async () => {
  await using f = await foreignHomeLock({ port: 4711 });
  assertEquals(controlEndpoint(f.appId, 4711), { kind: "tcp", port: 4711 });
});

Deno.test("controlEndpoint: `--home` pins the instance — it never widens to another home", async () => {
  await using f = await foreignHomeLock({
    socketPath: "/nowhere/app.sock",
    port: 0,
  });
  // Pin a DIFFERENT home than the one running. `am --home=X` means X's
  // instance; answering with the running one would be a silent retarget.
  targetHome(f.appId, join(f.home, "..", "another"));
  assertEquals(liveLock(f.appId), null);
});

Deno.test("resolvePort: the refusal never names an app as running in the sentence that says it is not", async () => {
  await using f = await foreignHomeLock({
    socketPath: "/nowhere/app.sock",
    port: 0,
  });
  // A genuinely absent id, while f's app IS running on UDS: the message may
  // list f, and may say the absent id is not running — never both about ONE
  // id. (Before: `no app named "X" is running … 1 app is running: X @ uds`.)
  const absent = `absent-${crypto.randomUUID().slice(0, 8)}`;
  let msg = "";
  try {
    resolvePort(undefined, absent, { explicit: true });
  } catch (e) {
    msg = String(e);
  }
  assertStringIncludes(msg, `no app named "${absent}"`);
  assertStringIncludes(msg, `${f.appId} @ uds`);
  const named = /no app named "([^"]+)" is running/.exec(msg)?.[1];
  assert(named && !msg.includes(`${named} @ `), `false sentence: ${msg}`);
});

Deno.test("trojanGet: a zero-port app whose socket does not answer is named as such — never 'not running on port 0'", async () => {
  await using f = await foreignHomeLock({
    socketPath: join(await Deno.makeTempDir(), "gone.sock"),
    port: 0,
  });
  const r = await trojanGet(0, "state", f.appId, 300);
  assert(!r.ok);
  assertStringIncludes(r.error, "running on a UDS socket with no TCP port");
  assertStringIncludes(r.error, "did not answer");
  assert(!/not running/.test(r.error), r.error);
});
