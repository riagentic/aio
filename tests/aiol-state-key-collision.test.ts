// A state key named like a method or selector: `cell()` throws at boot
// (AIO-6.1). aiol says so before the first run — for the literal shape only.
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { buildContext } from "../aiol/context.ts";
import { checkStateKeyCollision } from "../aiol/checks.ts";
import { cell } from "../mod.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

async function collisions(cellSource: string): Promise<string[]> {
  const dir = await tempDir("aiol-keycollide-");
  try {
    await Deno.mkdir(join(dir, "src"), { recursive: true });
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({ imports: { aio: "jsr:@riagentic/aio@1.0.0" } }),
    );
    await Deno.writeTextFile(join(dir, "src", "c.ts"), cellSource);
    const { ctx, report } = await buildContext(dir);
    checkStateKeyCollision(ctx);
    return report.issues
      .filter((i) => i.message.includes("collides with"))
      .map((i) => `${i.severity} ${i.line}`);
  } finally {
    await dropTempDir(dir);
  }
}

Deno.test("aiol: state key == method / selector name is an error", async () => {
  assertEquals(
    await collisions(`import { cell } from "aio";
export const c = cell("c", {
  state: { quotes: [], fear: 0, items: [] },
  methods: {
    // a comment
    async quotes(s) { s.fear = 1; },
    fear: (s) => { s.items.filter((x) => x); },
  },
  selectors: { items: (s) => s.items.length },
});`),
    ["error 6", "error 7", "error 9"],
  );
});

Deno.test("aiol: no collision on near-misses or shapes it cannot read", async () => {
  assertEquals(
    await collisions(`import { cell } from "aio";
const base = { methods: { count(s) { s.n++; } } };
export const a = cell("a", { ...base, state: { count: 0, n: 0 } });
const cfg = { state: { go: 0 }, methods: { go(s) {} } };
export const b = cell("b", cfg);
export const c = cell("c", {
  state: { filter: "", nested: { add: 1 } },
  methods: {
    add(s) { s.filter = [1].filter(Boolean).join(); },
    setNested(s) { s.nested = { add: 2 }; },
  },
});`),
    [],
  );
});

Deno.test("aiol: the flagged shape really is a boot error", () => {
  let err = "";
  try {
    cell("aiol-keycollide-proof", {
      state: { quotes: 0 },
      methods: { quotes(_s: { quotes: number }) {} },
    } as never);
  } catch (e) {
    err = String(e);
  }
  assertEquals(err.includes("collides with method 'quotes'"), true, err);
});
