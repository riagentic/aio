// perfect-aio D1 — the method-native workflow capabilities that replace
// generators: until/race/sleep helpers + cancelOn/$signal cancellation.
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  race,
  sleep,
  until,
  UntilTimeoutError,
} from "../src/state/async-helpers.ts";
import {
  _resetMethodCancel,
  notifyMethodCancel,
  registerCancelOn,
  trackCall,
} from "../src/state/method-cancel.ts";
import { cell } from "../src/state/cell-create.ts";
import { composeCells } from "../src/state/cell-compose.ts";
import type { MethodDraftMeta } from "../src/state/cell-impl.ts";
import { schedule } from "../src/state/schedule.ts";
import { testCell } from "../src/testing/cell-test.ts";

// ── until / race / sleep ──────────────────────────────────────────────

Deno.test("until: resolves when the predicate turns true", async () => {
  let flag = false;
  setTimeout(() => flag = true, 30);
  await until(() => flag, { intervalMs: 5 });
  assert(flag);
});

Deno.test("until: fail-loud timeout with description", async () => {
  const err = await assertRejects(
    () => until(() => false, { timeoutMs: 60, intervalMs: 5, msg: "flag up" }),
    UntilTimeoutError,
  );
  assert(err.message.includes("60ms"));
  assert(err.message.includes("flag up"));
});

Deno.test("until: honors an AbortSignal", async () => {
  const c = new AbortController();
  setTimeout(() => c.abort(), 20);
  await assertRejects(
    () => until(() => false, { signal: c.signal, intervalMs: 5 }),
    DOMException,
  );
});

Deno.test("race: first branch wins; timeout sugar works", async () => {
  const fast = await race({
    a: sleep(5).then(() => "A"),
    b: sleep(200).then(() => "B"),
  });
  assertEquals(fast.winner, "a");
  assertEquals(fast.value, "A");

  const timed = await race({ work: sleep(500), timeout: 20 });
  assertEquals(timed.winner, "timeout");
});

// ── end-to-end through a real cell ────────────────────────────────────

const wf = cell("wf-demo", {
  state: { status: "idle", waited: false },
  // These tests PIN the opted-out semantics (alpha52: transaction is the
  // default): live reads for `until(() => s.waited)` and a write recorded
  // AFTER the abort ("cancelled") — a transaction would discard both.
  transaction: false,
  cancelOn: { slowWork: ["wf-demo:stop"] },
  methods: {
    async slowWork(
      s: { status: string; waited: boolean } & MethodDraftMeta,
    ) {
      s.status = "working";
      await sleep(15);
      if (s.$signal.aborted) {
        s.status = "cancelled";
        return;
      }
      s.status = "done";
    },
    stop(s) {
      s.status = "stopping";
    },
    async waitsForFlag(s) {
      await until(() => s.waited, { timeoutMs: 500, intervalMs: 5 });
      s.status = "flagged";
    },
    raise(s) {
      s.waited = true;
    },
    syncSignalIsSafe(
      s: { status: string; waited: boolean } & MethodDraftMeta,
    ) {
      // Sync methods: $signal is undefined (atomic, nothing to abort).
      return s.$signal.aborted ?? false;
    },
  },
});

testCell(
  wf,
  "cancelOn aborts the in-flight async method ($signal)",
  async (t) => {
    // The call starts when it is made, so the trigger dispatched
    // right after it lands mid-flight — the same shape an app has, where a
    // button click stops work a previous click began.
    const working = t.send.slowWork();
    await t.send.stop();
    await working;
    t.expect.state((s) => s.status === "cancelled");
  },
);

testCell(wf, "async method completes when nothing cancels", async (t) => {
  await t.send.slowWork();
  t.expect.state((s) => s.status === "done");
});

testCell(
  wf,
  "until() inside a method sees live state (waitFor replacement)",
  async (t) => {
    const p = t.send.waitsForFlag();
    await sleep(10);
    await t.send.raise();
    await p;
    t.expect.state((s) => s.status === "flagged");
  },
);

