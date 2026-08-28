// alpha52 — the surface diet + safety defaults (Package 4).
//
// Pins, per break, BOTH halves of the contract: the new spelling WORKS (and
// is enforced — mutation-style assertions on real composition output, not on
// config echoes), and the old spelling still works through beta with a
// one-time hint — or, where removed (useCell, call({timeout})), fails LOUD.
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { cell } from "../src/state/cell.ts";
import type { Access, StateOf } from "../mod.ts";
import { composeCellsWiring } from "../src/server/aio-composition.ts";
import { defaultAppKeyConfig, resolveAppKey } from "../src/server/app-key.ts";
import { call } from "../src/state/cell-impl.ts";
import { AIO_ENTRY_PATHS, SERVER_ONLY_AIO_SYMBOLS } from "../src/entries.ts";
import { checkPlatformSafety } from "../src/server/graph-validator.ts";
import { freePort } from "../src/testing/cell-test.ts";

// ── helper: capture console.warn (the browser-graph hint channel) ────────
function captureWarn<T>(fn: () => T): { result: T; warns: string[] } {
  const warns: string[] = [];
  const orig = console.warn;
  console.warn = (...args: unknown[]) => warns.push(args.join(" "));
  try {
    return { result: fn(), warns };
  } finally {
    console.warn = orig;
  }
}

let n = 0;
const uname = (base: string) => `${base}-a52-${++n}`;

// ═════════════════════════════════════════════════════════════════════
// 1. cell `ui:` → `visible:`
// ═════════════════════════════════════════════════════════════════════

Deno.test("visible: is the ui filter — ENFORCED through composition, not just stored", () => {
  const name = uname("vis");
  const c = cell(name, {
    state: { a: 1, secretThing: 2 },
    methods: {},
    visible: { exclude: ["secretThing"] },
  });
  assertEquals(c.__aio.ui, { exclude: ["secretThing"] });
  // Mutation check: the composed getUIState actually strips the field.
  const { autoGetUIState } = composeCellsWiring({ cellEntries: [c] });
  const out = autoGetUIState!(
    { [name]: { a: 1, secretThing: 2 } },
  ) as Record<string, Record<string, unknown>>;
  assertEquals(out[name], { a: 1 });
});

Deno.test('visible: "none" hides the whole cell from clients', () => {
  const name = uname("vis-none");
  const c = cell(name, {
    state: { a: 1 },
    methods: {},
    visible: "none",
  });
  const { autoGetUIState, cellPatchStrategies } = composeCellsWiring({
    cellEntries: [c],
  });
  assertEquals(cellPatchStrategies.get(name), "skip");
  const out = autoGetUIState!({ [name]: { a: 1 } }) as Record<string, unknown>;
  assertEquals(out[name], undefined);
});

Deno.test("visible: forUser + publicFields flow exactly like the old ui shape", () => {
  const name = uname("vis-fu");
  const c = cell(name, {
    state: { rows: [1, 2, 3], pubKeyData: "x" },
    methods: {},
    visible: {
      publicFields: ["pubKeyData"],
      forUser: (exposed, user) => ({
        ...exposed,
        rows: user?.role === "admin" ? exposed.rows : [],
      }),
    },
  });
  assert(c.__aio.uiForUser, "forUser extracted");
  assertEquals(c.__aio.uiPublicFields, ["pubKeyData"]);
  const { autoGetUIState } = composeCellsWiring({ cellEntries: [c] });
  const state = { [name]: { rows: [1, 2, 3], pubKeyData: "x" } };
  const admin = autoGetUIState!(state, { id: "a", role: "admin" }) as Record<
    string,
    { rows: number[] }
  >;
  const anon = autoGetUIState!(state, undefined) as Record<
    string,
    { rows: number[] }
  >;
  assertEquals(admin[name]!.rows, [1, 2, 3]);
  assertEquals(anon[name]!.rows, []);
});

// `ui:` → `visible:` is REMOVED in alpha70 (dev refuses, prod logs and
// honours): tests/alpha70-retirements.test.ts pins both halves.

Deno.test("visible + ui both set is a HARD error at cell() — one decision, two spellings", () => {
  assertThrows(
    () =>
      cell(uname("both"), {
        state: { a: 1 },
        methods: {},
        visible: "all",
        // deno-lint-ignore no-explicit-any
        ...({ ui: "none" } as any),
      }),
    Error,
    "both `visible` and `ui`",
  );
});

