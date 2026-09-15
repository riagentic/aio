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
