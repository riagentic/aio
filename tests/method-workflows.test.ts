// perfect-aio D1 — the method-native workflow capabilities that replace
// generators: until/race/sleep helpers + cancelOn/$signal cancellation.
import { assert, assertEquals, assertRejects } from "@std/assert";
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
  cancelOn: { slowWork: ["wf-demo:stop"] },
  methods: {
    async slowWork(
      s: { status: string; waited: boolean } & Partial<MethodDraftMeta>,
    ) {
      s.status = "working";
      await sleep(15);
      if (s.$signal!.aborted) {
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
      s: { status: string; waited: boolean } & Partial<MethodDraftMeta>,
    ) {
      // Sync methods: $signal is undefined (atomic, nothing to abort).
      return s.$signal?.aborted ?? false;
    },
  },
});

testCell(
  wf,
  "cancelOn aborts the in-flight async method ($signal)",
  async (t) => {
    // testCell semantics: an async method EXECUTES when awaited — so fire the
    // cancel trigger on a timer that lands mid-flight (inside slowWork's sleep).
    setTimeout(() => t.send.stop(), 5);
    await t.send.slowWork();
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
  state: { clears: 0, lastCleared: "" },
  listensTo: { onCartCleared: cart2.clear },
  methods: {
    onCartCleared(s) {
      // Runs when wf-cart:clear dispatches — the cart never imports us.
      s.clears += 1;
      s.lastCleared = "yes";
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