Deno.test("visible: filter validation fails loud with the NEW vocabulary", () => {
  const err = assertThrows(
    () =>
      cell(uname("vis-bad"), {
        state: { a: 1 },
        methods: {},
        // deno-lint-ignore no-explicit-any
        visible: { exclude: ["typo"] } as any,
      }),
    Error,
  ) as Error;
  assert(err.message.includes("visible exclude"), err.message);
});

// ═════════════════════════════════════════════════════════════════════
// 1b. cellDefaults.visible — FULL CellVisibility as an app-wide default
// ═════════════════════════════════════════════════════════════════════

Deno.test("cellDefaults.visible takes forUser — previously unsettable as a default — and it RUNS", () => {
  const a = cell(uname("dflt"), { state: { x: 1, hidden: 9 }, methods: {} });
  const decided = cell(uname("dflt-decided"), {
    state: { y: 2 },
    methods: {},
    visible: "none",
  });
  const { autoGetUIState } = composeCellsWiring({
    cellEntries: [a, decided],
    cellDefaults: {
      visible: {
        forUser: (exposed) => ({ ...exposed, hidden: 0 }),
      },
    },
  });
  const aName = a.__aio.id;
  const dName = decided.__aio.id;
  const out = autoGetUIState!({
    [aName]: { x: 1, hidden: 9 },
    [dName]: { y: 2 },
  }, { id: "u", role: "user" }) as Record<string, Record<string, unknown>>;
  // Default forUser applied to the undecided cell (mutation: value rewritten)…
  assertEquals(out[aName], { x: 1, hidden: 0 });
  // …and the cell that decided (visible: "none") is untouched by the default.
  assertEquals(out[dName], undefined);
});

Deno.test("cellDefaults: visible + ui both set throws (the `ui` spelling alone is alpha70's row)", () => {
  const b = cell(uname("dflt-both"), { state: { x: 1 }, methods: {} });
  assertThrows(
    () =>
      composeCellsWiring({
        cellEntries: [b],
        // deno-lint-ignore no-explicit-any
        cellDefaults: { visible: "all", ...({ ui: "all" } as any) },
      }),
    Error,
    "both `visible` and `ui`",
  );
});

// ═════════════════════════════════════════════════════════════════════
// 2. `key` default under expose
// ═════════════════════════════════════════════════════════════════════

Deno.test("key default: exposed + no auth + key undecided → behaves as key: true", () => {
  // THE decision matrix, pinned on the pure decider aio.run() uses.
  const d = (expose: boolean, perUserAuth: boolean, key?: string | boolean) =>
    defaultAppKeyConfig({ expose, perUserAuth, key });
  assertEquals(d(true, false, undefined), { key: true, defaulted: true });
  // explicit opt-out stays open
  assertEquals(d(true, false, false), { key: false, defaulted: false });
  // fixed and explicit-true untouched
  assertEquals(d(true, false, "s3cret"), { key: "s3cret", defaulted: false });
  assertEquals(d(true, false, true), { key: true, defaulted: false });
  // per-user auth: never defaulted (the key would gate nothing / be refused)
  assertEquals(d(true, true, undefined), { key: undefined, defaulted: false });
  // loopback unchanged
  assertEquals(d(false, false, undefined), {
    key: undefined,
    defaulted: false,
  });
});

Deno.test("key default: the defaulted `true` resolves to a persisted, owner-only key", () => {
  const tmp = Deno.makeTempDirSync({ prefix: "aio-keydef-" });
  const prev = Deno.env.get("AIO_APPS_DIR");
  Deno.env.set("AIO_APPS_DIR", tmp);
  try {
    const { key } = defaultAppKeyConfig({
      expose: true,
      perUserAuth: false,
      key: undefined,
    });
    const r = resolveAppKey("keydef-app", key);
    assert(r.key && r.key.length > 0, "a key is generated");
    assertEquals(r.persisted, true);
    // 0600 — the share link may carry it, the filesystem must not.
    const path = join(tmp, "keydef-app", "data", "app.key");
    const st = Deno.statSync(path);
    if (st.mode !== null && Deno.build.os !== "windows") {
      assertEquals(st.mode & 0o077, 0, "app.key is owner-only");
    }
    // stable across restarts ("one key, use forever")
    assertEquals(resolveAppKey("keydef-app", key).key, r.key);
  } finally {
    if (prev === undefined) Deno.env.delete("AIO_APPS_DIR");
    else Deno.env.set("AIO_APPS_DIR", prev);
    Deno.removeSync(tmp, { recursive: true });
  }
});

