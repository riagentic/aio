// TBD B7/U2 — `ui.exclude` (and ui visibility in general) is enforced on the
// CLIENT read seam (bindCellReactive), not only at broadcast time. In
// standalone/electron there is no broadcast, so before this every "secret"
// field was fully readable on the cell object in the client process. Now:
//   - hidden fields read as undefined from client context + ONE loud warning
//   - dot-path excludes strip the nested value (same as the broadcast filter)
//   - selectors see the filtered slice (no leak through computed reads)
//   - server-side reads (bindCell — routes/effects) still see everything
import { assert, assertEquals } from "@std/assert";
import { cell } from "../src/state/cell-create.ts";
import { bindCell } from "../src/state/cell-catalog.ts";
import { bindCellReactive } from "../src/state/cell-reactive.ts";
import { getCellSignal } from "../src/state/state-signals.ts";
import { _resetAioRuntime } from "../src/state/runtime-reset.ts";
import { _resetSignals } from "../src/state/state-signals.ts";

function withWarnCapture<T>(fn: () => T): { result: T; warnings: string[] } {
  const warnings: string[] = [];
  const orig = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
  try {
    return { result: fn(), warnings };
  } finally {
    console.warn = orig;
  }
}

function reset(): void {
  _resetAioRuntime();
  _resetSignals();
}

Deno.test("B7: ui.exclude field reads undefined in client context + warns once", () => {
  reset();
  const members = cell("b7-members", {
    state: { roster: ["alice"], pins: { alice: "1234" } },
    methods: {},
    ui: { exclude: ["pins"] },
  });
  bindCellReactive(members);
  // Simulate live client state (standalone commit / broadcast slice).
  getCellSignal("b7-members", members.__aio.state).set({
    roster: ["alice", "bob"],
    pins: { alice: "1234", bob: "9999" },
  });

  const { warnings } = withWarnCapture(() => {
    const m = members as unknown as { roster: string[]; pins?: unknown };
    assertEquals(m.roster, ["alice", "bob"], "visible field stays live");
    assertEquals(m.pins, undefined, "excluded field must read undefined");
    assertEquals(m.pins, undefined, "second read also undefined");
  });
  const b7Warns = warnings.filter((w) => w.includes("b7-members.pins"));
  assertEquals(b7Warns.length, 1, "exactly ONE warning per cell.field");
  assert(
    b7Warns[0]!.includes("ui.exclude"),
    `warning names the cause: ${b7Warns[0]}`,
  );
  reset();
});

Deno.test("B7: dot-path exclude strips the nested value on client reads", () => {
  reset();
  const accounts = cell("b7-accounts", {
    state: { accounts: [{ name: "a", encSecKey: "s3cret" }] },
    methods: {},
    ui: { exclude: ["accounts.encSecKey"] },
  });
  bindCellReactive(accounts);
  getCellSignal("b7-accounts", accounts.__aio.state).set({
    accounts: [{ name: "a", encSecKey: "s3cret" }, {
      name: "b",
      encSecKey: "t0psecret",
    }],
  });
  const list =
    (accounts as unknown as { accounts: Record<string, unknown>[] }).accounts;
  assertEquals(list.length, 2);
  assertEquals(list[0], { name: "a" }, "nested secret stripped");
  assertEquals(list[1], { name: "b" }, "nested secret stripped (all elements)");
  reset();
});

Deno.test("B7: ui.include hides non-included fields on client reads", () => {
  reset();
  const stats = cell("b7-stats", {
    state: { publicCount: 1, internalBuffer: "x" },
    methods: {},
    ui: { include: ["publicCount"] },
  });
  bindCellReactive(stats);
  const { warnings } = withWarnCapture(() => {
    const s = stats as unknown as {
      publicCount: number;
      internalBuffer?: string;
    };
    assertEquals(s.publicCount, 1);
    assertEquals(s.internalBuffer, undefined);
  });
  assert(
    warnings.some((w) =>
      w.includes("b7-stats.internalBuffer") && w.includes("ui.include")
    ),
    `warning names include-mode cause: ${warnings.join("|")}`,
  );
  reset();
});

Deno.test('B7: ui "none" hides every field on client reads', () => {
  reset();
  const internal = cell("b7-internal", {
    state: { queue: [1, 2] },
    methods: {},
    ui: "none",
  });
  bindCellReactive(internal);
  const { result, warnings } = withWarnCapture(() =>
    (internal as unknown as { queue?: unknown }).queue
  );
  assertEquals(result, undefined);
  assert(warnings.some((w) => w.includes("b7-internal.queue")));
  reset();
});

