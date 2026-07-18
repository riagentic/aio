// risoto 2026-07-18 wish 2 — DEFINES the cross-cell-mutation-from-a-reducer
// contract (rather than leaving it folklore). Calling another cell's mutating
// method from inside a sync reducer body is a re-entrant dispatch: the loop
// queues and drains it, so the target cell's state DOES commit — and since
// the server broadcasts committed state, it reaches clients. The reporter
// hypothesized a silent sync-vs-async divergence; these pins prove there is
// none (empirically confirmed live over a real split socket, too).
//
// The genuinely-broken variant — mutating another cell's state DIRECTLY (its
// frozen read snapshot) instead of via its method — throws loudly
// (REDUCE_ERROR), so it is never the silent loss the report feared.
import { assert, assertEquals } from "@std/assert";
import { cell } from "../src/state/cell-create.ts";
import { bootCells } from "../src/testing/cell-test.ts";

const accounts = cell("xc-accounts", {
  state: { list: [] as string[] },
  methods: {
    add(s, name: string) {
      s.list.push(name);
    },
  },
});

const yieldToLoop = () => new Promise<void>((r) => setTimeout(r, 0));

const unlock = cell("xc-unlock", {
  state: { calls: 0 },
  methods: {
    // Cross-cell mutation made SYNCHRONOUSLY inside the reducer body.
    addSync(s, name: string) {
      s.calls += 1;
      accounts.add("sync:" + name);
    },
    // Cross-cell mutation made after an await (fresh top-level dispatch).
    async addAsync(s, name: string) {
      s.calls += 1;
      await yieldToLoop();
      accounts.add("async:" + name);
    },
    // The antipattern: reach into another cell's frozen read and mutate it.
    addDirectBroken(s, name: string) {
      s.calls += 1;
      (accounts.list as string[]).push("direct:" + name);
    },
  },
});

Deno.test("cross-cell: sync reducer call to another cell's method commits", async () => {
  const hb = await bootCells([accounts as never, unlock as never]);
  try {
    await unlock.addSync("alice");
    await hb.settle();
    assertEquals(
      accounts.list,
      ["sync:alice"],
      "re-entrant cross-cell dispatch applied to the target cell",
    );
  } finally {
    hb.dispose();
  }
});

Deno.test("cross-cell: async and sync produce the SAME committed result (no divergence)", async () => {
  const hb = await bootCells([accounts as never, unlock as never]);
  try {
    await unlock.addSync("a");
    await hb.settle();
    await unlock.addAsync("b");
    await hb.settle();
    assertEquals(
      accounts.list,
      ["sync:a", "async:b"],
      "sync and async cross-cell paths both commit — the hypothesized divergence is not real",
    );
  } finally {
    hb.dispose();
  }
});

Deno.test("cross-cell: DIRECT mutation of another cell's state fails loud in the harness, matching prod", async () => {
  const hb = await bootCells([accounts as never, unlock as never]);
  try {
    // Reaching into accounts.list (a frozen read) and pushing to it is an
    // illegal in-place mutation. On a real server it throws (REDUCE_ERROR) in
    // dev AND prod. The harness now runs dev-strict (_armTestStrict), so it
    // throws HERE too — a green test can no longer hide what production
    // rejects. Before the fix this silently corrupted committed state.
    let threw = false;
    await unlock.addDirectBroken("ghost").catch(() => {
      threw = true;
    });
    await hb.settle();
    assert(threw, "the illegal mutation must reject, not silently succeed");
    assertEquals(accounts.list, [], "and it must not have committed");
  } finally {
    hb.dispose();
  }
});
