// What a second launch of a desktop app does, for each state of the instance
// that holds the lock — and that what it says is true.
//
// The loser of two simultaneous double-clicks met a holder that was still
// STARTING. The quiet path ("brought its window to the front", exit 0) needed
// a holder that was up, so the loser exited 1 with
// `Already running: <app> at http://localhost:<port>` — the lock's CONFIGURED
// port, where nothing listened yet and, for a desktop app on its local socket,
// nothing ever would.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  _alreadyRunningMessage,
  askRunningToShow,
  showWaitMs,
} from "../src/server/aio-run-helpers.ts";
import { STARTUP_GRACE_MS } from "../src/server/single-instance-lock.ts";
import { childEnv } from "./e2e-app-harness.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const REPO = join(import.meta.dirname!, "..");
const NOW = 1_000_000;
const holder = (o: Record<string, unknown> = {}) => ({
  client: "electron",
  status: "started" as "starting" | "started" | "stopping",
  startedAt: NOW,
  ...o,
});
const wait = (
  theirs: Record<string, unknown>,
  o: Record<string, unknown> = {},
) =>
  showWaitMs({
    mine: "electron",
    theirs: holder(theirs),
    takeover: false,
    now: NOW,
    ...o,
  });

Deno.test("second launch: which holders are asked to show, and for how long", () => {
  // Up long ago: the window is there — 3 s.
  assertEquals(
    wait({ status: "started", startedAt: NOW - 10 * STARTUP_GRACE_MS }),
    3000,
  );
  // `started` is the server: a young one's window may still be loading —
  // it gets the rest of the grace, like a starting one.
  assertEquals(
    wait({ status: "started", startedAt: NOW - 4000 }),
    3000 + STARTUP_GRACE_MS - 4000,
  );
  // Starting: what is left of its startup grace, plus the window's 3 s.
  assertEquals(wait({ status: "starting" }), 3000 + STARTUP_GRACE_MS);
  assertEquals(
    wait({ status: "starting", startedAt: NOW - 4000 }),
    3000 + STARTUP_GRACE_MS - 4000,
  );
  assertEquals(
    wait({ status: "starting", startedAt: NOW - 10 * STARTUP_GRACE_MS }),
    3000,
  );
  // A skewed clock (a start "in the future") cannot stretch the wait.
  assertEquals(
    wait({ status: "starting", startedAt: NOW + 3_600_000 }),
    3000 + STARTUP_GRACE_MS,
  );
  // Not asked: a window that is closing, a non-window on either side, a
  // takeover, a maintenance hold.
  assertEquals(wait({ status: "stopping" }), null);
  assertEquals(wait({ client: "browser" }), null);
  assertEquals(wait({}, { mine: "browser" }), null);
  assertEquals(wait({}, { mine: undefined }), null);
  assertEquals(wait({}, { takeover: true }), null);
  assertEquals(wait({ status: "starting", maintenance: { op: "x" } }), null);
});

const said = (o: Record<string, unknown>) =>
  _alreadyRunningMessage({
    appId: "notes",
    port: 54879,
    pid: 2068,
    home: "/h/notes",
    takeover: false,
    ...o,
  });

// Measured on Windows: a double-click while a dead app's lock file was held
// open (share None) said "Already running: <app> (home …)" with no pid — and
// the app was up 0.4 s later. "Already running" is said with a LIVE pid only.
Deno.test("second launch: a holder that cannot be read is never 'Already running'", () => {
  const m = said({ pid: 0, port: 0 });
  assert(!m.includes("Already running"), m);
  assertStringIncludes(m, "lock file cannot be read yet");
  assertStringIncludes(m, "/h/notes");
  assertStringIncludes(said({ pid: 2068 }), "Already running");
});

Deno.test("second launch: the refusal names a URL only when one is served", () => {
  // Starting: the lock's port is the configured one — no URL.
  const starting = said({ status: "starting" });
  assert(!starting.includes("http://"), starting);
  assertStringIncludes(
    starting,
    "Already running: notes (pid 2068, still starting)",
  );
  // Up, with a TCP listener: the URL.
  assertStringIncludes(
    said({ status: "started" }),
    "Already running: notes at http://localhost:54879 (pid 2068)",
  );
  // Up, on the local socket only (port 0): no URL.
  const socketOnly = said({ status: "started", port: 0 });
  assert(!socketOnly.includes("http://"), socketOnly);
  assertStringIncludes(socketOnly, "Already running: notes (pid 2068)");
  // A caller that knows no status is told what it always was.
  assertStringIncludes(said({}), "notes at http://localhost:54879 (pid 2068)");
  // Was starting, and went away while this launch waited for it.
  const gone = said({ status: "starting", gone: true });
  assert(!gone.includes("Already running"), gone);
  assertStringIncludes(gone, "notes was starting (pid 2068) and exited");
});

