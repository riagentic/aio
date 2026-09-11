// `@served` — a parameter of a function-typed property may WIDEN, and only
// there.
//
// `s.$do(notify(...))` needed `$do`'s parameter to grow a third effect. The
// gate called that BREAKING, and for a property it is right by default: a
// function type is contravariant in its parameters, so widening one breaks
// whoever IMPLEMENTS it — an app writing a config callback. A method draft is
// not that: the framework builds it, an app only calls it. `@served` is the
// framework saying so, and under it the gate breaks the property into its
// parameters, exactly as it already does for a top-level function, so the
// widening reads as the addition it provably is. Pinned against the REAL
// `deno doc --json` shape, both directions, tagged and untagged.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  _extractMembersForTest,
  diffMembers,
} from "../scripts/api-snapshot.ts";
import { tempDir } from "../src/testing/temp-dir.ts";

async function membersOf(
  src: string,
  name: string,
): Promise<Record<string, string>> {
  const dir = await tempDir("aio-served");
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
      { symbols?: { name: string; declarations: unknown[] }[] }
    >;
  };
  const sym = Object.values(j.nodes).flatMap((f) => f.symbols ?? []).find((
    n,
  ) => n.name === name);
  assert(sym, `${name} not in the doc graph`);
  const m = await _extractMembersForTest(sym.declarations);
  assert(m, `${name} produced no member map`);
  return m;
}

const A =
  `export type A = { a: 1 }; export type B = { b: 2 }; export type C = { c: 3 };`;
const served = (param: string) =>
  `${A}
/** A draft.
 *
 *  @served — the framework builds this. */
export type Draft = { readonly $do: (effect: ${param}, ...more: (${param})[]) => void; n: number };`;
const plain = (param: string) =>
  `${A}
/** A callback bag an app implements. */
export type Hooks = { readonly onIt: (effect: ${param}) => void; n: number };`;

Deno.test("@served: a function-typed property is broken into parameters, and widening one is additive", async () => {
  const before = await membersOf(served("A | B"), "Draft");
  const after = await membersOf(served("A | B | C"), "Draft");
  assertEquals(before["$do"], "req:fn");
  assert(before["$do.param0"]?.startsWith("req:"), "param0 recorded");
  assert(
    before["$do.param1"]?.startsWith("opt:"),
    "a rest param is never required",
  );
  assert(before["$do.return"], "return recorded");
  const d = diffMembers(".", "Draft", { sig: "x", members: before } as never, {
    sig: "y",
    members: after,
  } as never)!;
  assertEquals(
    d.filter((c) => c.breaking).map((c) => c.line),
    [],
    `widening must be additive:\n${d.map((c) => c.line).join("\n")}`,
  );
  assert(d.some((c) => /\$do\.param0 widened/.test(c.line)), "and says so");
  assert(
    d.some((c) => /\$do\.param1 widened/.test(c.line)),
    "the rest param too",
  );
});

Deno.test("@served: NARROWING the same parameter is still BREAKING", async () => {
  const before = await membersOf(served("A | B | C"), "Draft");
  const after = await membersOf(served("A | B"), "Draft");
  const d = diffMembers(".", "Draft", { sig: "x", members: before } as never, {
    sig: "y",
    members: after,
  } as never)!;
  assert(
    d.some((c) => c.breaking && /\$do\.param0/.test(c.line)),
    d.map((c) => c.line).join("\n"),
  );
});

Deno.test("without @served the property stays one digest — widening it is BREAKING, because an app may implement it", async () => {
  const before = await membersOf(plain("A | B"), "Hooks");
  const after = await membersOf(plain("A | B | C"), "Hooks");
  assertEquals(before["onIt.param0"], undefined, "no parameter breakout");
  const d = diffMembers(".", "Hooks", { sig: "x", members: before } as never, {
    sig: "y",
    members: after,
  } as never)!;
  assert(
    d.some((c) => c.breaking && /onIt type changed/.test(c.line)),
    d.map((c) => c.line).join("\n"),
  );
});

// What the rule bought, pinned at the type level: the public handle takes the
// option the operator doors already honoured, and a method takes the third
// framework effect — neither needs an annotation or an internal type.
import type { AioApp, MethodDraftServed } from "../mod.ts";
Deno.test("@served in practice: loadSnapshot(json, { force }) and s.$do(notify()) type-check on the PUBLIC types", () => {
  const load: NonNullable<AioApp["loadSnapshot"]> = (_json, _opts) => {};
  load("{}");
  load("{}", { force: true });
  const draft: MethodDraftServed = {
    $do: () => {},
  } as unknown as MethodDraftServed;
  draft.$do({ type: "__notify", title: "t" });
  assert(true);
});