testCell(wf, "sync method: $signal is safely optional", async (t) => {
  const aborted = await t.send.syncSignalIsSafe();
  assertEquals(aborted, false);
});

// ── cancelOn: "self" — newest wins ─────────────────────────
//
// "a new navigation cancels the scan still running" is the most common async
// shape in a browsing UI (search-as-you-type, folder scan, autocomplete). A
// self-reference cannot be written by hand — the bound method does not exist
// yet inside its own cell() literal — so every app hand-rolled a guard.

const scanner = cell("wf-scan", {
  state: { current: null as string | null, done: [] as string[], aborted: 0 },
  // Pins the opted-out shape: the superseded call still RECORDS its abort
  // (s.aborted += 1 after the signal fired) — a transaction discards a
  // cancelled call's writes by design.
  transaction: false,
  cancelOn: { open: "self" },
  methods: {
    async open(
      s:
        & { current: string | null; done: string[]; aborted: number }
        & MethodDraftMeta,
      path: string,
    ) {
      s.current = path;
      await sleep(20);
      if (s.$signal.aborted) {
        s.aborted += 1;
        return;
      }
      s.done = [...s.done, path];
      s.current = null;
    },
  },
});

testCell(
  scanner,
  "cancelOn 'self': a newer call aborts the older",
  async (t) => {
    const first = t.send.open("/a");
    const second = t.send.open("/b"); // supersedes /a
    await Promise.all([first, second]);
    t.expect.state((s) => s.aborted === 1);
    t.expect.state((s) => s.done.length === 1 && s.done[0] === "/b");
  },
);

testCell(scanner, "cancelOn 'self': a call never aborts itself", async (t) => {
  // Triggers fire during reduce; the incoming call is only tracked when its
  // effect runs, one step later — so "self" can only ever reach its elders.
  await t.send.open("/only");
  t.expect.state((s) => s.aborted === 0);
  t.expect.state((s) => s.done.length === 1 && s.current === null);
});

Deno.test("cancelOn: 'self' resolves to the method's own action type", () => {
  registerCancelOn("scan", "open", "self");
  const older = new AbortController();
  trackCall("scan", "open", older);
  notifyMethodCancel("scan:open");
  assertEquals(older.signal.aborted, true);
});

Deno.test("cancelOn: naming a method that cannot be cancelled throws", () => {
  assertThrows(
    () =>
      cell("wf-badcancel", {
        state: { n: 0 },
        // A TYPO. It no longer type-checks either — `cancelOn`'s keys are
        // `keyof M`, the way `long:`'s entries always were — so the cast is
        // what a JS caller (or a `--no-check` run) still reaches this gate
        // with. Both layers matter: the type stops it at the keystroke, the
        // runtime stops it for everyone else.
        cancelOn: { opne: "self" } as unknown as { open: "self" },
        methods: {
          async open(s) {
            await sleep(1);
            s.n++;
          },
        },
      }),
    Error,
    "no method 'opne'",
  );
  assertThrows(
    () =>
      cell("wf-synccancel", {
        state: { n: 0 },
        cancelOn: { bump: "self" }, // sync — nothing is ever in flight
        methods: {
          bump(s) {
            s.n++;
          },
        },
      }),
    Error,
    "is a SYNC method",
  );
});

// ── cancelOn / $signal (registry level) ───────────────────────────────

Deno.test("method-cancel: trigger aborts only the registered method's calls", () => {
  registerCancelOn("checkout", "place", ["cart:clear", { type: "nav:away" }]);
  const c1 = new AbortController();
  const c2 = new AbortController();
  trackCall("checkout", "place", c1);
  trackCall("checkout", "other", c2);

  notifyMethodCancel("cart:clear");
  assertEquals(c1.signal.aborted, true, "registered method aborted");
  assertEquals(c2.signal.aborted, false, "unrelated method untouched");

  // Untracked calls are not aborted later.
  const c3 = new AbortController();
  const untrack = trackCall("checkout", "place", c3);
  untrack();
  notifyMethodCancel("nav:away");
  assertEquals(c3.signal.aborted, false, "untracked call not aborted");
});
// NOTE: no _resetMethodCancel() here — it would wipe the module-time
// registrations of real cells in this file (registry is process-global).