Deno.test("askRunningToShow: a holder that goes away ends the wait at once", async () => {
  const dir = await tempDir("show-gone-");
  try {
    const f = join(dir, "x.show");
    let asked = 0;
    // Alive for two looks, then gone — long before the 60 s it was given.
    const answer = await askRunningToShow(f, 60_000, () => ++asked <= 2);
    assertEquals(answer, false);
    assertEquals(asked, 3);
    let left = true;
    try {
      Deno.statSync(f);
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
      left = false;
    }
    assertEquals(left, false, "the request must be withdrawn");
  } finally {
    await dropTempDir(dir);
  }
});

// ── real processes: the launch that meets a STARTING desktop holder ──
//
// The entry plants the holder's lock (a live `sleep`, status "starting", the
// configured port) and stands in for its window: once the show request
// appears it takes it (the window opened), ends the holder (the first launch
// died while starting), does nothing (a holder stuck starting), or comes up
// late — marks itself started, with a listener, and takes the NEXT request.
//
// "opens" goes through `aio.run()`: the launch ends before anything boots.
// The others ask for the lock directly — a launch that WINS it would go on to
// open a window, which a test must not.
const APP = `import { aio, cell } from "aio";
import { join } from "@std/path";
import { lockDir, writeLock } from "aio/server/single-instance-lock.ts";
import { acquireSingletonLock } from "aio/server/aio-run-helpers.ts";
const appId = Deno.env.get("APP_ID")!;
const how = Deno.env.get("HOLDER")!;
const holder = new Deno.Command("sleep", { args: ["120"], stdin: "null",
  stdout: "null", stderr: "null" }).spawn();
const lock = (o: Record<string, unknown>) =>
  writeLock({ appId, pid: holder.pid, port: 54879, startedAt: Date.now(),
    status: "starting", client: "electron", cwd: "/", ...o } as never);
// "stuck" and "late": past the startup grace, nothing to probe (port 0) — the
// wait is the window's 3 s, not 13.
lock(how === "stuck" || how === "late"
  ? { port: 0, startedAt: Date.now() - 60_000 }
  // "up-dies": the SERVER is up (\`started\`), its window still loading —
  // it never takes the request, and dies before it would have.
  : how === "up-dies" ? { status: "started" } : {});
if (how === "up-dies") setTimeout(() => holder.kill("SIGKILL"), 800);
let listener: Deno.Listener | undefined;
let upAt = 0;
// Every request this launch made, by the time it was written.
const requests = new Set<number>();
const window = setInterval(() => {
  for (const e of Deno.readDirSync(lockDir())) {
    if (!e.name.endsWith(".show")) continue;
    requests.add(Deno.statSync(join(lockDir(), e.name)).mtime!.getTime());
    if (how === "opens" || how === "takes-dies") {
      Deno.removeSync(join(lockDir(), e.name));
      // The window took it; then the instance comes up — or dies first.
      if (how === "opens") lock({ status: "started" });
      else setTimeout(() => holder.kill("SIGKILL"), 300);
    }
    else if (how === "dies") holder.kill("SIGKILL");
    else if (how === "late") {
      if (!listener) {
        // Up at last — but this request came before its window watched.
        listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
        lock({ status: "started",
          port: (listener.addr as Deno.NetAddr).port });
        upAt = Date.now();
      } else {
        // Only a request written AFTER it came up: the first one stays.
        const at = Deno.statSync(join(lockDir(), e.name)).mtime!.getTime();
        if (at > upAt) Deno.removeSync(join(lockDir(), e.name));
      }
    }
    if (how === "opens" || how === "dies" || how === "takes-dies") {
      clearInterval(window);
    }
  }
}, 10);
addEventListener("unload", () => {
  console.log("REQUESTS " + requests.size);
  try { holder.kill("SIGKILL"); } catch { /* aio-ok: ended above */ }
});
if (how === "opens") {
  const c = cell("c", { state: { v: 0 }, methods: {} });
  await aio.run({ appId, cells: [c], client: "electron" });
  console.log("BOOTED");
} else {
  const t0 = performance.now();
  const got = await acquireSingletonLock(appId, undefined, 0, true, false,
    { client: "electron" });
  console.log("LOCK WON after " + Math.round(performance.now() - t0) + " ms");
  got?.release();
  clearInterval(window);
  listener?.close();
  Deno.exit(0);
}
`;

async function secondLaunch(
  how: "opens" | "dies" | "stuck" | "late" | "takes-dies" | "up-dies",
): Promise<{ code: number; out: string; logs: string[] }> {
  const dir = await tempDir("second-launch-");
  try {
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({
        imports: {
          "aio": `${REPO}/mod.ts`,
          "aio/": `${REPO}/src/`,
          "immer": "npm:immer@10.2.0",
          "@std/path": "jsr:@std/path@1.1.2",
        },
      }),
    );
    await Deno.writeTextFile(join(dir, "app.ts"), APP);
    const r = await new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", join(dir, "app.ts")],
      cwd: dir,
      env: childEnv({
        AIO_APPS_DIR: join(dir, "apps"),
        APP_ID: `second-launch-${how}-${Deno.pid}`,
        HOLDER: how,
        // Never reached: the launch is refused before any window. Named so a
        // regression that boots cannot open one on this display.
        ELECTRON_PATH: "/bin/false",
      }),
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
      signal: AbortSignal.timeout(60_000),
    }).output();
    const dec = new TextDecoder();
    // Every log file the launch left in the app's home.
    const logs: string[] = [];
    const walk = (d: string) => {
      for (const e of Deno.readDirSync(d)) {
        if (e.isDirectory) walk(join(d, e.name));
        else if (/\.log(\.\d+)?$/.test(e.name)) logs.push(e.name);
      }
    };
    try {
      walk(join(dir, "apps"));
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
    }
    return {
      code: r.code,
      out: dec.decode(r.stdout) + dec.decode(r.stderr),
      logs,
    };
  } finally {
    await dropTempDir(dir);
  }
}

