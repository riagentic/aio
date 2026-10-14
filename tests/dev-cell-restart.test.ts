// Dev auto-restart on a cell edit, proven against a real
// process: cells run in the server process, so an edited cell used to keep its
// old logic while the browser showed new UI. Now the app restarts itself.
//
// The e2e case boots a scaffolded app, rewrites its cell, and asserts the
// SERVED STATE changes — i.e. the new cell code is really running — with the
// port still bound afterwards (the supervisor handed it to a fresh child).
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import {
  carriedPort,
  isSupervisedChild,
  relaunchArgs,
  RESTART_EXIT_CODE,
  RESTART_PORT_ENV,
  restartBlockedReason,
  restartForCellChange,
  supervisorEnv,
} from "../src/server/dev-restart.ts";
import { instances } from "../src/server/single-instance-lock.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { childEnv } from "./e2e-app-harness.ts";
import { spec } from "./module-spec-helper.ts";

/** `childEnv()` without `AIO_PARENT_PID`.
 *
 *  The sandbox half is load-bearing here in BOTH directions: it pins the app's
 *  home away from `~/.<appId>` (check:home-clean fails a release for one such
 *  directory) and it points THIS process at the same `AIO_APPS_DIR`, which is
 *  how `livePortOf` finds the lock of the app it just spawned.
 *
 *  What must not come with it is `AIO_PARENT_PID`: these cases are about the
 *  supervisor the app starts for itself, and a pid pinned from outside is the
 *  variable under test answered in advance. */
function devChildEnv(): Record<string, string> {
  const env = childEnv();
  delete env.AIO_PARENT_PID;
  return env;
}

Deno.test("dev-restart: refuses to restart what it cannot faithfully relaunch", async () => {
  // This test process runs with -A, so nothing blocks it…
  assertEquals(await restartBlockedReason(), null);
  // …unless the developer opted out.
  Deno.env.set("AIO_NO_DEV_RESTART", "1");
  try {
    assertEquals(await restartBlockedReason(), "AIO_NO_DEV_RESTART=1");
  } finally {
    Deno.env.delete("AIO_NO_DEV_RESTART");
  }
});

Deno.test("dev-restart: an opted-out app warns and keeps running", async () => {
  // The fallback must never kill the process — a dev session continues exactly
  // as it did before auto-restart existed.
  Deno.env.set("AIO_NO_DEV_RESTART", "1");
  let closed = false;
  try {
    await restartForCellChange("/tmp/cart.ts", () => {
      closed = true;
      return Promise.resolve();
    });
  } finally {
    Deno.env.delete("AIO_NO_DEV_RESTART");
  }
  assertEquals(closed, false, "a blocked restart must not tear the app down");
});

Deno.test("dev-restart: the supervised child is told the port the app was on", () => {
  // An app that named no port got a free one — and, before this, a DIFFERENT
  // free one after every cell edit, orphaning every open tab. The bound port
  // rides the environment in a variable of its own, so the relaunch binds the
  // same port. No TCP port (zero-port electron) carries nothing: the relaunch
  // must not grow a listener.
  const env = supervisorEnv(4242, 51234);
  assertEquals(env[RESTART_PORT_ENV], "51234");
  assertEquals(RESTART_PORT_ENV, "AIO_DEV_RESTART_PORT");
  assertEquals(env.AIO_DEV_SUPERVISED, "1");
  assertEquals(env.AIO_PARENT_PID, "4242");
  assertEquals(RESTART_PORT_ENV in supervisorEnv(4242, undefined), false);
  assertEquals(RESTART_PORT_ENV in supervisorEnv(4242, 0), false);
  // NOT the operator's `AIO_PORT`: an Electron dev app with
  // `electron: { ignoreDebugEnv }` does not read that one, so on a TCP port
  // nobody named it moved after every edit — and was told each time that an
  // `AIO_PORT` nobody had set "is set and ignored".
  assertEquals("AIO_PORT" in env, false);
});