// ── cancelOn must reach a call QUEUED behind the serialize mutex ──────
//
// `transaction: { serialize: true }` chains calls on a promise tail, so a
// queued call's AbortController used to be created only when its turn came —
// and `notifyMethodCancel` can only abort controllers that already exist. An
// explicit Stop pressed during job 1 therefore let jobs 2 and 3 run in full,
// each reading `s.$signal.aborted === false`. Exactly the hazard shape
// shutdown hit and closed with `_shutdownCells`.

const queued = cell("wf-queued", {
  transaction: { serialize: true },
  cancelOn: { job: ["wf-queued:stop"] },
  state: { done: [] as number[], stopped: false },
  methods: {
    async job(
      s: { done: number[]; stopped: boolean } & MethodDraftMeta,
      n: number,
    ) {
      await sleep(10);
      if (s.$signal.aborted) return;
      s.done = [...s.done, n];
    },
    stop(s: { stopped: boolean }) {
      s.stopped = true;
    },
  },
});

testCell(
  queued,
  "cancelOn reaches calls queued behind the serialize mutex",
  async (t) => {
    const all = [t.send.job(1), t.send.job(2), t.send.job(3)];
    await t.send.stop(); // fires while job 1 runs and 2/3 are still queued
    await Promise.allSettled(all);
    t.expect.state((s) => s.done.length === 0);
  },
);

testCell(
  queued,
  "cancelOn: a call dispatched AFTER the trigger is not pre-aborted",
  async (t) => {
    // The window closes by construction: a controller is created when the
    // call's __exec effect runs, and effects of an action run before the next
    // action is reduced — so a later call never sees an earlier trigger.
    await t.send.stop();
    await t.send.job(9);
    t.expect.state((s) => s.done.length === 1 && s.done[0] === 9);
  },
);

// ── listensTo object form: decoupled cross-cell reaction (D1) ─────────

const cart2 = cell("wf-cart", {
  state: { items: [] as string[] },
  methods: {
    add(s, item: string) {
      s.items.push(item);
    },
    clear(s) {
      s.items = [];
    },
  },
});

const stats2 = cell("wf-stats", {
  state: { clears: 0, lastCleared: "", lastAdded: "" },
  listensTo: { onCartCleared: cart2.clear, onAdded: cart2.add },
  methods: {
    onCartCleared(s) {
      // Runs when wf-cart:clear dispatches — the cart never imports us.
      s.clears += 1;
      s.lastCleared = "yes";
    },
    // Foreign method args arrive SPREAD — the handler mirrors the foreign
    // method's own parameter list.
    onAdded(s, item: string) {
      s.lastAdded = item;
    },
  },
});

Deno.test("listensTo object form: handler runs on the foreign action", () => {
  const composed = composeCells([cart2, stats2]);
  let state = composed.initialState;
  state = composed.reduce(state, {
    type: "wf-cart:add",
    payload: { args: ["milk"] },
  }).state;
  state = composed.reduce(state, {
    type: "wf-cart:clear",
    payload: { args: [] },
  }).state;
  assertEquals((state["wf-cart"] as { items: string[] }).items, []);
  assertEquals((state["wf-stats"] as { clears: number }).clears, 1);
  assertEquals(
    (state["wf-stats"] as { lastCleared: string }).lastCleared,
    "yes",
  );
  assertEquals((state["wf-stats"] as { lastAdded: string }).lastAdded, "milk");
});

Deno.test("listensTo object form: unknown method fails loud at definition", () => {
  let msg = "";
  try {
    cell("wf-bad-listens", {
      state: {},
      listensTo: { nope: "wf-cart:clear" },
      methods: { real(_s) {} },
    });
  } catch (e) {
    msg = String(e);
  }
  assertEquals(msg.includes("no method named 'nope'"), true, msg);
});

