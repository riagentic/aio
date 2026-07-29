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
import {
  _resetCellBindings,
  bindCellReactive,
} from "../src/state/cell-reactive.ts";
import { nameIsTaken } from "../src/state/cell-helpers.ts";
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

// risoto 2026-07-28 #3 — the warning was the ONLY signal, and a warning does not
// stop the read from type-checking as the field's declared type: a lock screen
// asked "does a vault exist?", got `undefined` from a ui.exclude'd verifier, and
// branched on it as data. Dev/test now throws at the read; prod still degrades.
Deno.test("B7: a hidden read THROWS in dev, degrades in prod", () => {
  reset();
  const seeds = cell("b7-dev-seeds", {
    state: { hasVault: true, vaultCheck: "secret" },
    methods: {},
    ui: { exclude: ["vaultCheck"] },
  });
  bindCellReactive(seeds);
  const s = seeds as unknown as { hasVault: boolean; vaultCheck?: unknown };
  const dev = (globalThis as Record<string, unknown>).__aioDev;
  try {
    (globalThis as Record<string, unknown>).__aioDev = true;
    let threw = "";
    try {
      s.vaultCheck;
    } catch (e) {
      threw = String(e);
    }
    assert(
      threw.includes("b7-dev-seeds.vaultCheck"),
      `dev must throw at the read, got: ${threw || "no throw"}`,
    );
    assert(threw.includes("read from client context"), threw);
    assertEquals(s.hasVault, true, "the mirrored non-secret fact still reads");

    // Prod: the app keeps rendering — undefined + one warning, as before.
    (globalThis as Record<string, unknown>).__aioDev = false;
    const { warnings } = withWarnCapture(() => {
      assertEquals(s.vaultCheck, undefined);
      assertEquals(s.vaultCheck, undefined);
    });
    assertEquals(
      warnings.filter((w) => w.includes("b7-dev-seeds.vaultCheck")).length,
      1,
    );
  } finally {
    (globalThis as Record<string, unknown>).__aioDev = dev;
    reset();
  }
});

// risoto, first field result of the dev-throw: aio tripped its OWN guard.
//
// All three binding paths probed `typeof def[key] === "function"` to ask "does
// a method own this name?" — which READS the property, invoking whatever
// accessor is installed. By the second bind of a cell, that accessor is the
// reactive getter from the first (a re-bind clears `bound`, not the getters),
// so the framework read the app's hidden field and threw. It reported the app
// leaking a secret for something aio did, and took an entire UI suite offline
// (512/298 → 785/25 with the probe fixed). The question is about SHAPE, so it
// is answered from the descriptor and never touches a value.
Deno.test("B7: re-binding a cell with ui.exclude does not trip its own guard", () => {
  reset();
  const vault = cell("b7-rebind", {
    state: { hasVault: true, vaultCheck: "secret" },
    methods: { noop(_s: Record<string, unknown>) {} },
    ui: { exclude: ["vaultCheck"] },
  });
  const dev = (globalThis as Record<string, unknown>).__aioDev;
  try {
    (globalThis as Record<string, unknown>).__aioDev = true; // as every harness runs
    bindCellReactive(vault); // mount 1 — installs the hidden-field getter
    _resetCellBindings(); // app.close(): bindings released, getters remain
    // Mount 2 must not read through those getters just to inspect the shape.
    bindCellReactive(vault);
    bindCell(
      vault as never,
      () => Promise.resolve(undefined),
      () => ({ "b7-rebind": { hasVault: true, vaultCheck: "secret" } }),
    );
    assertEquals(
      (vault as unknown as { hasVault?: boolean }).hasVault,
      true,
      "the visible field still binds after a re-mount",
    );
  } finally {
    (globalThis as Record<string, unknown>).__aioDev = dev;
    reset();
  }
});

Deno.test("B7: the shape probe never invokes a getter (no reads, no tracking)", () => {
  // Beyond the throw: reading through the getter also called trackPath() and
  // the signal, so BINDING subscribed whatever reactive context was current.
  reset();
  let reads = 0;
  const def = { __aio: { id: "probe", state: { a: 1, m: 2 } } } as never;
  Object.defineProperty(def, "a", {
    get() {
      reads++;
      return 1;
    },
    configurable: true,
  });
  (def as Record<string, unknown>).m = () => {};
  assertEquals(nameIsTaken(def, "a"), false, "an accessor is not a method");
  assertEquals(nameIsTaken(def, "m"), true, "a function data property is");
  assertEquals(reads, 0, "the probe read nothing");
  reset();
});