const WAITING = /is starting \(pid \d+\) — waiting for its window…/;
const lineOf = (out: string, re: RegExp | string) =>
  out.split("\n").findIndex((l) =>
    typeof re === "string" ? l.includes(re) : re.test(l)
  );

Deno.test({
  name:
    "second launch, holder still starting: says it is waiting, its window takes the request — exit 0",
  ignore: Deno.build.os === "windows", // `sleep` stands in for the holder
  async fn() {
    const r = await secondLaunch("opens");
    assertEquals(r.code, 0, r.out);
    const said = lineOf(r.out, WAITING);
    const front = lineOf(r.out, "brought its window to the front");
    assert(said >= 0 && front > said, r.out);
    assert(!r.out.includes("http://localhost:54879"), r.out);
    assert(!r.out.includes("BOOTED"), r.out);
    // Handed over: nothing written into the running app's home.
    assertEquals(r.logs, [], "no log file");
  },
});

// It exited 1 with "was starting and exited — start it again": the lock of a
// dead holder is exactly what a launch reclaims, so this one starts instead.
Deno.test({
  name:
    "second launch, holder dies while starting: its lock is reclaimed and this launch starts",
  ignore: Deno.build.os === "windows", // `sleep` stands in for the holder
  async fn() {
    const r = await secondLaunch("dies");
    assertEquals(r.code, 0, r.out);
    assert(lineOf(r.out, WAITING) >= 0, r.out);
    assertStringIncludes(r.out, "LOCK WON");
    assert(!r.out.includes("Already running"), r.out);
    assert(!r.out.includes("start it again"), r.out);
  },
});

Deno.test({
  name:
    "second launch, holder alive and stuck starting: one wait, said once, then the refusal a fresh launch gets — exit 1",
  ignore: Deno.build.os === "windows", // `sleep` stands in for the holder
  async fn() {
    const r = await secondLaunch("stuck");
    assertEquals(r.code, 1, r.out);
    assertEquals(
      r.out.split("\n").filter((l) => WAITING.test(l)).length,
      1,
      r.out,
    );
    assertStringIncludes(r.out, "Already running: ");
    assertStringIncludes(r.out, "still starting)");
    assert(!r.out.includes("LOCK WON"), r.out);
    // ONE request: it is not asked again after the second look.
    assertStringIncludes(r.out, "REQUESTS 1\n");
  },
});

Deno.test({
  name:
    "second launch, holder came up during the wait without taking the request: asked again as a running app — exit 0",
  ignore: Deno.build.os === "windows", // `sleep` stands in for the holder
  async fn() {
    const r = await secondLaunch("late");
    assertEquals(r.code, 0, r.out);
    assert(lineOf(r.out, WAITING) >= 0, r.out);
    assertStringIncludes(r.out, "brought its window to the front");
    assertStringIncludes(r.out, "REQUESTS 2\n");
    assert(!r.out.includes("LOCK WON"), r.out);
    assert(!r.out.includes("Already running"), r.out);
  },
});

// Measured on Windows: the first launch's window took the request at
// +290 ms — the second ended "brought its window to the front" — and the
// first was killed at +760 ms, still starting: no app, no window.
Deno.test({
  name:
    "second launch, holder takes the request while starting and then dies: this launch does not end on it — it starts",
  ignore: Deno.build.os === "windows", // `sleep` stands in for the holder
  async fn() {
    const r = await secondLaunch("takes-dies");
    assertEquals(r.code, 0, r.out);
    assertStringIncludes(r.out, "LOCK WON");
    assert(!r.out.includes("brought its window to the front"), r.out);
    assert(!r.out.includes("Already running"), r.out);
  },
});

// Measured on Windows (run 4): the second launch exited 0 at +255 ms on a
// first instance whose record said `started` — its server — two seconds
// before its window existed; the first was then killed: no app at all.
Deno.test({
  name:
    "second launch, holder's server is up but its window never takes the request, and it dies: this launch starts",
  ignore: Deno.build.os === "windows", // `sleep` stands in for the holder
  async fn() {
    const r = await secondLaunch("up-dies");
    assertEquals(r.code, 0, r.out);
    assertStringIncludes(r.out, "LOCK WON");
    assert(!r.out.includes("brought its window to the front"), r.out);
    assert(!r.out.includes("Already running"), r.out);
  },
});
