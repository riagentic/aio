// an audit item/U2 — `ui.exclude` (and ui visibility in general) is enforced on the
// CLIENT read seam (bindCellReactive), not only at broadcast time. In
// standalone/electron there is no broadcast, so before this every "secret"
// field was fully readable on the cell object in the client process. Now:
//   - a hidden-field read from client context THROWS — dev and prod alike —
//     naming cell + field + the two fixes (it used to warn once and read
//     `undefined`, which client code then branched on as data)
//   - dot-path excludes strip the nested value (same as the broadcast filter)
//   - selectors see the filtered slice (no leak through computed reads)
//   - server-side reads (bindCell — routes/effects) still see everything
import { SIDE } from "../src/diagnostics/contexts.ts";
import { assert, assertEquals, assertThrows } from "@std/assert";
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

/** The one outcome for a hidden read: a throw naming `cell.field`, and the
 *  same throw on the second read. Run under BOTH dev and prod so the table
 *  cannot fork again. */
function assertHiddenThrows(id: string, read: () => unknown): string {
  const g = globalThis as Record<string, unknown>;
  const prev = g.__aioDev;
  let msg = "";
  try {
    for (const dev of [true, false]) {
      g.__aioDev = dev;
      const { warnings } = withWarnCapture(() => {
        const e = assertThrows(
          read,
          Error,
          id,
          `${dev ? "dev" : "prod"}: ${id}`,
        );
        assertThrows(read, Error, id, "second read throws too");
        msg = e.message;
      });
      assertEquals(warnings.length, 0, "a throw, never a warning");
    }
  } finally {
    g.__aioDev = prev;
  }
  return msg;
}

function reset(): void {
  _resetAioRuntime();
  _resetSignals();
}

Deno.test("B7: ui.exclude field read from client context THROWS naming cell.field + the fixes", () => {
  reset();
  const members = cell("b7-members", {
    state: { roster: ["alice"], pins: { alice: "1234" } },
    methods: {},
    visible: { exclude: ["pins"] },
  });
  bindCellReactive(members);
  // Simulate live client state (standalone commit / broadcast slice).
  getCellSignal("b7-members", members.__aio.state).set({
    roster: ["alice", "bob"],
    pins: { alice: "1234", bob: "9999" },
  });

  const m = members as unknown as { roster: string[]; pins?: unknown };
  assertEquals(m.roster, ["alice", "bob"], "visible field stays live");
  const msg = assertHiddenThrows("b7-members.pins", () => m.pins);
  assert(msg.includes("visible.exclude"), `names the cause: ${msg}`);
  assert(msg.includes("hasPins: boolean"), `names the fact-field fix: ${msg}`);
  assert(msg.includes("server-side/async"), `names the server fix: ${msg}`);
  assert(msg.includes("dev and prod"), `says it holds everywhere: ${msg}`);
  reset();
});

Deno.test("B7: dot-path exclude strips the nested value on client reads", () => {
  reset();
  const accounts = cell("b7-accounts", {
    state: { accounts: [{ name: "a", encSecKey: "s3cret" }] },
    methods: {},
    visible: { exclude: ["accounts.encSecKey"] },
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
    visible: { include: ["publicCount"] },
  });
  bindCellReactive(stats);
  const s = stats as unknown as {
    publicCount: number;
    internalBuffer?: string;
  };
  assertEquals(s.publicCount, 1);
  const msg = assertHiddenThrows(
    "b7-stats.internalBuffer",
    () => s.internalBuffer,
  );
  assert(msg.includes("visible.include"), `names include-mode cause: ${msg}`);
  reset();
});

Deno.test('B7: ui "none" hides every field on client reads', () => {
  reset();
  const internal = cell("b7-internal", {
    state: { queue: [1, 2] },
    methods: {},
    visible: "none",
  });
  bindCellReactive(internal);
  assertHiddenThrows(
    "b7-internal.queue",
    () => (internal as unknown as { queue?: unknown }).queue,
  );
  reset();
});

