// `visible.forUser` is ONE rule with three readers, and they must agree.
//
//   A. `forUserView` (src/state/cell-reactive.ts) — the pure decision, used by
//      testUI's client view.
//   B. `autoGetUIState` (src/server/aio-composition.ts) — the BROADCAST, what a
//      socket actually carries. Authoritative: it is the wire.
//   C. the headless render behind `am surface` / `am preview`
//      (src/server/server-surface.ts) — what a client with no user renders.
//
// Each used to carry its own copy of the fail-closed rules (a filter that
// throws, returns a Promise, or returns a non-object has decided nothing, so
// the cell is omitted). Three copies of a security rule drift the day one is
// edited, so this pins them against each other over the whole case matrix:
// structural filter × filter behaviour × user. Compared as a client can
// observe it: the declared keys a client's getters answer, or "omitted" (a
// client with no slice reads declared state).
import { assert, assertEquals } from "@std/assert";
import { cell } from "../src/state/cell-create.ts";
import { forUserView } from "../src/state/cell-reactive.ts";
import { applyCellFieldFilter } from "../src/state/state-filter.ts";
import { bindCell } from "../src/state/cell-catalog.ts";
import { composeCellsWiring } from "../src/server/aio-composition.ts";
import { renderHeadlessSurface } from "../src/server/server-surface.ts";
import { _resetAioRuntime } from "../src/state/runtime-reset.ts";
import { getLogger, setLogger } from "../src/diagnostics/logger.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import type { AccessUser, CellFieldFilter } from "../src/state/cell-types.ts";

type Slice = Record<string, unknown>;
type Row = { owner: string; v: string };

const REPO = new URL("..", import.meta.url).pathname;

const DECLARED = {
  theme: "light",
  secret: "",
  rows: [] as Row[],
  profile: { name: "", key: "" },
};
const LIVE = {
  theme: "dark",
  secret: "s3cr3t",
  rows: [{ owner: "u1", v: "one" }, { owner: "u2", v: "two" }],
  profile: { name: "ada", key: "deep" },
};

const STRUCTURAL: Record<string, CellFieldFilter | undefined> = {
  all: undefined,
  include: { include: ["theme", "rows", "profile"] },
  exclude: { exclude: ["secret"] },
  deepExclude: { exclude: ["secret", "profile.key"] },
};

// deno-lint-ignore no-explicit-any
type Filter = (s: any, u?: AccessUser) => any;
const FILTERS: Record<string, Filter | undefined> = {
  none: undefined,
  identity: (s) => s,
  perUser: (s, u) => ({
    ...s,
    rows: (s.rows ?? []).filter((r: Row) => r.owner === u?.id),
  }),
  mutateAndReturn: (s) => {
    s.theme = "mutated";
    return s;
  },
  empty: () => ({}),
  throws: () => {
    throw new TypeError("boom");
  },
  throwsWithoutUser: (s, u) => ({ ...s, who: u!.id }),
  returnsUndefined: () => undefined,
  returnsNull: () => null,
  returnsArray: (s) => [s],
  returnsString: () => "nope",
  async: (s) => Promise.resolve(s),
  asyncRejects: () => Promise.reject(new Error("async boom")),
  thenable: () => ({ then() {} }),
};

const USERS: Record<string, AccessUser | undefined> = {
  anonymous: undefined,
  u1: { id: "u1", role: "user" } as AccessUser,
  u2: { id: "u2", role: "user" } as AccessUser,
};

type Seen = { omitted: true } | { keys: Slice };

/** What a client's declared-key getters answer for a view (or its absence). */
function observe(
  structural: CellFieldFilter | undefined,
  view: Slice | undefined,
): Seen {
  if (!view) return { omitted: true };
  const visibleTop = structural && typeof structural === "object"
    ? "include" in structural ? new Set(structural.include) : new Set(
      Object.keys(DECLARED).filter((k) =>
        !(structural as { exclude: string[] }).exclude.includes(k)
      ),
    )
    : new Set(Object.keys(DECLARED));
  const keys: Slice = {};
  for (const k of Object.keys(DECLARED)) {
    if (visibleTop.has(k)) keys[k] = view[k];
  }
  return { keys: JSON.parse(JSON.stringify(keys)) };
}

