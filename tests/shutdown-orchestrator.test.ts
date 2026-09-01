// The END of a process's life, phase by phase.
//
// `tests/shutdown-inflight.test.ts` pins Phase 1 (abort → drain → the writes
// commit). This file pins everything AFTER it: the phases that release the
// lock, close the databases and stop the server. Two properties, and both are
// durability properties even though neither one writes a byte itself:
//
//   1. NO PHASE CAN HANG THE SHUTDOWN. Phase 1 has a documented 3s budget, and
//      the number a user feels is "how long until the window disappears" — a
//      user `onStop` hook that never resolves must not turn that into forever.
//   2. NO PHASE CAN ABANDON THE ONES AFTER IT. A throw in "stop the vitals
//      timer" must not be the reason the SQLite handle is never closed, the
//      single-instance lock file is never removed (the next launch then
//      refuses to start) and the app never reports itself stopped.
//
// The refs are stubs on purpose: this is the orchestrator's own contract, and
// a stub is the only way to make a phase misbehave on demand.
import { assert, assertEquals } from "@std/assert";
import {
  createShutdownOrchestrator,
  type ShutdownRefs,
} from "../src/server/shutdown.ts";

const never = () => new Promise<void>(() => {});

type Trace = {
  refs: ShutdownRefs;
  done: string[];
  warns: string[];
  errors: string[];
};

/** A shutdown whose every phase is a no-op that records itself. */
function stubRefs(over: Partial<ShutdownRefs> = {}): Trace {
  const done: string[] = [];
  const warns: string[] = [];
  const errors: string[] = [];
  const mark = (n: string) => () => {
    done.push(n);
  };
  const log = {
    trace: () => {},
    debug: () => {},
    info: () => {},
    warn: (a: string, b?: unknown) => {
      warns.push(typeof b === "string" ? b : a);
    },
    error: (a: string, b?: unknown) => {
      errors.push(typeof b === "string" ? b : a);
    },
  } as unknown as ShutdownRefs["log"];
  const refs: ShutdownRefs = {
    flushPersist: async () => {
      done.push("persist");
    },
    setShuttingDown: mark("setShuttingDown"),
    diagHooks: {
      onStop: async () => {
        done.push("diag");
      },
    },
    getVitalsCheckTimer: () => undefined,
    getVitalsSystem: () => ({ destroy: mark("vitals") }),
    onStopping: undefined,
    onStop: mark("hook"),
    appLock: { release: mark("lock") },
    scheduleManager: { cancelAll: mark("schedules") },
    ownManager: { disposeAll: mark("own") },
    dispatch: {
      close: mark("dispatch.close"),
      drain: async () => {
        done.push("drain");
      },
    },
    getCellNames: () => [],
    getAppId: () => "shutdown-orchestrator",
    getElectronProc: () => null,
    clearElectronProc: () => {},
    disposeUds: mark("uds"),
    getUdsHandle: () => null,
    getServer: () => ({
      shutdown: async () => {
        done.push("server");
      },
    }),
    asyncDb: {
      close: async () => {
        done.push("sqlite");
      },
    },
    kvDb: { close: mark("kv") },
    sessionStore: { close: mark("sessions") },
    userStore: { close: mark("users") },
    setRunning: (v: boolean) => {
      done.push(`running:${v}`);
    },
    log,
    ...over,
  };
  return { refs, done, warns, errors };
}

/** The whole shutdown is bounded by DRAIN (3s) + TEARDOWN (5s); anything
 *  slower than this means a phase is unbounded again. */
const BOUND_MS = 12_000;

/** Resolve to `"timeout"` if `p` has not settled within `ms`. */
async function within<T>(p: Promise<T>, ms: number): Promise<T | "timeout"> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const r = await Promise.race([
    p.then((v) => v as T | "timeout"),
    new Promise<"timeout">((res) => t = setTimeout(() => res("timeout"), ms)),
  ]);
  if (t !== undefined) clearTimeout(t);
  return r;
}

// The phases that MUST still run once something upstream of them misbehaves —
// the lock file and the database handles are the two whose absence is visible
// on the NEXT launch, not this one.
const TAIL = ["lock", "server", "sqlite", "kv", "running:false"];