Deno.test("B7: selectors in client context see the FILTERED slice (no leak)", () => {
  reset();
  const vault = cell("b7-vault", {
    state: { items: ["a"], masterKey: "k" },
    methods: {},
    visible: { exclude: ["masterKey"] },
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
  // Not leaking is half the contract; SAYING SO is the other half. This test
  // once asserted only the undefined — the same silent `undefined`-as-data
  // trap the direct-read seam throws about — so a selector was the one client
  // read that could quietly fabricate an answer.
  assertEquals(v.count(), 2, "selector over visible fields works");
  const msg = assertHiddenThrows("b7-vault.masterKey", () => v.leak());
  assert(msg.includes("visible.exclude"), "and say why");
  reset();
});

Deno.test('B7: a selector on a ui:"none" cell throws instead of computing over {}', () => {
  reset();
  // `filterSlice` hands a fully hidden cell an EMPTY object, and the selector
  // computed over it: `total()` returned NaN and `count()` returned 0 —
  // plausible numbers, entirely fabricated — while `cell.balance` on the very
  // same cell threw. One seam, two loudness rules.
  const secret = cell("b7-none", {
    state: { balance: 100, items: [1, 2, 3] },
    methods: {},
    visible: "none",
    selectors: {
      total: (s: { balance: number; items: number[] }) => s.balance * 2,
      count: (s: { balance: number; items: number[] }) =>
        (s.items ?? []).length,
      constant: () => 42, // reads nothing hidden → must stay silent
    },
  });
  bindCellReactive(secret);
  const c = secret as unknown as {
    total: () => number;
    count: () => number;
    constant: () => number;
  };
  assertHiddenThrows("b7-none.balance", () => c.total());
  assertHiddenThrows("b7-none.items", () => c.count());
  const { warnings } = withWarnCapture(() => {
    assertEquals(c.constant(), 42, "a selector reading nothing hidden works");
  });
  assertEquals(
    warnings.filter((w) => w.includes("b7-none.constant")).length,
    0,
    "a selector that touches no hidden field stays quiet",
  );
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
    visible: { exclude: ["pins"] },
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
    visible: { exclude: ["apiSecret"] },
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
  const v = vault as unknown as { items: string[]; apiSecret?: string };
  assertEquals(v.items, ["x"], "visible field live through the local loop");
  assertHiddenThrows("b7-standalone.apiSecret", () => v.apiSecret);
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
    visible: { exclude: ["member"] },
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

// a field report #3 — the warning was the ONLY signal, and a warning does not
// stop the read from type-checking as the field's declared type: a lock screen
// asked "does a vault exist?", got `undefined` from a ui.exclude'd verifier, and
// branched on it as data. Dev threw first; prod kept degrading to `undefined`
// — and prod is exactly where the warning scrolls past. One rule now: throw.
Deno.test("B7: a hidden read THROWS in dev AND in prod — the mirrored fact field still reads", () => {
  reset();
  const seeds = cell("b7-dev-seeds", {
    state: { hasVault: true, vaultCheck: "secret" },
    methods: {},
    visible: { exclude: ["vaultCheck"] },
  });
  bindCellReactive(seeds);
  const s = seeds as unknown as { hasVault: boolean; vaultCheck?: unknown };
  try {
    const msg = assertHiddenThrows(
      "b7-dev-seeds.vaultCheck",
      () => s.vaultCheck,
    );
    // Assert against THE vocabulary, not a literal: the message must name the
    // side the read came from, whatever words that side is currently spelled
    // with (src/diagnostics/contexts.ts).
    assert(msg.includes(SIDE.client), msg);
    assertEquals(s.hasVault, true, "the mirrored non-secret fact still reads");
  } finally {
    reset();
  }
});

// a field report, first field result of the dev-throw: aio tripped its OWN guard.
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
    visible: { exclude: ["vaultCheck"] },
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

Deno.test("B7: a DEEP excluded field read is loud — throws in dev and prod, spreads stay quiet", () => {
  // The alpha40 dev-throw covered top-level excludes; a dot-path exclude
  // still read as a clean `undefined` in every environment — the same
  // "undefined as data" trap, one level down. The stripped parent now carries
  // a non-enumerable reporting getter at the hidden name.
  reset();
  const wallet = cell("b7-deep-loud", {
    state: { accounts: [{ name: "a", encSecKey: "s3cret" }] },
    methods: {},
    visible: { exclude: ["accounts.encSecKey"] },
  });
  bindCellReactive(wallet);
  const list =
    (wallet as unknown as { accounts: Record<string, unknown>[] }).accounts;

  const msg = assertHiddenThrows(
    "b7-deep-loud.accounts.encSecKey",
    () => list[0]!.encSecKey,
  );
  assert(msg.includes("visible.exclude"), msg);
  assert(msg.includes("hasEncSecKey: boolean"), `fix names the LEAF: ${msg}`);

  // Spreads / keys / JSON of the parent never trip it — only the named read.
  assertEquals(Object.keys(list[0]!), ["name"]);
  assertEquals(JSON.stringify(list[0]), '{"name":"a"}');
  reset();
});
