// Three parameter changes `check:api` reads as additive, and every near miss.
//
// 1. An APPENDED optional parameter — only with a reviewed entry. Every call
//    still type-checks, but a caller that passes the function as a callback
//    (`ids.map(f)`) now feeds the new position an argument, and no snapshot can
//    see whether anyone does. So it is refused until a person names it.
// 2. A function MERGED WITH A NAMESPACE is read as a function plus named
//    members, so a parameter that accepts a strict superset reads as the
//    widening it is (`blocking(id, fn | URL)`).
// 3. A parameter that goes required → optional: every call that passed it
//    still does, and no position moved.
//
// All on REAL `deno doc --json` output, in both directions — a gate that
// accepts too much is the worst failure this file can have.
import { assert, assertEquals, assertMatch } from "@std/assert";
import { join } from "@std/path";
import {
  _extractMembersForTest,
  type AcceptedAppendedParam,
  diffMembers,
  type SymbolEntry,
} from "../scripts/api-snapshot.ts";
import { tempDir } from "../src/testing/temp-dir.ts";

async function entryOf(src: string, name: string): Promise<SymbolEntry> {
  const dir = await tempDir("aio-gate-params");
  const file = join(dir, "t.ts");
  await Deno.writeTextFile(file, src);
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["doc", "--json", file],
    env: { NO_COLOR: "1" },
    stdout: "piped",
    stderr: "piped",
  }).output();
  assert(out.success, new TextDecoder().decode(out.stderr));
  const j = JSON.parse(new TextDecoder().decode(out.stdout)) as {
    nodes: Record<
      string,
      { symbols?: { name: string; declarations: { kind: string }[] }[] }
    >;
  };
  const sym = Object.values(j.nodes).flatMap((f) => f.symbols ?? []).find((
    n,
  ) => n.name === name);
  assert(sym, `${name} not in the doc graph`);
  const members = await _extractMembersForTest(sym.declarations);
  assert(members, `${name} produced no member map`);
  return {
    kind: [...new Set(sym.declarations.map((d) => d.kind))].sort().join("+"),
    sig: src, // differs whenever the source does — all the diff needs
    members,
  };
}

/** The gate's verdict on `before` → `after`, with a given reviewed list. */
async function verdict(
  before: string,
  after: string,
  name: string,
  accepted: readonly AcceptedAppendedParam[] = [],
): Promise<{ breaking: string[]; additive: string[] }> {
  const d = diffMembers(
    ".",
    name,
    await entryOf(before, name),
    await entryOf(after, name),
    accepted,
  )!;
  return {
    breaking: d.filter((c) => c.breaking).map((c) => c.line),
    additive: d.filter((c) => !c.breaking).map((c) => c.line),
  };
}

const ack = (param: string, symbol = "f"): AcceptedAppendedParam[] => [
  { entry: ".", symbol, param, reason: "never passed as a callback" },
];

// ── 1. an appended optional parameter ────────────────────────────────

const F1 = `export function f(a: string): number { return a.length; }`;
const F2 =
  `export function f(a: string, b?: number): number { return a.length + (b ?? 0); }`;

