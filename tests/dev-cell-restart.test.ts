// Dev auto-restart on a cell edit, proven against a real
// process: cells run in the server process, so an edited cell used to keep its
// old logic while the browser showed new UI. Now the app restarts itself.
//
// The e2e case boots a scaffolded app, rewrites its cell, and asserts the
// SERVED STATE changes — i.e. the new cell code is really running — with the
// port still bound afterwards (the supervisor handed it to a fresh child).
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  isSupervisedChild,
  relaunchArgs,
  RESTART_EXIT_CODE,
  restartBlockedReason,
  restartForCellChange,
  supervisorEnv,
} from "../src/server/dev-restart.ts";
import { instances } from "../src/server/single-instance-lock.ts";
import { freePort } from "../src/testing/server-test.ts";

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
  // rides the env rung of the port chain (`AIO_PORT`, the one reader in
  // paths.ts), so the relaunch binds the same port. No TCP port (zero-port
  // electron) carries nothing: the relaunch must not grow a listener.
  const env = supervisorEnv(4242, 51234);
  assertEquals(env.AIO_PORT, "51234");
  assertEquals(env.AIO_DEV_SUPERVISED, "1");
  assertEquals(env.AIO_PARENT_PID, "4242");
  assertEquals("AIO_PORT" in supervisorEnv(4242, undefined), false);
  assertEquals("AIO_PORT" in supervisorEnv(4242, 0), false);
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
const appSource = (appId: string, port: number | undefined) =>
  `import { aio } from "aio";
import { probe } from "./cell.ts";
await aio.run({
  appId: "${appId}",
  cells: [probe],
  client: "server-only",
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
  const repo = new URL("../", import.meta.url).pathname;
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify({
      imports: {
        "aio": `${repo}mod.ts`,
        "aio/": `${repo}src/`,
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
  ignore: Deno.build.os === "windows",
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
  ignore: Deno.build.os === "windows",
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

Deno.test("dev-restart: the restart exit code is outside the normal error range", () => {
  // 75 = EX_TEMPFAIL. It must not collide with 0/1 or a thrown-error exit,
  // or the supervisor would respawn an app that genuinely failed.
  assertEquals(RESTART_EXIT_CODE, 75);
});