const cases: {
  id: string;
  structural: CellFieldFilter | undefined;
  forUser: Filter | undefined;
  // deno-lint-ignore no-explicit-any
  def: any;
}[] = [];
for (const [sName, structural] of Object.entries(STRUCTURAL)) {
  for (const [fName, forUser] of Object.entries(FILTERS)) {
    const id = `fudiff-${sName}-${fName}`;
    const visible = {
      ...(structural && typeof structural === "object" ? structural : {}),
      ...(forUser ? { forUser } : {}),
    };
    cases.push({
      id,
      structural,
      forUser,
      // Built from a runtime matrix, so the literal-key typing cannot see it.
      // deno-lint-ignore no-explicit-any
      def: (cell as any)(id, {
        state: structuredClone(DECLARED),
        ...(Object.keys(visible).length ? { visible } : {}),
        methods: { noop() {} },
      }),
    });
  }
}

/** Swallow the fail-closed logs (they are the point, not noise to assert on
 *  here — foruser-leak.test.ts pins their wording). */
async function quietly<T>(fn: () => Promise<T> | T): Promise<T> {
  const prev = getLogger();
  setLogger(
    {
      logDir: "",
      pub: () => {},
      perf: () => {},
      flush: () => Promise.resolve(),
      // deno-lint-ignore no-explicit-any
    } as any,
  );
  try {
    return await fn();
  } finally {
    setLogger(prev);
  }
}

/** A. the pure decision, over the structural slice exactly as the broadcast
 *  builds it. */
function viaForUserView(
  c: (typeof cases)[number],
  user: AccessUser | undefined,
): Seen {
  const structural = applyCellFieldFilter(
    c.def.__aio.ui ?? "all",
    structuredClone(LIVE),
  )!;
  if (!c.forUser) return observe(c.structural, structural);
  // A REJECTING async filter goes through as-is: the pure rule observes the
  // returned Promise, so it cannot escape here either (pinned below).
  const out = forUserView(c.id, c.forUser as never, structural, user);
  return observe(c.structural, "view" in out ? out.view : undefined);
}

/** B. the broadcast. */
function viaBroadcast(
  c: (typeof cases)[number],
  user: AccessUser | undefined,
): Seen {
  const wiring = composeCellsWiring({ cellEntries: [c.def] });
  const live = { [c.id]: structuredClone(LIVE) };
  const ui = wiring.autoGetUIState!(live, user) as Slice;
  // A filter must never write through to the server's state.
  assertEquals(live[c.id], LIVE, `${c.id}: forUser mutated server state`);
  return observe(c.structural, ui[c.id] as Slice | undefined);
}

Deno.test("forUser: forUserView and the broadcast decide identically, every case × user", async () => {
  await quietly(async () => {
    const rows = cases.flatMap((c) =>
      Object.entries(USERS).map(([uName, user]) => ({
        at: `${c.id} as ${uName}`,
        forUserView: JSON.stringify(viaForUserView(c, user)),
        broadcast: JSON.stringify(viaBroadcast(c, user)),
      }))
    );
    assertEquals(rows.length, cases.length * Object.keys(USERS).length);
    const mismatches = rows.filter((r) => r.forUserView !== r.broadcast);
    // Let a rejected async filter's Promise settle INSIDE this test.
    await new Promise((r) => setTimeout(r, 0));
    assertEquals(mismatches, []);
  });
  _resetAioRuntime();
});

Deno.test("forUser: the matrix is not vacuous — each fail-closed branch really omits", async () => {
  await quietly(async () => {
    const byName = (s: string, f: string) =>
      cases.find((c) => c.id === `fudiff-${s}-${f}`)!;
    for (
      const f of [
        "throws",
        "returnsUndefined",
        "returnsNull",
        "returnsArray",
        "returnsString",
        "async",
        "asyncRejects",
        "thenable",
      ]
    ) {
      assertEquals(viaBroadcast(byName("all", f), USERS.u1), { omitted: true });
    }
    assertEquals(viaBroadcast(byName("all", "throwsWithoutUser"), undefined), {
      omitted: true,
    });
    const u1 = viaBroadcast(byName("exclude", "perUser"), USERS.u1);
    assert("keys" in u1);
    assertEquals(u1.keys.rows, [{ owner: "u1", v: "one" }]);
    assertEquals("secret" in u1.keys, false);
    const deep = viaBroadcast(byName("deepExclude", "identity"), USERS.u1);
    assert("keys" in deep);
    assertEquals(deep.keys.profile, { name: "ada" });
    await new Promise((r) => setTimeout(r, 0));
  });
  _resetAioRuntime();
});

