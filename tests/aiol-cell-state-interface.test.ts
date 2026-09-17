// aiol: a cell whose state is cast to an `interface` fails TypeScript far
// from the call (inside aio). Name the cause at the site.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { buildContext } from "../aiol/context.ts";
import { checkCellStateInterface } from "../aiol/checks.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

async function issues(files: Record<string, string>) {
  const dir = await tempDir("aiol-cell-state-");
  try {
    await Deno.mkdir(join(dir, "src"), { recursive: true });
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({ imports: { aio: "jsr:@riagentic/aio@1.0.0" } }),
    );
    for (const [rel, src] of Object.entries(files)) {
      await Deno.writeTextFile(join(dir, rel), src);
    }
    const { ctx, report } = await buildContext(dir);
    await checkCellStateInterface(ctx);
    return report.issues;
  } finally {
    await dropTempDir(dir);
  }
}

Deno.test("aiol: state cast to an interface is an ERROR that names the type alias fix", async () => {
  const found = await issues({
    "src/c.ts": `import { cell } from "aio";
export interface St { n: number }
export const c = cell("c", {
  state: { n: 0 } as St,
  methods: { inc(s) { s.n++; } },
});
`,
  });
  assertEquals(found.length, 1, JSON.stringify(found));
  const i = found[0]!;
  assertEquals(i.severity, "error");
  assert(i.message.includes("interface"), i.message);
  assert(i.message.includes("type St"), i.message);
  assert(i.message.includes('cell "c"'), i.message);
});

Deno.test("aiol: state cast to a type alias is clean", async () => {
  const found = await issues({
    "src/c.ts": `import { cell } from "aio";
export type St = { n: number };
export const c = cell("c", {
  state: { n: 0 } as St,
  methods: { inc(s) { s.n++; } },
});
`,
  });
  assertEquals(found, []);
});

const CELL_TAIL = `  methods: { inc(s) { s.n++; } },
});
`;

Deno.test("aiol: a non-cell `state: {…} as Iface` object is not a cell's state (h8 F3)", async () => {
  const found = await issues({
    "src/c.ts": `import { cell } from "aio";
export type St = { n: number };
interface Snapshot { n: number; at: number }
export const c = cell("c", {
  state: { n: 0 } as St,
${CELL_TAIL}
export const fixture = { state: { n: 1, at: 0 } as Snapshot, label: "x" };
`,
  });
  assertEquals(found, []);
});

// Every shape below fails `deno check` exactly like the canonical case
// (TS2322 / TS18046 — `s.n` is unknown); aiol said clean (h8 F4).
const BAD: Record<string, Record<string, string>> = {
  "interface imported with import type": {
    "src/types.ts": `export interface St { n: number }\n`,
    "src/c.ts": `import { cell } from "aio";
import type { St } from "./types.ts";
export const c = cell("c", {
  state: { n: 0 } as St,
${CELL_TAIL}`,
  },
  "interface imported under an alias": {
    "src/types.ts": `export interface State { n: number }\n`,
    "src/c.ts": `import { cell } from "aio";
import { type State as St } from "./types.ts";
export const c = cell("c", {
  state: { n: 0 } as St,
${CELL_TAIL}`,
  },
  "a const annotated with the interface": {
    "src/c.ts": `import { cell } from "aio";
interface St { n: number }
const st: St = { n: 0 };
export const c = cell("c", {
  state: st,
${CELL_TAIL}`,
  },
  "a factory declared to return the interface": {
    "src/c.ts": `import { cell } from "aio";
interface St { n: number }
function makeState(): St { return { n: 0 }; }
export const c = cell("c", {
  state: makeState(),
${CELL_TAIL}`,
  },
  "a call cast to the interface": {
    "src/c.ts": `import { cell } from "aio";
interface St { n: number }
const makeState = () => ({ n: 0 });
export const c = cell("c", {
  state: makeState() as St,
${CELL_TAIL}`,
  },
  "a 3-level literal": {
    "src/c.ts": `import { cell } from "aio";
interface St { n: number; a: { b: { c: number } } }
export const c = cell("c", {
  state: { n: 0, a: { b: { c: 1 } } } as St,
${CELL_TAIL}`,
  },
  "a parenthesised literal": {
    "src/c.ts": `import { cell } from "aio";
interface St { n: number }
export const c = cell("c", {
  state: ({ n: 0 }) as St,
${CELL_TAIL}`,
  },
  "a literal holding a brace in a string": {
    "src/c.ts": `import { cell } from "aio";
interface St { n: number; tpl: string }
export const c = cell("c", {
  state: { n: 0, tpl: "}" } as St,
${CELL_TAIL}`,
  },
  "an angle-bracket cast": {
    "src/c.ts": `import { cell } from "aio";
interface StE { n: number }
export const c = cell("c", {
  state: <StE> { n: 0 },
${CELL_TAIL}`,
  },
};

for (const [name, files] of Object.entries(BAD)) {
  Deno.test(`aiol: interface state is an error — ${name} (h8 F4)`, async () => {
    const found = await issues(files);
    assertEquals(found.length, 1, JSON.stringify(found));
    assert(found[0]!.message.includes('cell "c"'), found[0]!.message);
    assertEquals(found[0]!.file, "src/c.ts");
    assertEquals(found[0]!.severity, "error");
  });
}

const OK: Record<string, Record<string, string>> = {
  "generic type alias": {
    "src/c.ts": `import { cell } from "aio";
type St<T> = { n: T };
interface Other { n: number }
export const c = cell("c", {
  state: { n: 0 } as St<number>,
${CELL_TAIL}`,
  },
  "as const": {
    "src/c.ts": `import { cell } from "aio";
interface Other { n: number }
export const c = cell("c", {
  state: { n: 0 } as const,
  methods: { read(s) { console.log(s.n); } },
});
`,
  },
  "satisfies an interface": {
    "src/c.ts": `import { cell } from "aio";
interface St { n: number }
export const c = cell("c", {
  state: { n: 0 } satisfies St,
${CELL_TAIL}`,
  },
  "type alias imported from another file": {
    "src/types.ts":
      `export type St = { n: number };\nexport interface Other { x: 1 }\n`,
    "src/c.ts": `import { cell } from "aio";
import type { St } from "./types.ts";
export const c = cell("c", {
  state: { n: 0 } as St,
${CELL_TAIL}`,
  },
  "factory cast to an alias": {
    "src/c.ts": `import { cell } from "aio";
interface Raw { n: number }
type St = { n: number };
function makeState(): Raw { return { n: 0 }; }
export const c = cell("c", {
  state: makeState() as St,
${CELL_TAIL}`,
  },
  "a const annotated with an alias": {
    "src/c.ts": `import { cell } from "aio";
interface Other { n: number }
type St = { n: number };
const st: St = { n: 0 };
export const c = cell("c", {
  state: st,
${CELL_TAIL}`,
  },
};

for (const [name, files] of Object.entries(OK)) {
  Deno.test(`aiol: correct state typing stays clean — ${name}`, async () => {
    assertEquals(await issues(files), []);
  });
}
