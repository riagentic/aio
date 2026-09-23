// A composed app's state reaches a store only through ONE filter.
//
// 1.0.7-beta's standalone runtime wrote the whole composed state
// (`getDBState = (s) => s`), so a `persist: "none"` cell was fsync'd to the
// phone and restored on the next launch while `deno task dev` dropped it.
// `scripts/check-persist-decider.ts` is the static guard that a NEW host cannot
// be written that way: hosts are found from `composeCells(` call sites, never
// from a list. The runtime lane (`test:hosts`) proves the existing hosts drop
// the slice end to end; this proves nobody can add one that skips the rule.
import { assertEquals } from "@std/assert";
import {
  check,
  type Finding,
  readSrc,
  report,
  type Source,
} from "../scripts/check-persist-decider.ts";

const REPO = new URL("../", import.meta.url).pathname;

Deno.test("persist-decider: src/ is clean — every host routes through cell-persist-filter.ts", async () => {
  const findings = check(await readSrc(REPO));
  assertEquals(findings, [], "\n" + report(findings));
});

// ── fixtures: the REAL check over in-memory sources ─────────────────────────

const FILTER: Source = {
  path: "src/state/cell-persist-filter.ts",
  src: `export function persistingCellIds(c) { return new Set(c.cells` +
    `.filter((f) => (f.__aio.persist ?? "all") !== "none")); }\n` +
    `export function buildDBStateGetter(c) { return (s) => s; }\n`,
};

const rules = (fs: Finding[]) => fs.map((f) => `${f.file}|${f.rule}`);

Deno.test("persist-decider: the 1.0.7 shape — a host that composes and writes the whole state — is RED twice", () => {
  const host: Source = {
    path: "src/new-host.ts",
    src: `import { composeCells } from "./state/cell-compose.ts";
export function boot(cells) {
  const composed = composeCells(cells, {});
  const getDBState = (s) => s;
  store.write("k", JSON.stringify(getDBState(composed.initialState)));
}`,
  };
  assertEquals(rules(check([FILTER, host])), [
    "src/new-host.ts|host",
    "src/new-host.ts|whole-state",
  ]);
});

Deno.test("persist-decider: a host that calls BOTH deciders is green; one half alone is red", () => {
  const both: Source = {
    path: "src/ok-host.ts",
    src: `const c = composeCells(cells);
init({ getDBState: buildDBStateGetter(c), restorable: persistingCellIds(c) });`,
  };
  const writeOnly: Source = {
    path: "src/half-host.ts",
    src: `const c = composeCells(cells);
init({ getDBState: buildDBStateGetter(c) });`,
  };
  assertEquals(check([FILTER, both]), []);
  const f = check([FILTER, writeOnly]);
  assertEquals(rules(f), ["src/half-host.ts|host"]);
  assertEquals(f[0]!.detail.includes("persistingCellIds"), true);
});

Deno.test("persist-decider: a comment or string NAMING the filter is not a call to it", () => {
  const liar: Source = {
    path: "src/liar.ts",
    src: `// uses buildDBStateGetter(c) and persistingCellIds(c), honest
const note = "buildDBStateGetter(x) persistingCellIds(x)";
const c = composeCells(cells);`,
  };
  assertEquals(rules(check([FILTER, liar])), ["src/liar.ts|host"]);
});

Deno.test("persist-decider: composeCells(...).initialState is a value read, not a host", () => {
  const preview: Source = {
    path: "src/preview.ts",
    src: `const state = composeCells(cells, { appId: "p" }).initialState;`,
  };
  assertEquals(check([FILTER, preview]), []);
});

Deno.test("persist-decider: a scoped marker justifies a host; a marker for another gate does not", () => {
  const ok: Source = {
    path: "src/replica.ts",
    src: `// aio-ok(persist-decider): a replica, the owner persists it
const c = composeCells([cell]);`,
  };
  const wrongGate: Source = {
    path: "src/replica2.ts",
    src: `// aio-ok(silent-catch): unrelated
const c = composeCells([cell]);`,
  };
  assertEquals(check([FILTER, ok]), []);
  assertEquals(rules(check([FILTER, wrongGate])), ["src/replica2.ts|host"]);
});