Deno.test("forUser: the headless render (am surface) agrees with the broadcast for a user-less client", async () => {
  const dir = await tempDir("foruser-diff-");
  try {
    // The render reads cells through the swapped client accessors; the
    // component just reports what each declared key answers.
    await Deno.writeTextFile(
      `${dir}/App.ts`,
      `import { h } from "${REPO}src/air/vdom.ts";
export default function App() {
  const g = globalThis as any;
  const def = g.__fudiffDef;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(g.__fudiffDeclared)) {
    try { out[k] = def[k]; } catch { /* hidden */ }
  }
  g.__fudiffOut = JSON.parse(JSON.stringify(out));
  return h("p", null, "ok");
}
`,
    );
    for (const c of cases) {
      bindCell(c.def, () => Promise.resolve(), () => ({ [c.id]: LIVE }));
    }
    const g = globalThis as Record<string, unknown>;
    g.__fudiffDeclared = DECLARED;
    const rows: { at: string; surface: string; broadcast: string }[] = [];
    await quietly(async () => {
      for (const c of cases) {
        g.__fudiffDef = c.def;
        g.__fudiffOut = undefined;
        const r = await renderHeadlessSurface(`${dir}/App.ts`);
        assert(r.ok, !r.ok ? `${c.id}: ${r.error}` : "");
        const read = g.__fudiffOut as Slice;
        // A client the cell was omitted for reads DECLARED state. `theme` is
        // visible under every structural filter and no filter in the matrix
        // sets it back to its declared value, so a declared `theme` and
        // declared `rows` together mean omission.
        const seen: Seen = read.theme === DECLARED.theme &&
            JSON.stringify(read.rows) === "[]"
          ? { omitted: true }
          : observe(c.structural, read);
        rows.push({
          at: c.id,
          surface: JSON.stringify(seen),
          broadcast: JSON.stringify(viaBroadcast(c, undefined)),
        });
      }
      await new Promise((r) => setTimeout(r, 0));
    });
    assertEquals(rows.length, cases.length);
    const mismatches = rows.filter((r) => r.surface !== r.broadcast);
    assertEquals(mismatches, []);
  } finally {
    delete (globalThis as Record<string, unknown>).__fudiffDef;
    delete (globalThis as Record<string, unknown>).__fudiffOut;
    delete (globalThis as Record<string, unknown>).__fudiffDeclared;
    await dropTempDir(dir);
    _resetAioRuntime();
  }
});

// MEASURED before the rule observed the Promise: an `async` filter that
// rejects failed this file with "error: (in promise) Error: async boom … not
// caught from a test".
// In a server without `guardDispatches` that unhandled rejection exits the
// process the first time a client is sent the cell.
Deno.test("forUser: a REJECTING async filter omits the cell and never escapes as an unhandled rejection", async () => {
  const c = cases.find((x) => x.id === "fudiff-all-asyncRejects")!;
  const escaped: unknown[] = [];
  const onRejection = (e: PromiseRejectionEvent) => {
    escaped.push(e.reason);
    e.preventDefault();
  };
  globalThis.addEventListener("unhandledrejection", onRejection);
  try {
    await quietly(async () => {
      assertEquals(viaBroadcast(c, USERS.u1), { omitted: true });
      assertEquals(viaBroadcast(c, undefined), { omitted: true });
      // Two macrotask turns: an unobserved rejection is reported after the
      // microtask queue drains.
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
    });
    assertEquals(escaped, []);
  } finally {
    globalThis.removeEventListener("unhandledrejection", onRejection);
    _resetAioRuntime();
  }
});