// ═════════════════════════════════════════════════════════════════════
// 3. `access` without `visible` REFUSES on exposed / multi-user apps
// ═════════════════════════════════════════════════════════════════════

Deno.test({
  name:
    "access-no-visible: multi-user app REFUSES to boot, names the one-word fix",
  fn: async () => {
    const { aio } = await import("../mod.ts");
    const c = cell(uname("acc-multi"), {
      state: { rows: [] as string[] },
      methods: {},
      access: "admin",
    });
    const base = await Deno.makeTempDir();
    const err = await assertRejects(
      () =>
        aio.run({
          cells: [c],
          appId: "a52-acc-multi",
          client: "server-only",
          persist: false,
          singleton: false,
          port: freePort(),
          baseDir: base,
          users: { tok: { id: "u1", role: "admin" } },
        }),
      Error,
    );
    assert(err.message.includes("refusing to start"), err.message);
    assert(err.message.includes('visible: "all"'), err.message);
  },
});

Deno.test({
  name:
    "access-no-visible: exposed app REFUSES to boot (before any socket opens)",
  fn: async () => {
    const { aio } = await import("../mod.ts");
    const c = cell(uname("acc-exp"), {
      state: { rows: [] as string[] },
      methods: {},
      access: false,
    });
    const base = await Deno.makeTempDir();
    const err = await assertRejects(
      () =>
        aio.run({
          cells: [c],
          appId: "a52-acc-exposed",
          client: "server-only",
          persist: false,
          singleton: false,
          port: freePort(),
          baseDir: base,
          expose: true,
        }),
      Error,
    );
    assert(err.message.includes("refusing to start"), err.message);
  },
});

Deno.test({
  name:
    "access-no-visible: loopback single-user stays a WARNING — the app boots",
  fn: async () => {
    const { aio } = await import("../mod.ts");
    const c = cell(uname("acc-loop"), {
      state: { rows: [] as string[] },
      methods: {},
      access: "admin",
    });
    const app = await aio.run({
      cells: [c],
      appId: "a52-acc-loopback",
      client: "server-only",
      persist: false,
      singleton: false,
      port: freePort(),
      baseDir: await Deno.makeTempDir(),
    });
    try {
      assert(app, "boots on loopback — dev tool must not brick");
    } finally {
      await app.close();
    }
  },
});

Deno.test({
  name: 'access + visible: "all" (the acknowledgement) boots even multi-user',
  fn: async () => {
    const { aio } = await import("../mod.ts");
    const c = cell(uname("acc-ack"), {
      state: { rows: [] as string[] },
      methods: {},
      access: "admin",
      visible: "all",
    });
    const app = await aio.run({
      cells: [c],
      appId: "a52-acc-ack",
      client: "server-only",
      persist: false,
      singleton: false,
      port: freePort(),
      baseDir: await Deno.makeTempDir(),
      users: { tok: { id: "u1", role: "admin" } },
    });
    try {
      assert(app);
    } finally {
      await app.close();
    }
  },
});

// ═════════════════════════════════════════════════════════════════════
// 4. Entry diet
// ═════════════════════════════════════════════════════════════════════

Deno.test("entry diet: aio/schedule and aio/selectors are DELETED entries", () => {
  assertEquals(AIO_ENTRY_PATHS["aio/schedule"], undefined);
  assertEquals(AIO_ENTRY_PATHS["aio/selectors"], undefined);
});

Deno.test("entry diet: aio/server carries the DB runtime values", async () => {
  const server = await import("../src/server-entry.ts");
  for (
    const sym of [
      "createDB",
      "DEFAULT_PRAGMAS",
      "initSchema",
      "loadTables",
      "syncTables",
      "reactiveDB",
    ]
  ) {
    assert(
      (server as Record<string, unknown>)[sym] !== undefined,
      `aio/server exports ${sym}`,
    );
  }
});

Deno.test("entry diet: aio/extras carries isScheduleEffect + createSliceSelector + checkCells", async () => {
  const extras = await import("../src/extras/mod.ts");
  assertEquals(typeof extras.isScheduleEffect, "function");
  assertEquals(typeof extras.createSliceSelector, "function");
  assertEquals(typeof extras.checkCells, "function");
  // the `lint` alias went out in alpha70 (tests/alpha70-surface.test.ts)
  assertEquals((extras as Record<string, unknown>)["lint"], undefined);
});

