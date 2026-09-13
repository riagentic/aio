// The draft-typing spellings the docs teach must compile, and the ones they
// warn against must not — report 9b §1.
//
// `docs/state/methods.md` taught `s: State & MethodDraftCalls<Calls>` for
// `s.$call`, and it does not compile: a method's draft type is frozen public
// surface and does not declare `$call`, so a method that REQUIRES it is not a
// `Method<State>` (TS2322). The one test of that spelling built its cell
// `as any`, so nothing ever checked it. A weak model spent ten minutes and
// eleven checks on it, then gave up on `$call`. The same run lost time to an
// `interface` state, which a cell refuses with no word about why.
//
// The doc's blocks are fragments (`methods: { … }`), which the snippet gate
// skips — so this test splices them into a cell and runs `deno check`.
import { assert, assertEquals } from "@std/assert";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const repo = new URL("..", import.meta.url).pathname;
const read = (p: string) =>
  Deno.readTextFile(new URL(`../${p}`, import.meta.url));

/** `deno check` a program against this repo's `aio`; the exit code and stderr. */
async function check(program: string): Promise<{ code: number; err: string }> {
  const dir = await tempDir("aio-doc-draft-types-");
  try {
    await Deno.writeTextFile(
      `${dir}/deno.jsonc`,
      JSON.stringify({
        // The repo's own compiler options (its `lib`, its strictness) — an
        // app built with `am create` gets the same ones.
        compilerOptions: JSON.parse(await read("deno.json")).compilerOptions,
        imports: { "aio": `${repo}mod.ts` },
      }),
    );
    await Deno.writeTextFile(`${dir}/snippet.ts`, program);
    const { code, stderr } = await new Deno.Command(Deno.execPath(), {
      args: ["check", "-c", `${dir}/deno.jsonc`, `${dir}/snippet.ts`],
      stdout: "null",
      stderr: "piped",
    }).output();
    return { code, err: new TextDecoder().decode(stderr) };
  } finally {
    await dropTempDir(dir);
  }
}

const PRELUDE = [
  'import { cell } from "aio";',
  'import type { MethodCalls, MethodDraftCalls } from "aio";',
  "type State = { status: string; samples: { kind: string; at: number }[] };",
  "declare function load(): Promise<void>;",
  'const initial: State = { status: "idle", samples: [] };',
].join("\n");

/** The `$call` section's ts blocks, in order. */
async function callBlocks(): Promise<string[]> {
  const md = await read("docs/state/methods.md");
  const start = md.indexOf("## One method calling another");
  assert(start >= 0, "the $call section is still in methods.md");
  const section = md.slice(start, md.indexOf("### What it refuses", start));
  return [...section.matchAll(/```ts\n([\s\S]*?)```/g)].map((m) => m[1]!);
}

Deno.test("methods.md: every $call spelling it teaches type-checks", async () => {
  const md = await read("docs/state/methods.md");
  const [intro, types = ""] = await callBlocks();
  assert(intro?.includes('s.$call!.bench("warm")'), intro);
  assert(types?.includes("Partial<MethodDraftCalls<Calls>>"), types);
  const cut = types.indexOf("methods: {");
  const castExpr =
    '(s as typeof s & MethodDraftCalls<Calls>).$call.bench("cold")';
  assert(md.includes(`\`${castExpr}\``), "the cast spelling is in the doc");
  const derived = "Partial<MethodDraftCalls<MethodCalls<typeof helpers>>>";
  assert(md.includes(`\`${derived}\``), "the derived spelling is in the doc");
  assert(md.includes("`s: State & Partial<MethodDraftCalls>`"));

  const program = [
    PRELUDE,
    `export const intro = cell("intro", { state: initial,\n${intro}});`,
    types.slice(0, cut),
    `export const typed = cell("typed", { state: initial,\n${
      types.slice(cut)
    }});`,
    `export const cast = cell("cast", { state: initial, methods: {`,
    `  bench(s, kind: string) { return s.samples.length + kind.length },`,
    `  run(s) { const n: number = ${castExpr}; s.status = String(n) },`,
    `} });`,
    `const helpers = { bench(s: State, kind: string) { return kind.length } };`,
    `export const derived = cell("derived", { state: initial, methods: {`,
    `  ...helpers,`,
    `  run(s: State & ${derived}) { const n: number = s.$call!.bench("x"); s.status = String(n) },`,
    `} });`,
    `export const loose = cell("loose", { state: initial, methods: {`,
    `  run(s: State & Partial<MethodDraftCalls>) { s.$call!.anything(1, 2) },`,
    `} });`,
  ].join("\n");
  const { code, err } = await check(program);
  assertEquals(
    code,
    0,
    `deno check failed:\n${err}\n--- program ---\n${program}`,
  );
});

Deno.test("methods.md / cells.md: the spellings they warn against really fail", async () => {
  // Without `Partial<>` — the spelling the doc used to teach.
  const required = await check([
    PRELUDE,
    "interface Calls { bench(kind: string): number }",
    `export const c = cell("c", { state: initial, methods: {`,
    `  bench(s, kind: string) { return kind.length },`,
    `  async run(s: State & MethodDraftCalls<Calls>) { s.$call.bench("x") },`,
    `} });`,
  ].join("\n"));
  assert(required.code !== 0, "a required $call must still be refused");
  assert(/TS2322/.test(required.err), required.err);
  assert(/'\$call' is missing/.test(required.err), required.err);

  // An `interface` state — cells.md says a `type` alias, and why.
  const cells = await read("docs/state/cells.md");
  assert(cells.includes("State types are `type` aliases, not `interface`"));
  const iface = await check([
    'import { cell } from "aio";',
    "interface State { count: number }",
    "const initial: State = { count: 0 };",
    'export const c = cell("p1", { state: initial, methods: { inc(s) { s.count += 1; } } });',
  ].join("\n"));
  assert(iface.code !== 0, "an interface state is refused (the doc's claim)");
  assert(/Record<string, unknown>/.test(iface.err), iface.err);
  const alias = await check([
    'import { cell } from "aio";',
    "type State = { count: number };",
    "const initial: State = { count: 0 };",
    'export const c = cell("p1", { state: initial, methods: { inc(s) { s.count += 1; } } });',
  ].join("\n"));
  assertEquals(alias.code, 0, `the same shape as a type alias: ${alias.err}`);
});