Deno.test("shutdown: a hook that never resolves cannot hold the process open", async () => {
  // A desktop app's window is gone the moment shutdown starts; what the user
  // watches after that is a process that will not die. Phase 1 is bounded and
  // says so in its own log line — every phase after it must be too, or the
  // documented bound is decorative.
  const { refs, done } = stubRefs({ onStop: never });
  const { shutdown } = createShutdownOrchestrator(refs);
  const r = await within(shutdown(), BOUND_MS);
  assertEquals(r, undefined, "shutdown must complete despite a stuck onStop");
  for (const step of TAIL) {
    assert(done.includes(step), `'${step}' must still run — got ${done}`);
  }
});

Deno.test("shutdown: a persist that never resolves cannot hold the process open", async () => {
  const { refs, done } = stubRefs({ flushPersist: never });
  const { shutdown } = createShutdownOrchestrator(refs);
  assertEquals(await within(shutdown(), BOUND_MS), undefined);
  for (const step of TAIL) {
    assert(done.includes(step), `'${step}' must still run — got ${done}`);
  }
});

Deno.test("shutdown: a server close that never resolves cannot hold the process open", async () => {
  const { refs, done } = stubRefs({
    getServer: () => ({ shutdown: never }),
  });
  const { shutdown } = createShutdownOrchestrator(refs);
  assertEquals(await within(shutdown(), BOUND_MS), undefined);
  for (const step of ["lock", "sqlite", "kv", "running:false"]) {
    assert(done.includes(step), `'${step}' must still run — got ${done}`);
  }
});

Deno.test("shutdown: a stuck phase is REPORTED, never silently skipped", async () => {
  // Fail loud: "the window took 3 extra seconds to close" is the only symptom
  // a bounded-but-silent phase produces, and it is not one anybody can debug.
  const { refs, warns, errors } = stubRefs({ onStop: never });
  const { shutdown } = createShutdownOrchestrator(refs);
  await within(shutdown(), BOUND_MS);
  const said = [...warns, ...errors].join("\n");
  assert(
    /onStop|hook/i.test(said),
    `the stuck phase must name itself in the log — got:\n${said}`,
  );
});

// A throw anywhere in phases 3-7 used to unwind `_doShutdown` entirely: the
// databases stayed open, `setRunning(false)` never ran, and — the one with a
// next-launch consequence — the single-instance lock file was never removed,
// so the app refused to start again with "already running".
for (
  const [label, over] of [
    ["vitals.destroy", {
      getVitalsSystem: () => ({
        destroy: () => {
          throw new Error("boom");
        },
      }),
    }],
    ["appLock.release", {
      appLock: {
        release: () => {
          throw new Error("boom");
        },
      },
    }],
    ["scheduleManager.cancelAll", {
      scheduleManager: {
        cancelAll: () => {
          throw new Error("boom");
        },
      },
    }],
    ["ownManager.disposeAll", {
      ownManager: {
        disposeAll: () => {
          throw new Error("boom");
        },
      },
    }],
    ["disposeUds", {
      disposeUds: () => {
        throw new Error("boom");
      },
    }],
    ["diagHooks.onStop", {
      diagHooks: {
        onStop: () => Promise.reject(new Error("boom")),
        uninstallCrashHandler: () => {
          throw new Error("boom");
        },
      },
    }],
  ] as [string, Partial<ShutdownRefs>][]
) {
  Deno.test(`shutdown: a throwing ${label} does not abandon the phases after it`, async () => {
    const { refs, done, errors } = stubRefs(over);
    const { shutdown } = createShutdownOrchestrator(refs);
    const r = await within(shutdown(), BOUND_MS);
    assertEquals(r, undefined, "shutdown itself must not reject");
    for (const step of TAIL) {
      if (over.appLock && step === "lock") continue; // that IS the thrower
      assert(
        done.includes(step),
        `'${step}' must still run after ${label} threw — got ${done}`,
      );
    }
    assert(
      errors.some((e) => e.includes("boom")),
      `the failure must be reported by its own message, never swallowed — ` +
        `got ${JSON.stringify(errors)}`,
    );
  });
}

Deno.test("shutdown: two concurrent shutdowns are one shutdown", async () => {
  const { refs, done } = stubRefs();
  const { shutdown } = createShutdownOrchestrator(refs);
  await Promise.all([shutdown(), shutdown(), shutdown()]);
  assertEquals(
    done.filter((d) => d === "sqlite").length,
    1,
    "the database is closed exactly once",
  );
  assertEquals(done.filter((d) => d === "persist").length, 1);
  // …and a fourth, sequential call is still a no-op.
  await shutdown();
  assertEquals(done.filter((d) => d === "sqlite").length, 1);
});