Deno.test("dev-restart: the carried port is read by a supervised child only, and only as a port", () => {
  const from = (e: Record<string, string>) => carriedPort((k) => e[k]);
  // What the supervisor wrote is what the child reads.
  assertEquals(from(supervisorEnv(4242, 51234)), 51234);
  assertEquals(from(supervisorEnv(4242, undefined)), undefined);
  // Left in a shell, it is nobody's word: no supervisor, no carry.
  assertEquals(from({ [RESTART_PORT_ENV]: "51234" }), undefined);
  for (const bad of ["", "0", "65536", "0x1F90", "1e3", "+3000", " 80", "x"]) {
    assertEquals(
      from({ AIO_DEV_SUPERVISED: "1", [RESTART_PORT_ENV]: bad }),
      undefined,
      JSON.stringify(bad),
    );
  }
});

Deno.test("dev-restart: the relaunch argv reproduces this process", async () => {
  const args = await relaunchArgs();
  assertEquals(args[0], "run");
  assertEquals(args[1], "-A");
  assert(args[2]!.endsWith(".ts"), args[2]);
  assertEquals(isSupervisedChild(), false, "a plain run is not a child");
});

/** A minimal app that SERVES the live cell's marker on a plain route, so the
 *  test can tell which version of the cell code is actually running. */
const appSource = (
  appId: string,
  port: number | undefined,
  client = `client: "server-only",`,
) =>
  `import { aio } from "aio";
import { probe } from "./cell.ts";
await aio.run({
  appId: "${appId}",
  cells: [probe],
  ${client}
  persist: false,
  ${port === undefined ? "" : `port: ${port},`}
  routes: { "/mark": () => new Response(probe.mark) },
});
`;

const cellSource = (mark: string) =>
  `import { cell } from "aio";
export const probe = cell("probe", {
  state: { mark: "${mark}" },
  methods: { set(s: { mark: string }, m: string) { s.mark = m; } },
});
`;

async function servedMark(url: string): Promise<string | null> {
  try {
    const res = await fetch(`${url}/mark`);
    if (!res.ok) {
      await res.body?.cancel();
      return null;
    }
    return (await res.text()).trim() || null;
  } catch {
    return null;
  }
}

async function waitFor<T>(
  fn: () => Promise<T | null>,
  ms: number,
): Promise<T | null> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v !== null) return v;
    await new Promise((r) => setTimeout(r, 150));
  }
  return null;
}

/** The port a live instance of `appId` is on, as `am` would find it (the
 *  single-instance lock) — null until the listener has answered. */
function livePortOf(appId: string): number | null {
  const live = instances(appId).find((i) => i.alive && i.port > 0);
  return live ? live.port : null;
}

/** Boot a scaffolded app (named port or not), edit its cell, and report what
 *  was served before and after, on which port. */
async function restartJourney(
  appId: string,
  namedPort: number | undefined,
): Promise<{
  booted: string | null;
  portBefore: number | null;
  after: string | null;
  portAfter: number | null;
  text: string;
}> {
  const dir = await Deno.makeTempDir({ prefix: "aio-dev-restart-" });
  const repo = fromFileUrl(new URL("../", import.meta.url));
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify({
      imports: {
        "aio": `${spec(repo)}mod.ts`,
        "aio/": `${spec(repo)}src/`,
        "immer": "npm:immer@10.2.0",
        "@std/path": "jsr:@std/path@1.1.2",
      },
    }),
  );
  await Deno.writeTextFile(join(dir, "app.ts"), appSource(appId, namedPort));
  await Deno.writeTextFile(join(dir, "cell.ts"), cellSource("v1"));

  const child = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", join(dir, "app.ts")],
    cwd: dir,
    env: devChildEnv(),
    stdout: "piped",
    stderr: "piped",
  }).spawn();

  let booted: string | null = null;
  let after: string | null = null;
  let portBefore: number | null = null;
  let portAfter: number | null = null;
  let text = "";
  try {
    portBefore = await waitFor(
      () => Promise.resolve(livePortOf(appId)),
      30_000,
    );
    const url = `http://127.0.0.1:${portBefore}`;
    booted = await waitFor(() => servedMark(url), 30_000);
    // Edit the cell — the watcher sees a `cell(` file and restarts the app.
    await Deno.writeTextFile(join(dir, "cell.ts"), cellSource("v2"));
    // On the SAME url: a relaunch that moved to another port serves nothing
    // here, and that is the failure this case exists to catch.
    after = await waitFor(
      async () => (await servedMark(url)) === "v2" ? "v2" : null,
      30_000,
    );
    portAfter = livePortOf(appId);
  } finally {
    // Collect output first; assert after, so a teardown hiccup can never mask
    // the real failure.
    try {
      child.kill("SIGTERM");
    } catch { /* already gone */ }
    const out = await child.output();
    text = new TextDecoder().decode(out.stdout) +
      new TextDecoder().decode(out.stderr);
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
  if (Deno.env.get("AIO_DEBUG_RESTART")) console.log(text);
  return { booted, portBefore, after, portAfter, text };
}

