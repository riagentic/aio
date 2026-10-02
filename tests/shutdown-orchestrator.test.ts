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
import {
  DRAIN_TIMEOUT_MS,
  SHUTDOWN_BUDGET_MS,
  STORES_RESERVE_MS,
  TEARDOWN_TIMEOUT_MS,
} from "../src/server/shutdown-budget.ts";

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

Deno.test("shutdown: a server that never came up does not abandon the tail", async () => {
  // A boot that throws while BINDING (a taken port) runs `bootUndo.unwind()`
  // through this orchestrator BEFORE `server` is ever assigned — so
  // `getServer()` is `undefined`. The refs type used to claim non-null, no
  // guard was written, and teardown died on "Cannot read properties of
  // undefined (reading 'shutdown')", taking every phase after "server" with
  // it: the SQLite worker, the session/user stores, `setRunning(false)` and
  // the lock-dir prune all never ran. The guard is what this pins.
  const { refs, done } = stubRefs({ getServer: () => undefined });
  const { shutdown } = createShutdownOrchestrator(refs);
  assertEquals(await within(shutdown(), BOUND_MS), undefined);
  for (
    const step of ["lock", "sqlite", "kv", "sessions", "users", "running:false"]
  ) {
    assert(
      done.includes(step),
      `'${step}' must still run when the server never bound — got ${done}`,
    );
  }
  assertEquals(
    done.includes("server"),
    false,
    "nothing to close, nothing to run",
  );
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

Deno.test("shutdown: onStopping, worker close and the drain share ONE drain budget — the persist is not pushed past it", async () => {
  // Each used to get its own DRAIN_TIMEOUT_MS: a hung onStopping plus a hung
  // worker close plus a hung drain put the final persist 9s in, and the whole
  // stop past SHUTDOWN_BUDGET_MS — the number a supervisor is told to wait
  // before SIGKILL, and the one the exit watchdog is sized from.
  const t0 = Date.now();
  let persistAt = -1;
  const { refs, warns } = stubRefs({
    onStopping: never,
    closeWorkers: never,
    // A drain that is still busy when its timeout arrives.
    dispatch: {
      close: () => {},
      drain: (ms = 0) => new Promise<void>((r) => setTimeout(r, ms)),
    },
    flushPersist: async () => {
      persistAt = Date.now() - t0;
    },
    onStop: never,
  });
  const { shutdown } = createShutdownOrchestrator(refs);
  assertEquals(await within(shutdown(), BOUND_MS), undefined);
  const total = Date.now() - t0;
  assert(
    persistAt >= 0 && persistAt < DRAIN_TIMEOUT_MS + 500,
    `persist must start within the ${DRAIN_TIMEOUT_MS}ms drain budget — started at ${persistAt}ms`,
  );
  assert(
    total < SHUTDOWN_BUDGET_MS + 500,
    `the whole stop must fit SHUTDOWN_BUDGET_MS (${SHUTDOWN_BUDGET_MS}ms) — took ${total}ms`,
  );
  // The line names the budget that actually ran out.
  assert(
    warns.some((w) =>
      w.includes("onStopping") && w.includes(`${DRAIN_TIMEOUT_MS}ms drain`)
    ),
    `onStopping's timeout names the drain budget — got ${warns}`,
  );
});

Deno.test("shutdown: a hung onStop that ignores its cut still leaves the closes their time", async () => {
  // The hook used to be handed ALL of what was left of the teardown budget, so
  // the server and SQLite closes after it each got the 1ms floor and "did not
  // finish". A close that needs a moment must still get one.
  const { refs, warns, done } = stubRefs({
    onStop: never,
    asyncDb: {
      close: () =>
        new Promise<void>((r) =>
          setTimeout(() => {
            done.push("sqlite");
            r();
          }, 200)
        ),
    },
  });
  const { shutdown } = createShutdownOrchestrator(refs);
  assertEquals(await within(shutdown(), BOUND_MS), undefined);
  assert(done.includes("sqlite"), `sqlite close was cut short — ${warns}`);
  assert(
    !warns.some((w) => w.includes("sqlite did not finish")),
    `sqlite starved by the hung hook — ${warns}`,
  );
});

Deno.test("shutdown: the stores always get their floor, and a healthy stop is never charged for it", async () => {
  // Every phase is handed what is left of the ONE teardown budget. A server
  // close that hung spent all of it, and SQLite, the KV store and the auth
  // stores each got the 1ms floor — "sqlite did not finish inside the 5000ms
  // teardown budget" on a stop where the database was never the slow part.
  // The stores now get STORES_RESERVE_MS whatever came before — ADDED when a
  // phase overran, and only then: a stop that fits the budget is untouched.
  assertEquals(STORES_RESERVE_MS, 200, "the floor the docs state");
  assertEquals(TEARDOWN_TIMEOUT_MS, 5000);
  // Every timer a close starts, so a close that was CUT is still waited out
  // before the test ends (its timer is this test's, not the next one's).
  const timers: Promise<void>[] = [];
  const takes = (ms: number, name: string, done: string[]) => () => {
    const p = new Promise<void>((r) =>
      setTimeout(() => {
        done.push(name);
        r();
      }, ms)
    );
    timers.push(p);
    return p;
  };
  const run = async (over: (done: string[]) => Partial<ShutdownRefs>) => {
    const done: string[] = [];
    const { refs, warns } = stubRefs(over(done));
    const t0 = Date.now();
    const r = await within(
      createShutdownOrchestrator(refs).shutdown(),
      BOUND_MS,
    );
    assertEquals(r, undefined);
    const cut = warns.filter((w) => w.includes("did not finish"));
    return { done, cut, took: Date.now() - t0 };
  };
  // Fixed times, NOT sized from the constant: four closes of 40 ms need 160 ms
  // of the 200; one of 300 ms does not fit it.
  const stores = (done: string[], sqliteMs: number) => ({
    asyncDb: { close: takes(sqliteMs, "sqlite", done) },
    kvDb: { close: takes(40, "kv", done) },
    sessionStore: { close: takes(40, "sessions", done) },
    userStore: { close: takes(40, "users", done) },
  });
  const mark = (name: string, done: string[]) => () => void done.push(name);
  const [hung, tooSlow, healthy, slowStore, short, late] = await Promise
    .all([
      // A server close that never returns: the stores still close.
      run((d) => ({
        getServer: () => ({ shutdown: never }),
        ...stores(d, 40),
      })),
      // …inside their floor and no further: a 300 ms close is cut at 200, and
      // the stores after it still get their turn.
      run((d) => ({
        getServer: () => ({ shutdown: never }),
        asyncDb: { close: takes(300, "sqlite", d) },
        kvDb: { close: mark("kv", d) },
        sessionStore: { close: mark("sessions", d) },
        userStore: { close: mark("users", d) },
      })),
      // A slow but healthy stop — 4.9 s of server close, inside the budget —
      // finishes as it always did: nothing is cut, nothing is added.
      run((d) => ({
        getServer: () => ({ shutdown: takes(4900, "server", d) }),
        ...stores(d, 40),
      })),
      // The floor is a FLOOR: a store that needs longer, on a stop with the
      // budget still in hand, has the budget.
      run((d) => stores(d, 400)),
      // …and it is the floor even when a little is left: a hook that ignored
      // its cut leaves 250 ms, a 150 ms server close leaves 100 — the stores
      // get 200, so a 150 ms close finishes.
      run((d) => ({
        onStop: never,
        getServer: () => ({ shutdown: takes(150, "server", d) }),
        asyncDb: { close: takes(150, "sqlite", d) },
      })),
      // …counted from the stores' turn, not from the old deadline: with 150 ms
      // left the floor is 200, not 350, so a 275 ms close is cut.
      run((d) => ({
        onStop: never,
        getServer: () => ({ shutdown: takes(100, "server", d) }),
        asyncDb: { close: takes(275, "sqlite", d) },
      })),
    ]);
  try {
    assertEquals(
      hung.done,
      ["sqlite", "kv", "sessions", "users"],
      `${hung.cut}`,
    );
    assertEquals(
      hung.cut.map((w) => w.replace(/ did not finish.*/s, "")),
      ["shutdown: server"],
      "the phase that overran is named, once, and no other",
    );
    assert(
      hung.cut[0]!.includes(`${TEARDOWN_TIMEOUT_MS}ms teardown`),
      `the server's cap was the whole teardown — ${hung.cut[0]}`,
    );
    // A timer never fires early: the server had the WHOLE budget before it was
    // cut, and the floor came on top of it.
    assert(hung.took >= TEARDOWN_TIMEOUT_MS + 160, `took ${hung.took}ms`);
    assert(
      hung.took <= TEARDOWN_TIMEOUT_MS + STORES_RESERVE_MS + 150,
      `an overrun stop took ${hung.took}ms`,
    );

    assertEquals(
      tooSlow.cut.map((w) => w.replace(/ did not finish.*/s, "")),
      ["shutdown: server", "shutdown: sqlite"],
    );
    assert(
      tooSlow.cut[1]!.includes("200ms stores'"),
      `a store cut inside the floor is told the cap it had — ${tooSlow.cut[1]}`,
    );
    // What a cut costs is said truthfully: a store's data is in its WAL — only
    // its checkpoint waits; any other phase's unfinished work is gone.
    assert(
      tooSlow.cut[1]!.endsWith(
        "(its checkpoint is left for the next start; nothing that was " +
          "written is lost)",
      ),
      tooSlow.cut[1],
    );
    assert(
      tooSlow.cut[0]!.endsWith(
        "(whatever it still had to write or release is lost)",
      ),
      tooSlow.cut[0],
    );
    assert(
      tooSlow.took >= TEARDOWN_TIMEOUT_MS + STORES_RESERVE_MS,
      `sqlite was cut after ${tooSlow.took}ms — before the floor was spent`,
    );
    assert(
      tooSlow.took <= TEARDOWN_TIMEOUT_MS + STORES_RESERVE_MS + 150,
      `an overrun stop took ${tooSlow.took}ms`,
    );
    assertEquals(
      tooSlow.done,
      ["kv", "sessions", "users"],
      "the stores after a cut one still close",
    );

    assertEquals(healthy.cut, [], "a stop inside the budget was cut");
    assertEquals(healthy.done, ["server", "sqlite", "kv", "sessions", "users"]);
    assert(
      healthy.took < TEARDOWN_TIMEOUT_MS + 150,
      `a healthy stop took ${healthy.took}ms`,
    );

    assertEquals(slowStore.cut, [], "a store was cut with the budget in hand");
    assertEquals(slowStore.done, ["sqlite", "kv", "sessions", "users"]);

    assertEquals(
      short.cut.map((w) => w.replace(/ did not finish.*/s, "")),
      ["shutdown: hook onStop"],
      "only the hook overran",
    );
    assertEquals(short.done.slice(0, 2), ["server", "sqlite"]);

    assertEquals(late.cut.length, 2, late.cut.join("\n"));
    assert(late.cut[1]!.startsWith("shutdown: sqlite did not"), late.cut[1]);
    assert(
      late.cut[1]!.includes(`${STORES_RESERVE_MS}ms stores'`),
      late.cut[1],
    );
    assert(
      late.took <= TEARDOWN_TIMEOUT_MS + STORES_RESERVE_MS + 150,
      `took ${late.took}ms`,
    );
  } finally {
    // Whatever a cut left running ends before the next test starts.
    await Promise.all(timers);
  }
});

Deno.test("shutdown: onStop is cut where the docs say — 0.5 s before the end of the teardown", async () => {
  // The documented cut: an `onStop` is told to stop 0.5 s before the end of
  // the teardown, and given up on 0.25 s after that. The stores' floor is not
  // taken out of either.
  let cutAt = -1;
  let leftAt = -1;
  const t0 = Date.now();
  const { refs } = stubRefs({
    onStop: ((signal: AbortSignal) => {
      signal.addEventListener("abort", () => cutAt = Date.now() - t0);
      return never();
    }) as ShutdownRefs["onStop"],
    // The first phase after the hook: when the wait for it was given up.
    appLock: {
      release: () => {
        leftAt = Date.now() - t0;
      },
    },
  });
  const { shutdown } = createShutdownOrchestrator(refs);
  assertEquals(await within(shutdown(), BOUND_MS), undefined);
  // A timer never fires early, so the lower bounds are exact; the phases
  // before the hook are no-ops here.
  assert(
    cutAt >= TEARDOWN_TIMEOUT_MS - 500 - 50,
    `onStop was cut after ${cutAt}ms`,
  );
  assert(
    leftAt >= TEARDOWN_TIMEOUT_MS - 250 - 50,
    `a hook that ignored its cut was left after ${leftAt}ms`,
  );
});