Deno.test("B7: selectors in client context see the FILTERED slice (no leak)", () => {
  reset();
  const vault = cell("b7-vault", {
    state: { items: ["a"], masterKey: "k" },
    methods: {},
    ui: { exclude: ["masterKey"] },
    selectors: {
      leak: (s: { items: string[]; masterKey?: string }) => s.masterKey,
      count: (s: { items: string[] }) => s.items.length,
    },
  });
  bindCellReactive(vault);
  getCellSignal("b7-vault", vault.__aio.state).set({
    items: ["a", "b"],
    masterKey: "k",
  });
  const v = vault as unknown as { leak: () => unknown; count: () => number };
  assertEquals(v.count(), 2, "selector over visible fields works");
  assertEquals(v.leak(), undefined, "selector cannot read excluded field");
  reset();
});

Deno.test("B7: server-side reads (bindCell) still see EVERYTHING", async () => {
  reset();
  const members = cell("b7-server", {
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
    ui: { exclude: ["pins"] },
  });

  // A minimal server store — same contract bindCell gets from aio.run.
  let state: Record<string, unknown> = { "b7-server": members.__aio.state };
  const reduce = (a: { type: string; payload?: { args?: unknown[] } }) => {
    if (a.type === "b7-server:add") {
      const s = structuredClone(state["b7-server"]) as {
        roster: string[];
        pins: Record<string, string>;
      };
      const [name, pin] = a.payload!.args as [string, string];
      s.roster.push(name);
      s.pins[name] = pin;
      state = { ...state, "b7-server": s };
    }
  };
  bindCell(
    members,
    (a) => Promise.resolve(reduce(a as { type: string })),
    () => state,
  );

  await (members as unknown as {
    add: (n: string, p: string) => Promise<void>;
  }).add("alice", "1234");
  const m = members as unknown as {
    roster: string[];
    pins: Record<string, string>;
  };
  assertEquals(m.roster, ["alice"], "server read is live");
  assertEquals(
    m.pins,
    { alice: "1234" },
    "server code legitimately sees ui-excluded fields",
  );
  reset();
});

Deno.test("B7: standalone wiring (bindCell → bindCellReactive) filters reads", async () => {
  // Exactly what standalone-air's bootStandalone does per cell: bindCell wires
  // methods to the local loop, then bindCellReactive overrides the state
  // getters. The reactive (client) getter must win AND filter.
  reset();
  const vault = cell("b7-standalone", {
    state: { items: [] as string[], apiSecret: "k" },
    methods: {
      add(s: { items: string[] }, v: string) {
        s.items.push(v);
      },
    },
    ui: { exclude: ["apiSecret"] },
  });
  let state: Record<string, unknown> = {
    "b7-standalone": vault.__aio.state,
  };
  bindCell(
    vault,
    (a) => {
      const act = a as { type: string; payload?: { args?: unknown[] } };
      if (act.type === "b7-standalone:add") {
        const s = structuredClone(state["b7-standalone"]) as {
          items: string[];
          apiSecret: string;
        };
        s.items.push(act.payload!.args![0] as string);
        state = { ...state, "b7-standalone": s };
        getCellSignal("b7-standalone", vault.__aio.state).set(
          state["b7-standalone"],
        );
      }
      return Promise.resolve();
    },
    () => state,
  );
  bindCellReactive(vault);

  await (vault as unknown as { add: (v: string) => Promise<void> }).add("x");
  const { result, warnings } = withWarnCapture(() => {
    const v = vault as unknown as { items: string[]; apiSecret?: string };
    assertEquals(v.items, ["x"], "visible field live through the local loop");
    return v.apiSecret;
  });
  assertEquals(result, undefined, "secret hidden in standalone");
  assert(warnings.some((w) => w.includes("b7-standalone.apiSecret")));
  reset();
});

Deno.test("B7: client-scoped cells are exempt (state never leaves the client)", () => {
  reset();
  const session = cell("b7-session", {
    scope: "client",
    state: { member: null as { id: string } | null },
    methods: {
      signIn(s: { member: { id: string } | null }, id: string) {
        s.member = { id };
      },
    },
    ui: { exclude: ["member"] },
  });
  bindCellReactive(session);
  (session as unknown as { signIn: (id: string) => Promise<void> }).signIn(
    "m1",
  );
  assertEquals(
    (session as unknown as { member: { id: string } | null }).member,
    { id: "m1" },
    "client-cell state stays readable — there is no server to keep it on",
  );
  reset();
});