Deno.test({
  name:
    "dev-restart e2e: editing a cell restarts the app and serves the new logic",
  // Spawns a real app process; skipped in the same conditions as the other
  // process-level e2e tests.
  async fn() {
    const port = freePort();
    const r = await restartJourney("dev-restart-e2e", port);
    assertEquals(r.portBefore, port, "a named port is the port");
    assertEquals(r.booted, "v1", "the app booted and serves the original cell");
    assertEquals(
      r.after,
      "v2",
      "after the restart the NEW cell logic is the one serving",
    );
    assertEquals(r.portAfter, port, "…on the named port");
    // The restart must be announced — a silent process swap would be the kind
    // of magic this framework refuses to do.
    assertStringIncludes(r.text, "restarting the app");
  },
});

Deno.test({
  name:
    "dev-restart e2e: an app that named NO port comes back on the port it had",
  async fn() {
    // The default dev app: `deno task dev`, no --port, a free port picked at
    // boot. Every tab is on that port; the relaunched app has to be too.
    const r = await restartJourney("dev-restart-e2e-unnamed", undefined);
    assert(r.portBefore !== null && r.portBefore > 0, "booted on a free port");
    assertEquals(r.booted, "v1", "the app booted and serves the original cell");
    assertEquals(
      r.after,
      "v2",
      `the relaunched app serves the new cell on the ORIGINAL port ` +
        `${r.portBefore} (it is now on ${r.portAfter})`,
    );
    assertEquals(r.portAfter, r.portBefore, "the port did not move");
    assertStringIncludes(r.text, "restarting the app");
  },
});

Deno.test({
  name:
    "dev-restart e2e: an exposed Electron app with ignoreDebugEnv comes back on the port it had, and no AIO_PORT is named",
  ignore: Deno.build.os === "windows", // the stand-in window is a shell script
  sanitizeResources: false, // aio-ok: the spawned app owns its pipes; teardown kills it
  sanitizeOps: false, // aio-ok: the spawned app owns its pipes; teardown kills it
  async fn() {
    // The one app whose TCP port nobody named AND whose environment is not
    // read for one: a desktop app, exposed, with `ignoreDebugEnv`. The
    // supervisor carried the port as `AIO_PORT`, which that key ignores.
    const appId = "dev-restart-e2e-ignore-env";
    const dir = await tempDir("aio-dev-restart-el-");
    const repo = fromFileUrl(new URL("../", import.meta.url));
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({
        imports: {
          "aio": `${spec(repo)}mod.ts`,
          "aio/": `${spec(repo)}src/`,
          "immer": "npm:immer@10.2.0",
          "@std/path": "jsr:@std/path@1.1.2",
        },
      }),
    );
    await Deno.writeTextFile(
      join(dir, "app.ts"),
      appSource(
        appId,
        undefined,
        `client: "electron", expose: true, electron: { ignoreDebugEnv: true },`,
      ),
    );
    await Deno.writeTextFile(join(dir, "cell.ts"), cellSource("v1"));
    await Deno.writeTextFile(
      join(dir, "App.tsx"),
      "export default function App() { return <div>Hello</div>; }\n",
    );
    // The window: a process that IS what the server launched and opens
    // nothing; a display NAME so the launch happens at all
    // (tests/electron-ignore-debug-env.test.ts).
    const stub = join(dir, "electron");
    await Deno.writeTextFile(stub, "#!/bin/sh\nexec sleep 600\n");
    await Deno.chmod(stub, 0o755);
    const child = new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", join(dir, "app.ts")],
      cwd: dir,
      env: {
        ...devChildEnv(),
        WAYLAND_DISPLAY: "aio-standin",
        ELECTRON_PATH: stub,
        // Nothing ambient: what the child is told, the supervisor told it.
        AIO_PORT: "",
        AIO_DEFAULT_PORT: "",
        AIO_CDP: "",
      },
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const live = () => instances(appId).find((i) => i.alive && i.port > 0);
    const answers = async (port: number): Promise<true | null> => {
      try {
        (await Deno.connect({ hostname: "127.0.0.1", port })).close();
        return true;
      } catch {
        return null; // aio-ok: not listening (yet) — asked again
      }
    };
    let before: { pid: number; port: number } | null = null;
    let after: { pid: number; port: number } | null = null;
    let text = "";
    try {
      before = await waitFor(() => Promise.resolve(live() ?? null), 30_000);
      assert(before, "the app never recorded a TCP port");
      // The listener answers — as the cases above wait for `/mark` — before
      // the edit: a save made while the app is still starting is not this
      // case's subject.
      await waitFor(() => answers(before!.port), 30_000);
      await Deno.writeTextFile(join(dir, "cell.ts"), cellSource("v2"));
      // The relaunched app is another process, LISTENING where its record
      // says. (The record alone proves nothing: the supervisor files one for
      // the child, with the port it carries, before the child has bound.)
      after = await waitFor(async () => {
        const l = live();
        return l && l.pid !== before!.pid && await answers(l.port) ? l : null;
      }, 30_000);
    } finally {
      try {
        child.kill("SIGTERM");
      } catch { /* already gone */ }
      const out = await child.output();
      text = new TextDecoder().decode(out.stdout) +
        new TextDecoder().decode(out.stderr);
      await dropTempDir(dir);
    }
    if (Deno.env.get("AIO_DEBUG_RESTART")) console.log(text);
    assert(after, `the app was not relaunched:\n${text.slice(-4000)}`);
    assertEquals(
      after.port,
      before!.port,
      `the port moved:\n${text.slice(-4000)}`,
    );
    assert(
      !/AIO_PORT[^\n]*set and ignored/.test(text),
      `a variable nobody set was reported as ignored:\n${text.slice(-4000)}`,
    );
  },
});

