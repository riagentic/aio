// an audit item/M8 — server-side `cell.field` reads are LIVE, not initial.
// A cell bound to a running app (bindCell, via aio.run) reads its CURRENT
// slice from that app's store — same truth as app.getState(). The stale-read
// trap ("route handler reads the initial state silently") must never return:
// custom HTTP routes, effects, and any plain server code read live values.
// Multi-instance (perfect-aio D2): each cell binds to exactly ONE app and
// reads THAT app's store.
import { assert, assertEquals } from "@std/assert";
import { cell } from "../src/state/cell-create.ts";
import { aio } from "../src/server/aio.ts";
import { _resetAioRuntime } from "../src/state/runtime-reset.ts";

Deno.test("B4: server code reads CURRENT cell state after dispatch (libraryMode)", async () => {
  _resetAioRuntime();
  const members = cell("b4-members", {
    state: { roster: [] as string[], pins: {} as Record<string, string> },
    methods: {
      add(
        s: { roster: string[]; pins: Record<string, string> },
        name: string,
        pin: string,
      ) {
        s.roster.push(name);
        s.pins[name] = pin;
      },
    },
  });

  const app = await aio.run({
    cells: [members],
    appId: "b4-server-reads",
    libraryMode: true,
    persist: false,
    client: "server-only",
    baseDir: await Deno.makeTempDir(),
  });
  try {
    const m = members as unknown as {
      roster: string[];
      pins: Record<string, string>;
      add: (n: string, p: string) => Promise<void>;
    };
    assertEquals(m.roster, [], "pre-dispatch read is the (live) empty slice");
    await m.add("alice", "1234");
    assertEquals(m.roster, ["alice"], "server read reflects the dispatch");
    assertEquals(m.pins, { alice: "1234" }, "server sees ALL fields");
    // Same truth as the store — the two read paths can never diverge.
    assertEquals(
      (app.getState() as Record<string, unknown>)["b4-members"],
      { roster: m.roster, pins: m.pins },
    );
  } finally {
    await app.close();
    _resetAioRuntime();
  }
});

Deno.test("B4: custom HTTP route reads live cell state (a loginRoute trap)", async () => {
  _resetAioRuntime();
  const members = cell("b4-route-members", {
    state: { roster: [] as string[] },
    methods: {
      add(s: { roster: string[] }, name: string) {
        s.roster.push(name);
      },
    },
  });

  const app = await aio.run({
    cells: [members],
    appId: "b4-route-reads",
    libraryMode: true,
    persist: false,
    client: "server-only",
    baseDir: await Deno.makeTempDir(),
    routes: {
      "/roster": () =>
        new Response(
          JSON.stringify((members as unknown as { roster: string[] }).roster),
        ),
    },
  });
  try {
    await (members as unknown as { add: (n: string) => Promise<void> }).add(
      "alice",
    );
    const res = await fetch(`http://localhost:${app.port}/roster`);
    assertEquals(
      await res.json(),
      ["alice"],
      "route sees the dispatched member — not the initial []",
    );
  } finally {
    await app.close();
    _resetAioRuntime();
  }
});

Deno.test("B4/D2: two instances — each cell reads ITS OWN app's state", async () => {
  _resetAioRuntime();
  const a = cell("b4-mi-a", {
    state: { n: 0 },
    methods: {
      bump(s: { n: number }) {
        s.n += 1;
      },
    },
  });
  const b = cell("b4-mi-b", {
    state: { n: 0 },
    methods: {
      bump(s: { n: number }) {
        s.n += 10;
      },
    },
  });

  const app1 = await aio.run({
    cells: [a],
    appId: "b4-mi-1",
    libraryMode: true,
    persist: false,
    client: "server-only",
    baseDir: await Deno.makeTempDir(),
  });
  const app2 = await aio.run({
    cells: [b],
    appId: "b4-mi-2",
    libraryMode: true,
    persist: false,
    client: "server-only",
    baseDir: await Deno.makeTempDir(),
  });
  try {
    const ca = a as unknown as { n: number; bump: () => Promise<void> };
    const cb = b as unknown as { n: number; bump: () => Promise<void> };
    await ca.bump();
    await ca.bump();
    await cb.bump();

    assertEquals(ca.n, 2, "cell a reads app1's store");
    assertEquals(cb.n, 10, "cell b reads app2's store");
    assertEquals(
      (app1.getState() as Record<string, { n: number }>)["b4-mi-a"]!.n,
      2,
    );
    assertEquals(
      (app2.getState() as Record<string, { n: number }>)["b4-mi-b"]!.n,
      10,
    );
    // No cross-talk: neither app carries the other's slice.
    assert(!("b4-mi-b" in (app1.getState() as Record<string, unknown>)));
    assert(!("b4-mi-a" in (app2.getState() as Record<string, unknown>)));
  } finally {
    await app1.close();
    await app2.close();
    _resetAioRuntime();
  }
});

Deno.test("B4: an UNBOUND cell reads its declared initial state (pre-boot only)", () => {
  _resetAioRuntime();
  const lonely = cell("b4-unbound", {
    state: { n: 42 },
    methods: {},
  });
  assertEquals(
    (lonely as unknown as { n: number }).n,
    42,
    "pre-boot reads yield the declared defaults",
  );
  _resetAioRuntime();
});