Deno.test("appended optional parameter: REFUSED without a reviewed entry, and the line names the list", async () => {
  const v = await verdict(F1, F2, "f");
  assertEquals(v.additive, []);
  assertEquals(v.breaking.length, 1, v.breaking.join("\n"));
  assertMatch(v.breaking[0]!, /f\.param1 added \(optional parameter/);
  assertMatch(v.breaking[0]!, /APPENDED_PARAMS_ACCEPTED/);
});

Deno.test("appended optional parameter: additive with an entry naming this symbol and position", async () => {
  const v = await verdict(F1, F2, "f", ack("param1"));
  assertEquals(v.breaking, []);
  assertEquals(v.additive.length, 1);
  assertMatch(v.additive[0]!, /f\.param1 added \(optional\)/);
});

Deno.test("appended optional parameter: an entry for another symbol, entry, position, or with no reason accepts nothing", async () => {
  for (
    const list of [
      ack("param1", "g"),
      ack("param2"),
      [{ ...ack("param1")[0]!, entry: "./air" }],
      [{ ...ack("param1")[0]!, reason: " " }],
    ]
  ) {
    const v = await verdict(F1, F2, "f", list);
    assertEquals(v.breaking.length, 1, JSON.stringify(list));
  }
});

Deno.test("appended parameter near misses stay BREAKING even with an entry: required, inserted, rest without one, changed return", async () => {
  const required = await verdict(
    F1,
    `export function f(a: string, b: number): number { return a.length + b; }`,
    "f",
    ack("param1"),
  );
  assertMatch(required.breaking.join("\n"), /param1 added \(REQUIRED/);

  // Inserted in front: position 0 changes type, whatever the entry says.
  const inserted = await verdict(
    `export function f(a?: string): number { return a?.length ?? 0; }`,
    `export function f(b?: number, a?: string): number { return (b ?? 0) + (a?.length ?? 0); }`,
    "f",
    ack("param1"),
  );
  assertMatch(inserted.breaking.join("\n"), /param0 type changed/);

  // A rest parameter absorbs a callback's extra arguments just the same.
  const rest = await verdict(
    F1,
    `export function f(a: string, ...more: string[]): number { return a.length + more.length; }`,
    "f",
  );
  assertMatch(rest.breaking.join("\n"), /param1 added \(optional parameter/);

  const ret = await verdict(
    F1,
    `export function f(a: string, b?: number): string { return a + (b ?? 0); }`,
    "f",
    ack("param1"),
  );
  assertMatch(ret.breaking.join("\n"), /f\.return type changed/);
});

const served = (params: string) =>
  `/** The handle.
 *
 *  @served — the framework builds this. */
export type H = { load: (${params}) => void; n: number };`;
const plain = (params: string) =>
  `/** Hooks an app implements. */
export type H = { load: (${params}) => void; n: number };`;

Deno.test("appended optional parameter on a @served member: same rule, keyed `member.paramN`; an implemented type stays BREAKING", async () => {
  const before = served("json: string");
  const after = served("json: string, opts?: { force?: boolean }");
  const bare = await verdict(before, after, "H");
  assertMatch(bare.breaking.join("\n"), /H\.load\.param1 added \(optional par/);
  const ok = await verdict(before, after, "H", ack("load.param1", "H"));
  assertEquals(ok.breaking, []);

  const impl = await verdict(
    plain("json: string"),
    plain("json: string, opts?: { force?: boolean }"),
    "H",
    ack("load.param1", "H"),
  );
  assertMatch(impl.breaking.join("\n"), /H\.load type changed/);
});

Deno.test("a PROPERTY that happens to be called param1 is a property: optional, additive, no entry needed", async () => {
  const v = await verdict(
    `export type C = { a: 1 };`,
    `export type C = { a: 1; param1?: 2 };`,
    "C",
  );
  assertEquals(v.breaking, []);
});

// ── 2. a function merged with a namespace ────────────────────────────

const merged = (fn: string, ret = "Promise<T>", extra = "") =>
  `export function run<T = unknown>(id: string, fn: ${fn}, arg?: unknown): ${ret} {
  return undefined as never;
}
/** Cancel by id. */
run.cancel = (id: string): boolean => id === "";
run.dispose = async (): Promise<void> => {};
${extra}`;
const FN = `(arg?: unknown) => T | Promise<T>`;

Deno.test("function + namespace: read as the function's parameters plus one key per namespace member", async () => {
  const e = await entryOf(merged(FN), "run");
  assertEquals(e.kind, "function+namespace");
  assertEquals(
    Object.keys(e.members!).sort(),
    ["cancel", "dispose", "param0", "param1", "param2", "return", "typeParams"],
  );
});

Deno.test("function + namespace: a parameter that takes a strict SUPERSET union is additive, no entry needed", async () => {
  const v = await verdict(merged(FN), merged(`(${FN}) | URL`), "run");
  assertEquals(v.breaking, []);
  assertEquals(v.additive.length, 1);
  assertMatch(v.additive[0]!, /run\.param1 widened — it now also accepts URL/);
});

Deno.test("function + namespace near misses stay BREAKING: narrowed, a reordered union that drops a member, changed return, removed or reshaped namespace member", async () => {
  const narrowed = await verdict(merged(`(${FN}) | URL`), merged(FN), "run");
  assertMatch(narrowed.breaking.join("\n"), /run\.param1 type changed/);

  const dropped = await verdict(
    merged(`(${FN}) | URL | string`),
    merged(`number | URL | (${FN})`),
    "run",
  );
  assertMatch(dropped.breaking.join("\n"), /run\.param1 type changed/);

  const ret = await verdict(
    merged(FN),
    merged(`(${FN}) | URL`, "Promise<T | undefined>"),
    "run",
  );
  assertMatch(ret.breaking.join("\n"), /run\.return type changed/);

  const gone = await verdict(
    merged(FN),
    merged(FN).replace(/run\.dispose = .*\n/, ""),
    "run",
  );
  assertEquals(gone.breaking.length, 1, gone.breaking.join("\n"));
  assertMatch(gone.breaking[0]!, /run\.dispose removed/);

  const reshaped = await verdict(
    merged(FN),
    merged(FN).replace("(id: string): boolean", "(id: number): boolean"),
    "run",
  );
  assertMatch(reshaped.breaking.join("\n"), /run\.cancel type changed/);
});

Deno.test("function + namespace: a NEW namespace member is additive", async () => {
  const v = await verdict(
    merged(FN),
    merged(FN, "Promise<T>", `run.size = (): number => 0;`),
    "run",
  );
  assertEquals(v.breaking, []);
  assertMatch(v.additive.join("\n"), /run\.size added/);
});

Deno.test("an array parameter: its ELEMENT may widen; the array turning into a union is BREAKING", async () => {
  const f = (t: string) =>
    `export type A = { a: 1 }; export type B = { b: 2 };
export function f(x: ${t}): void {}`;
  const elem = await verdict(f("A[]"), f("(A | B)[]"), "f");
  assertEquals(elem.breaking, []);
  // A caller passing `A[]` no longer compiles against `A | B`.
  const flat = await verdict(f("A[]"), f("A | B"), "f");
  assertMatch(flat.breaking.join("\n"), /f\.param0 type changed/);
  const back = await verdict(f("A | B"), f("(A | B)[]"), "f");
  assertMatch(back.breaking.join("\n"), /f\.param0 type changed/);
});

// ── 3. required → optional ───────────────────────────────────────────

Deno.test("a parameter that may now be left out is additive; one that must now be passed is BREAKING", async () => {
  const req = `export function f(a: string, b: number): void {}`;
  const opt = `export function f(a: string, b?: number): void {}`;
  const relaxed = await verdict(req, opt, "f");
  assertEquals(relaxed.breaking, []);
  assertMatch(relaxed.additive.join("\n"), /f\.param1 became optional/);
  const tightened = await verdict(opt, req, "f");
  assertEquals(tightened.additive, []);
  assertMatch(tightened.breaking.join("\n"), /f\.param1 became REQUIRED/);
});

Deno.test("a PROPERTY going required → optional stays BREAKING — a reader relies on it being there", async () => {
  const v = await verdict(
    `export type C = { param0: string };`,
    `export type C = { param0?: string };`,
    "C",
  );
  assertMatch(v.breaking.join("\n"), /C\.param0 became OPTIONAL/);
});