Deno.test({
  name:
    "dev-restart e2e: SIGHUP to the supervisor does not end the dev session",
  ignore: Deno.build.os === "windows", // Windows has no SIGHUP
  // A field report, three times in one session: after a cell edit the app was
  // gone for good and the child had logged "parent process N is gone
  // (AIO_PARENT_PID) — shutting down".
  //
  // A headless app IGNORES SIGHUP on purpose so it outlives its shell
  // (aio-lifecycle.ts). The moment a cell edit turns that process into the
  // restart supervisor, its app has shut down and released that listener — so
  // the supervisor took SIGHUP's default action and died, while the child it
  // had just spawned still ignored SIGHUP and then killed ITSELF two seconds
  // later because its parent was gone. Nothing restarted it. Measured on this
  // exact shape before the fix.
  async fn() {
    const appId = "dev-restart-sighup";
    const dir = await tempDir("aio-dev-restart-hup-");
    const repo = fromFileUrl(new URL("../", import.meta.url));
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({
        imports: {
          "aio": `${spec(repo)}mod.ts`,
          "aio/": `${spec(repo)}src/`,
          "immer": "npm:immer@10.2.0",
          "@std/path": "jsr:@std/path@1.1.2",
        },
      }),
    );
    const port = freePort();
    await Deno.writeTextFile(join(dir, "app.ts"), appSource(appId, port));
    await Deno.writeTextFile(join(dir, "cell.ts"), cellSource("v1"));
    const url = `http://127.0.0.1:${port}`;

    const top = new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", join(dir, "app.ts")],
      cwd: dir,
      env: devChildEnv(),
      stdout: "piped",
      stderr: "piped",
    }).spawn();

    let served: string | null = null;
    let supervisorAlive = false;
    let text = "";
    try {
      assertEquals(
        await waitFor(() => servedMark(url), 60_000),
        "v1",
        "the app booted",
      );
      // The edit that turns this process into the supervisor.
      await Deno.writeTextFile(join(dir, "cell.ts"), cellSource("v2"));
      assertEquals(
        await waitFor(
          async () => (await servedMark(url)) === "v2" ? "v2" : null,
          60_000,
        ),
        "v2",
        "the supervised child is serving the new cell",
      );
      // The hang-up an aio app is specifically built to survive.
      Deno.kill(top.pid, "SIGHUP");
      // Longer than the child's 2 s parent-watch tick, twice over.
      await new Promise((r) => setTimeout(r, 6000));
      try {
        Deno.kill(top.pid, 0);
        supervisorAlive = true;
      } catch {
        supervisorAlive = false;
      }
      served = await servedMark(url);
    } finally {
      try {
        top.kill("SIGTERM");
      } catch { /* already gone */ }
      const out = await top.output();
      text = new TextDecoder().decode(out.stdout) +
        new TextDecoder().decode(out.stderr);
      await dropTempDir(dir);
    }
    assertEquals(
      supervisorAlive,
      true,
      `the supervisor took SIGHUP's default action and died:\n${text}`,
    );
    assertEquals(
      served,
      "v2",
      `the app is gone after a SIGHUP it is built to ignore:\n${text}`,
    );
    assertEquals(
      text.includes("is gone (AIO_PARENT_PID)"),
      false,
      `the child killed itself over its supervisor's death:\n${text}`,
    );
  },
});

