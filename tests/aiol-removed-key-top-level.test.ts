// aiol checkCells — a removed cell-config key (`reduce:`, `machine:`,
// `execute:`, `actions:`) is an ERROR only as a TOP-LEVEL key of the config.
// `perfBudget: { reduce: 100 }` is the current reduce budget and
// `state: { machine: {…}, execute: 2 }` is app data; both failed the gate as
// "removed in alpha27" (llama-master). `am pin`'s file scan draws the same
// line (`tests/am-pin-not-app-code.test.ts`).
import { assertEquals } from "@std/assert";
import { buildContext } from "../aiol/context.ts";
import { checkCells } from "../aiol/checks.ts";
import { join } from "@std/path";

async function removedKeyErrors(cellSource: string): Promise<string[]> {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(dir, "src"), { recursive: true });
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({ imports: { "aio": "jsr:@riagentic/aio@1.0.0" } }),
    );
    await Deno.writeTextFile(join(dir, "src", "cell.ts"), cellSource);
    const { ctx, report } = await buildContext(dir);
    await checkCells(ctx);
    return report.issues
      .filter((i) => i.severity === "error" && /was removed in/.test(i.message))
      .map((i) => /'(\w+):'/.exec(i.message)?.[1] ?? i.message);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("aiol: a removed key NESTED in a cell config is not an error", async () => {
  assertEquals(
    await removedKeyErrors(`import { cell } from "aio";
export const c = cell("c", {
  state: { machine: { a: 1 }, execute: 2, actions: [] as string[] },
  perfBudget: { reduce: 100 },
  methods: { inc(s: { execute: number }) { s.execute += 1; } },
});
`),
    [],
  );
});

Deno.test("aiol: a TOP-LEVEL removed key beside nested look-alikes still errors", async () => {
  assertEquals(
    await removedKeyErrors(`import { cell } from "aio";
export const c = cell("c", {
  state: { machine: { a: 1 } },
  perfBudget: { reduce: 100 },
  methods: { go() {} },
  machine: { idle: {} },
});
`),
    ["machine"],
  );
});
