// lifecycle-restart.test.ts — `aio.stop()` / `aio.restart()`.
//
// The restart matrix is a pure function (`restartPlan`), so every launcher is
// a row here; the process-level behaviour — shutdown contract FIRST, then the
// exit code the launcher expects, deferred by a macrotask so a cell method can
// ask for it — is driven in-process with the exit and relaunch injected. The
// compiled-binary row is proven for real in tests/build-e2e.test.ts.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  _resetLifecycleFacts,
  isServiceSupervised,
  type ProcessFacts,
  processFacts,
  requestRestart,
  requestStop,
  restartPlan,
  STOP_EXIT_CODE,
  stopExitCode,
} from "../src/server/aio-lifecycle.ts";
import { RESTART_EXIT_CODE } from "../src/server/dev-restart.ts";
import { registerRuntime } from "../src/server/shutdown.ts";
import { aio } from "../src/server/aio.ts";

const base: ProcessFacts = {
  running: true,
  libraryMode: false,
  devSupervised: false,
  serviceSupervised: false,
  compiled: false,
  artifact: "/usr/bin/deno",
  sourceBlocked: null,
  sourceArgs: ["run", "-A", "src/app.ts", "--port=0"],
  args: ["--port=0"],
};

const quiet = { info() {}, warn() {}, error() {} };

Deno.test("restart matrix: every launcher has a row, and no row is a silent no-op", () => {
  // deno task dev — the supervised child exits 75 and the supervisor relaunches.
  assertEquals(restartPlan({ ...base, devSupervised: true }), {
    kind: "exit",
    code: RESTART_EXIT_CODE,
    why: "under the dev supervisor (deno task dev) — it relaunches the app",
  });
  // A service — exit 0; Restart=always brings it back.
  const svc = restartPlan({ ...base, serviceSupervised: true });
  assertEquals(svc.kind, "exit");
  assertEquals((svc as { code: number }).code, 0);
  // The dev supervisor outranks a service env leaking into a dev shell.
  assertEquals(
    (restartPlan({ ...base, devSupervised: true, serviceSupervised: true }) as {
      code: number;
    }).code,
    RESTART_EXIT_CODE,
  );
  // A compiled binary / AppImage / local Electron — re-exec, same args.
  assertEquals(
    restartPlan({ ...base, compiled: true, artifact: "/opt/app/app" }),
    {
      kind: "reexec",
      artifact: "/opt/app/app",
      args: ["--port=0"],
      why: "compiled — re-executing /opt/app/app with the same arguments",
    },
  );
  // `deno run -A app.ts`, unsupervised — re-exec deno with the real argv.
  const src = restartPlan(base);
  assertEquals(src.kind, "reexec");
  assertEquals((src as { args: string[] }).args, base.sourceArgs);
  assertEquals((src as { artifact: string }).artifact, "/usr/bin/deno");

  // The refusals — each names the reason AND the manual step.
  const refused = (f: Partial<ProcessFacts>) => {
    const p = restartPlan({ ...base, ...f });
    assertEquals(p.kind, "refused");
    return p as { reason: string; manual: string };
  };
  assertStringIncludes(refused({ running: false }).reason, "no app is running");
  const lib = refused({ libraryMode: true });
  assertStringIncludes(lib.reason, "libraryMode");
  assertStringIncludes(lib.manual, "app.close()");
  const noA = refused({ sourceBlocked: "the process was not started with -A" });
  assertStringIncludes(noA.reason, "not started with -A");
  assertStringIncludes(noA.manual, "deno task dev");
  assertStringIncludes(noA.manual, "Restart=always");
});

Deno.test("stop exit code: 0 everywhere except under a service manager, where it is the code the unit must not restart", () => {
  assertEquals(stopExitCode(base), 0);
  assertEquals(stopExitCode({ ...base, devSupervised: true }), 0);
  assertEquals(
    stopExitCode({ ...base, serviceSupervised: true }),
    STOP_EXIT_CODE,
  );
  assertEquals(
    stopExitCode({ ...base, serviceSupervised: true, devSupervised: true }),
    0,
  );
  assertEquals(STOP_EXIT_CODE, 143);
  // The decider the update handover shares.
  assert(isServiceSupervised((n) => n === "INVOCATION_ID" ? "x" : undefined));
  assert(isServiceSupervised((n) => n === "AIO_SUPERVISED" ? "1" : undefined));
  assert(!isServiceSupervised(() => undefined));
});