Deno.test("persist-decider: every identity spelling of a DB-state slot is whole-state", () => {
  const src: Source = {
    path: "src/slots.ts",
    src: `const a = cfg._getDBState ?? ((s: S) => s);
const b = cfg.getDBState || ((x) => x as unknown);
const o = { getDBState: (s) => s };
const kvGetDBState = (state) => state;
const fine = cfg.getDBState ?? ((s) => s.only);
const alsoFine = { getDBState: buildDBStateGetter(c) };
const m = { getDBState(s) { return s; } };
function getDBState(state: S): unknown { return state as unknown; }
const okM = { getDBState(s) { return s.only; } };`,
  };
  assertEquals(check([FILTER, src]).map((f) => f.line), [1, 2, 3, 4, 7, 8]);
});

Deno.test("persist-decider: the reader sees every function spelling, and none of the non-identities", () => {
  const src: Source = {
    path: "src/spellings.ts",
    src: `const a = { getDBState: s => s };
const b = { getDBState: (s: State): State => s };
const c = { getDBState: <T,>(s: T) => s };
const d = { getDBState: function (s) { return s; } };
const e = { getDBState: async (s) => (s) };
const f = { getDBState: (s: Record<string, unknown>): Record<string, unknown> => { return s; } };
const g = { getDBState: function named<T>(s: T): T { return s satisfies T; } };
class K { getDBState<T>(s: T): T { return s; } }
const h = { getDBState: (s) => (x) };
const i = { getDBState: s => s.a };
const j = { getDBState: (s, t) => t };
const k = { getDBState: s => s ? {} : s };
type T = { getDBState?: (state: S) => unknown; kvGetDBState: (s: S) => S };
getDBState(state);
const l = x ? getDBState(s) : { return: s };`,
  };
  assertEquals(check([FILTER, src]).map((f) => f.line), [
    1,
    2,
    3,
    4,
    5,
    6,
    7,
    8,
  ]);
});

Deno.test("persist-decider: an identity passed by NAME is followed one level", () => {
  const src: Source = {
    path: "src/named.ts",
    src: `const persist = (s) => s;
function same<T>(s: T): T { return s; }
const pick = (s) => s.keep;
const a = { getDBState: persist };
const b = cfg.getDBState ?? same;
const c = { getDBState: pick };
const d = { getDBState: persist(x) };
const e = { getDBState: persist.bind(null) };`,
  };
  assertEquals(check([FILTER, src]).map((f) => f.line), [4, 5]);
});

Deno.test("persist-decider: restating the persist rule outside the decider module is a second decider", () => {
  const bridge: Source = {
    path: "src/server/bridge.ts",
    src: `const ids = cells.filter((f) => f.__aio.persist !== "none");
const r = c.__aio.persist ?? "all";
const o = d?.__aio?.persist ?? "all";
const q = d.__aio?.persist !== "none";
const t = c.__aio.persistTransform && 1;
// f.__aio.persist !== "none" in a comment is not code
const rev = "none" === c.__aio.persist;
const rev2 = 'none' !== (c?.__aio?.persist);
const s = "none === x.__aio.persist, in a string";`,
  };
  assertEquals(check([FILTER, bridge]).map((f) => `${f.line}|${f.rule}`), [
    "1|second-decider",
    "2|second-decider",
    "3|second-decider",
    "4|second-decider",
    "7|second-decider",
    "8|second-decider",
  ]);
});

Deno.test("persist-decider: the decider module itself is found by what it declares — gone or split is RED", () => {
  assertEquals(rules(check([])), ["src/|decider-module"]);
  const split: Source[] = [
    {
      path: "src/a.ts",
      src: `export function buildDBStateGetter() {}\n` +
        `export function persistingCellIds() {}`,
    },
    {
      path: "src/b.ts",
      src: `export function buildDBStateGetter() {}\n` +
        `export function persistingCellIds() {}`,
    },
  ];
  assertEquals(rules(check(split)), ["src/|decider-module"]);
});