Deno.test("listensTo object form: async handler fails loud at definition", () => {
  let msg = "";
  try {
    cell("wf-async-listens", {
      state: {},
      listensTo: { react: "wf-cart:clear" },
      methods: {
        async react(_s) {},
      },
    });
  } catch (e) {
    msg = String(e);
  }
  assertEquals(msg.includes("must be a SYNC method"), true, msg);
});

// ── a listensTo handler's return is classified like any other sync return ──
//
// The foreign path handed the handler's result back RAW, and compose-reduce
// only reads an ARRAY as effects. So the SAME sync method ran its
// `s.$do(schedule.after(...))` when called directly and silently dropped it
// when reached through listensTo (a dropped `own.set(...)` also leaked its
// factory in pendingFactories for the process lifetime), while a returned DATA
// array was mistaken for effects and blamed on the FOREIGN action.

const reactor = cell("wf-react", {
  state: { hits: 0, rows: [] as number[] },
  listensTo: { onEffect: cart2.clear, onData: cart2.add },
  methods: {
    onEffect(s) {
      s.hits += 1;
      s.$do(schedule.after("wf-react.retry", 1000, { type: "wf-react:later" }));
    },
    onData(s) {
      s.rows = [1, 2, 3];
      return [1, 2, 3]; // DATA, not effects
    },
  },
});

Deno.test("listensTo: a $do'd effect reaches the effect queue", () => {
  const composed = composeCells([cart2, reactor]);
  const r = composed.reduce(composed.initialState, {
    type: "wf-cart:clear",
    payload: { args: [] },
  });
  assertEquals((r.state["wf-react"] as { hits: number }).hits, 1);
  assertEquals(r.effects.length, 1, "the lone schedule effect is not dropped");
  assertEquals(
    (r.effects[0] as { type: string }).type,
    "__schedule",
    "…and it is the schedule effect the handler $do'd",
  );
});

Deno.test("listensTo: a data-array return is a VALUE, never effects", () => {
  const composed = composeCells([cart2, reactor]);
  const r = composed.reduce(composed.initialState, {
    type: "wf-cart:add",
    payload: { args: ["milk"] },
  });
  assertEquals((r.state["wf-react"] as { rows: number[] }).rows, [1, 2, 3]);
  assertEquals(
    r.effects.length,
    0,
    "plain data must not be dispatched as effects (it used to raise " +
      "'reducer returned invalid effect' against the FOREIGN action)",
  );
});

Deno.test("listensTo: direct call and foreign reaction agree on the return", () => {
  // The parity that makes the classification one decider, not two: the same
  // method, reached both ways, produces the same effects.
  const direct = composeCells([cart2, reactor]).reduce(
    composeCells([cart2, reactor]).initialState,
    { type: "wf-react:onEffect", payload: { args: [] } },
  );
  const foreign = composeCells([cart2, reactor]).reduce(
    composeCells([cart2, reactor]).initialState,
    { type: "wf-cart:clear", payload: { args: [] } },
  );
  assertEquals(
    JSON.stringify(direct.effects),
    JSON.stringify(foreign.effects),
  );
});

// Two handlers, one foreign action. The reducer looks up exactly ONE handler
// per trigger, so the second registration silently replaced the first and that
// method simply never ran — no warning, no type error, in a block where every
// other mistake throws. A cell whose reaction never fires is the quietest
// possible bug, so this is a refusal now.
Deno.test("listensTo: two methods on the SAME foreign action is refused, not silently last-wins", () => {
  const src = cell("wf-dup-src", {
    state: { n: 0 },
    methods: {
      bump(s) {
        s.n += 1;
      },
    },
  });
  let thrown: unknown;
  try {
    cell("wf-dup-listener", {
      state: { a: 0, b: 0 },
      listensTo: { onFirst: src.bump, onSecond: src.bump },
      methods: {
        onFirst(s) {
          s.a += 1;
        },
        onSecond(s) {
          s.b += 1;
        },
      },
    });
  } catch (e) {
    thrown = e;
  }
  assert(
    thrown instanceof Error,
    "a mapping only one half of which can run must throw",
  );
  assertStringIncludes(String(thrown), "onFirst");
  assertStringIncludes(String(thrown), "onSecond");
});