Deno.test("shutdown: order is persist → diag → hooks → lock → server → db", async () => {
  const { refs, done } = stubRefs();
  const { shutdown } = createShutdownOrchestrator(refs);
  await shutdown();
  const at = (s: string) => done.indexOf(s);
  assert(at("setShuttingDown") < at("persist"), "close the door, then persist");
  assert(at("dispatch.close") < at("persist"));
  assert(at("drain") < at("persist"), "drain BEFORE the final snapshot");
  assert(at("persist") < at("diag"));
  assert(at("persist") < at("hook"));
  assert(at("hook") < at("lock"), "user hooks run while the app still owns it");
  assert(at("lock") < at("sqlite"));
  assert(at("server") < at("sqlite"), "stop accepting before closing the db");
  assertEquals(done.at(-1), "running:false");
});

// ── Phase 0: onStopping ─────────────────────────────────────────────────────
//
// The hook exists because `onStop` cannot do its job: Phase 1 closes dispatch
// and drains, user hooks are Phase 5, so an app that dispatches from a raw
// timer or a promise `finally` lands in the drain window and earns
// "dispatch is draining — '<action>' is new input and was refused". By the time
// onStop runs the refusal is already logged. The only userland signal that
// fired early enough was onConnect/onDisconnect — a transport event doing a
// lifecycle job, and an ordering that was never a contract.

Deno.test("shutdown: onStopping runs while dispatch is still open", async () => {
  const { refs, done } = stubRefs({
    onStopping: () => {
      done.push("quiesce");
    },
  });
  const { shutdown } = createShutdownOrchestrator(refs);
  assertEquals(await within(shutdown(), BOUND_MS), undefined);
  // BEFORE the mark and BEFORE the close — both, or a write from the hook is
  // either refused (close) or dropped by the final persist (mark).
  assert(done.includes("quiesce"), `onStopping must run — got ${done}`);
  assert(
    done.indexOf("quiesce") < done.indexOf("setShuttingDown"),
    `onStopping must run before the state is marked — got ${done}`,
  );
  assert(
    done.indexOf("quiesce") < done.indexOf("dispatch.close"),
    `onStopping must run before dispatch closes — got ${done}`,
  );
  // …and it is the FIRST thing that happens, so nothing shutdown does can
  // change what the app sees while it quiesces.
  assertEquals(done[0], "quiesce");
});

Deno.test("shutdown: onStopping is awaited, and bounded like every other phase", async () => {
  // Awaited: a hook that resolves late must still be finished before dispatch
  // closes, or the hook is decorative — it would be quiescing into a window
  // that had already shut.
  let finished = false;
  const { refs, done } = stubRefs({
    onStopping: async () => {
      await new Promise((r) => setTimeout(r, 50));
      finished = true;
    },
  });
  const { shutdown } = createShutdownOrchestrator(refs);
  assertEquals(await within(shutdown(), BOUND_MS), undefined);
  assert(finished, "onStopping must be awaited, not fired and forgotten");
  assertEquals(done[0], "setShuttingDown");

  // Bounded: app code that never resolves must not become a process that never
  // dies — the same rule Phase 5 already lives under.
  const stuck = stubRefs({ onStopping: never });
  const s2 = createShutdownOrchestrator(stuck.refs);
  assertEquals(await within(s2.shutdown(), BOUND_MS), undefined);
  for (const step of TAIL) {
    assert(
      stuck.done.includes(step),
      `'${step}' must still run — got ${stuck.done}`,
    );
  }
});

Deno.test("shutdown: a throwing onStopping does not abandon the shutdown", async () => {
  const { refs, done, errors } = stubRefs({
    onStopping: () => {
      throw new Error("producer refused to stop");
    },
  });
  const { shutdown } = createShutdownOrchestrator(refs);
  assertEquals(await within(shutdown(), BOUND_MS), undefined);
  assert(
    errors.some((e) => e.includes("producer refused to stop")),
    `the throw must be reported, not swallowed — got ${errors}`,
  );
  for (const step of TAIL) {
    assert(done.includes(step), `'${step}' must still run — got ${done}`);
  }
});
