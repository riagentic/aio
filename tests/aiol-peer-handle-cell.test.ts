// aiol: a peer() handle's METHOD named cell — `p.cell<Broker>("broker")`,
// `p?.cell("x")` — is a call into another app, not this app's cell. Read as
// a definition it made a phantom cell (aipro §6: an unfixable "cell broker has
// no state" on a client that only calls a service).
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { buildContext } from "../aiol/context.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

Deno.test('aiol: p.cell<T>("x") / p?.cell("x") on a peer handle is not a cell definition', async () => {
  const dir = await tempDir("aiol-peer-cell");
  try {
    await Deno.mkdir(join(dir, "src"), { recursive: true });
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({ imports: { "aio": "jsr:@riagentic/aio@1.0.0" } }),
    );
    await Deno.writeTextFile(
      join(dir, "src", "app.ts"),
      `import { cell } from "aio";
import { peer } from "aio/server";
type Broker = { ask(q: string): string };
const p = peer("broker-app");
export const b = p.cell<Broker>("broker");
export const c = p?.cell("other");
export const d = p
  .cell("chained");
export const real = cell("real", { state: { n: 0 } });
`,
    );
    const { ctx } = await buildContext(dir);
    assertEquals(ctx.cells.map((c) => c.name), ["real"]);
  } finally {
    await dropTempDir(dir);
  }
});