Deno.test("aio.restart() on the dev path: the shutdown contract runs FIRST, then exit 75 — deferred, so a cell method can ask", async () => {
  const order: string[] = [];
  const unregister = registerRuntime(async () => {
    await new Promise((r) => setTimeout(r, 5));
    order.push("shutdown");
  });
  try {
    const plan = await requestRestart({
      facts: () => Promise.resolve({ ...base, devSupervised: true }),
      exit: (code) => void order.push(`exit ${code}`),
      relaunch: () => void order.push("relaunch"),
      log: quiet,
    });
    assertEquals(plan.kind, "exit");
    // Scheduled, not done: the caller's dispatch gets to return first.
    assertEquals(order, []);
    await new Promise((r) => setTimeout(r, 30));
    assertEquals(order, ["shutdown", `exit ${RESTART_EXIT_CODE}`]);
  } finally {
    unregister();
  }
});

Deno.test("aio.restart() on the re-exec path: the successor is launched with the same args, AFTER shutdown, then exit 0", async () => {
  const order: string[] = [];
  const unregister = registerRuntime(() => {
    order.push("shutdown");
    return Promise.resolve();
  });
  try {
    await requestRestart({
      facts: () =>
        Promise.resolve({ ...base, compiled: true, artifact: "/opt/x/app" }),
      exit: (code) => void order.push(`exit ${code}`),
      relaunch: ({ artifact, args }) =>
        void order.push(`relaunch ${artifact} ${args.join(" ")}`),
      log: quiet,
    });
    await new Promise((r) => setTimeout(r, 20));
    assertEquals(order, ["shutdown", "relaunch /opt/x/app --port=0", "exit 0"]);
  } finally {
    unregister();
  }
});

Deno.test("aio.restart() refuses — with the reason and the manual step — where the launcher cannot restart itself", async () => {
  let msg = "";
  await requestRestart({
    facts: () =>
      Promise.resolve({ ...base, sourceBlocked: "AIO_NO_DEV_RESTART=1" }),
    exit: () => {
      throw new Error("must not exit on a refusal");
    },
    log: quiet,
  }).catch((e) => (msg = String(e)));
  assertStringIncludes(msg, "aio.restart() refused");
  assertStringIncludes(msg, "AIO_NO_DEV_RESTART=1");
  assertStringIncludes(msg, "To restart:");
});

Deno.test("aio.stop(): shutdown contract, then the launcher's stop code; libraryMode closes the apps and keeps the process", async () => {
  const order: string[] = [];
  const unregister = registerRuntime(() => {
    order.push("shutdown");
    return Promise.resolve();
  });
  try {
    await requestStop({
      facts: () => Promise.resolve({ ...base, serviceSupervised: true }),
      exit: (code) => void order.push(`exit ${code}`),
      log: quiet,
    });
    await new Promise((r) => setTimeout(r, 20));
    assertEquals(order, ["shutdown", `exit ${STOP_EXIT_CODE}`]);

    order.length = 0;
    await requestStop({
      facts: () => Promise.resolve({ ...base, libraryMode: true }),
      exit: () => {
        throw new Error("libraryMode must never end the host process");
      },
      log: quiet,
    });
    assertEquals(order, ["shutdown"]);
  } finally {
    unregister();
  }
});

Deno.test("processFacts reads the launcher from the environment, and a process with no app refuses", async () => {
  _resetLifecycleFacts();
  Deno.env.set("AIO_DEV_SUPERVISED", "1");
  try {
    const f = await processFacts();
    assert(f.devSupervised);
    assertEquals(f.running, false);
    assertEquals(f.args, Deno.args);
  } finally {
    Deno.env.delete("AIO_DEV_SUPERVISED");
  }
  let msg = "";
  await aio.restart().catch((e) => (msg = String(e)));
  assertStringIncludes(msg, "no app is running");
  msg = "";
  await aio.stop().catch((e) => (msg = String(e)));
  assertStringIncludes(msg, "no app is running");
  // The public namespace carries both.
  assertEquals(typeof aio.stop, "function");
  assertEquals(typeof aio.restart, "function");
});