// (aio/db's deprecated value re-exports went out in alpha70 — the entry is
// types-only now; pinned in tests/alpha70-surface.test.ts.)

Deno.test("call({ timeout }) is REMOVED — throws loud, names the rename", async () => {
  assertThrows(
    // deno-lint-ignore no-explicit-any
    () => call({ timeout: 5 } as any, () => Promise.resolve(1)),
    Error,
    "timeoutMs",
  );
  // the canonical spelling works
  assertEquals(await call({ timeoutMs: 1000 }, () => Promise.resolve(7)), 7);
});

Deno.test("useCell is gone from the public aio/air surface", async () => {
  const air = await import("../src/air.ts");
  assertEquals(
    (air as Record<string, unknown>)["useCell"],
    undefined,
    "aio/air must not export useCell (removed alpha52)",
  );
});

// ═════════════════════════════════════════════════════════════════════
// 5. Renames (type-level pins compile-checked here)
// ═════════════════════════════════════════════════════════════════════

Deno.test("renames: Access is the one access type; StateOf the one state-extractor (aliases gone in alpha70)", async () => {
  // Type-level: assignability in BOTH directions (aliases, not lookalikes).
  const rule: Access = (user, method) =>
    user?.role === "admin" && method !== "nuke";
  assert(typeof rule === "function");
  const { serverFns } = await import("../src/server/server-fns.ts");
  assert(typeof serverFns === "function"); // Access accepted in its opts type

  const c = cell(uname("types"), {
    state: { count: 0 },
    methods: {},
    scope: "server", // alpha52: the default, now statable
  });
  type S1 = StateOf<typeof c>;
  const s1: S1 = { count: 1 };
  assertEquals(s1.count, 1);

  // aio.run<S> typed overload (alpha52, additive): app.getState() is S.
  const { aio } = await import("../mod.ts");
  type AppState = { counter: { count: number } };
  type TypedApp = Awaited<ReturnType<typeof aio.run<AppState>>>;
  const _read: (a: TypedApp) => number = (a) => a.getState().counter.count;
  assert(typeof _read === "function");
});

Deno.test("renames: testGen is the name (the testgen alias went out in alpha70)", async () => {
  const t = await import("../src/testing/ui-testgen.ts");
  assertEquals(typeof t.testGen, "function");
  assertEquals((t as Record<string, unknown>)["testgen"], undefined);
});

Deno.test("renames: air NodeAction is the one name (the bare `Action` alias went out in alpha70)", async () => {
  const mod = await import("../src/air/vdom-types.ts");
  assert(mod, "module loads");
  const na: import("../src/air/vdom-types.ts").NodeAction = () => {};
  assert(typeof na === "function");
  // The alias is gone from the SOURCE, not just undocumented.
  const src = await Deno.readTextFile("src/air/vdom-types.ts");
  assert(
    !/export type Action\b/.test(src),
    "vdom-types still exports `Action`",
  );
});

// ═════════════════════════════════════════════════════════════════════
// 6. SERVER_ONLY_AIO_SYMBOLS — one decider
// ═════════════════════════════════════════════════════════════════════

Deno.test("server-only symbols: ONE set drives the graph validator (incl. the alpha52 db additions)", () => {
  // The set carries the db runtime values now that aio/db is types-only.
  for (
    const sym of ["createDB", "reactiveDB", "initSchema", "connectCli"]
  ) {
    assert(SERVER_ONLY_AIO_SYMBOLS.has(sym), `${sym} in the shared set`);
  }
  // Mutation check: the validator FLAGS every symbol in the shared set — so a
  // symbol added to the set is enforced without touching the validator.
  for (const sym of SERVER_ONLY_AIO_SYMBOLS) {
    const src = sym.startsWith("connect")
      ? `import { ${sym} } from "aio";\nexport const x = ${sym};\n`
      : `import { ${sym} } from "aio/db";\nexport const x = ${sym};\n`;
    const errors = checkPlatformSafety(src, "src/cell.ts");
    assert(
      errors.some((e) =>
        e.category === "server-only-import" && e.message.includes(sym)
      ),
      `graph validator flags ${sym}`,
    );
  }
});