Deno.test({
  name:
    "dev-restart e2e: a SIGHUP with no child to forward to still ends the supervisor",
  ignore: Deno.build.os === "windows", // Windows has no SIGHUP
  // The forwarding handler replaced SIGHUP's default action for the WHOLE life
  // of the supervisor, including every stretch in which there is no child to
  // forward to — above all `waitForSourceChange()`, which is unbounded: the
  // saved file does not load, the supervisor stays up on purpose and waits for
  // the next save. Close the terminal there and the hang-up was swallowed
  // outright: an orphaned supervisor with a recursive `Deno.watchFs`, outliving
  // the session that started it, with nothing on screen and no child to show
  // for it. A supervisor with no child IS a plain process, and a plain process
  // takes the hang-up.
  async fn() {
    const appId = "dev-restart-hup-nochild";
    const dir = await tempDir("aio-dev-restart-hup2-");
    const repo = fromFileUrl(new URL("../", import.meta.url));
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({
        imports: {
          "aio": `${spec(repo)}mod.ts`,
          "aio/": `${spec(repo)}src/`,
          "immer": "npm:immer@10.2.0",
          "@std/path": "jsr:@std/path@1.1.2",
        },
      }),
    );
    const port = freePort();
    await Deno.writeTextFile(join(dir, "app.ts"), appSource(appId, port));
    await Deno.writeTextFile(join(dir, "cell.ts"), cellSource("v1"));
    const url = `http://127.0.0.1:${port}`;

    const top = new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", join(dir, "app.ts")],
      cwd: dir,
      env: devChildEnv(),
      stdout: "piped",
      stderr: "piped",
    }).spawn();

    let alive = true;
    let text = "";
    try {
      assertEquals(
        await waitFor(() => servedMark(url), 60_000),
        "v1",
        "the app booted",
      );
      // A cell that does not parse: the edit makes this process a supervisor,
      // its first child dies on load, and the loop parks in
      // `waitForSourceChange()` with `stop.child === null`.
      await Deno.writeTextFile(
        join(dir, "cell.ts"),
        `import { cell } from "aio";\nexport const probe = cell("probe", {\n`,
      );
      // The app stops serving once the broken child fails to come up.
      assertEquals(
        await waitFor(
          async () => (await servedMark(url)) === null ? "gone" : null,
          60_000,
        ),
        "gone",
        "the broken cell took the app down",
      );
      // Give the loop time to reach the park.
      await new Promise((r) => setTimeout(r, 3000));
      Deno.kill(top.pid, "SIGHUP");
      for (let i = 0; i < 40 && alive; i++) {
        await new Promise((r) => setTimeout(r, 250));
        try {
          Deno.kill(top.pid, 0);
        } catch {
          alive = false;
        }
      }
    } finally {
      try {
        top.kill("SIGKILL");
      } catch { /* already gone */ }
      const out = await top.output();
      text = new TextDecoder().decode(out.stdout) +
        new TextDecoder().decode(out.stderr);
      await dropTempDir(dir);
    }
    assertEquals(
      alive,
      false,
      `the supervisor swallowed a hang-up it had no child to forward to and ` +
        `outlived its terminal:\n${text}`,
    );
  },
});

Deno.test("dev-restart: the restart exit code is outside the normal error range", () => {
  // 75 = EX_TEMPFAIL. It must not collide with 0/1 or a thrown-error exit,
  // or the supervisor would respawn an app that genuinely failed.
  assertEquals(RESTART_EXIT_CODE, 75);
});
