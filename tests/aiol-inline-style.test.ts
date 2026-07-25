// risoto #1 (boundary, machine-checked slice): a cell-dependent inline
// `style={{…}}` freezes at mount (evaluated once) while `class=` stays reactive.
// aiol's checkInlineStyle flags it — without touching static styles or class=.
import { assert, assertEquals } from "@std/assert";
import { buildContext } from "../aiol/context.ts";
import { checkInlineStyle } from "../aiol/checks.ts";
import { join } from "@std/path";

async function styleWarnings(files: Record<string, string>) {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(dir, "src"), { recursive: true });
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({ imports: { "aio": "jsr:@riagentic/aio@1.0.0" } }),
    );
    // A cell named "theme" so it's in ctx.cells.
    await Deno.writeTextFile(
      join(dir, "src", "theme.ts"),
      `import { cell } from "aio";\nexport const theme = cell("theme", { state: { color: "#fff" } });`,
    );
    for (const [n, b] of Object.entries(files)) {
      await Deno.writeTextFile(join(dir, "src", n), b);
    }
    const { ctx, report } = await buildContext(dir);
    await checkInlineStyle(ctx);
    return report.issues.filter((i) => i.area === "boundary");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("checkInlineStyle: a cell-dependent inline style is flagged", async () => {
  const w = await styleWarnings({
    "Panel.tsx":
      `import { theme } from "./theme.ts";\nexport const Panel = () => <div style={{ color: theme.color }}>hi</div>;`,
  });
  assertEquals(
    w.length,
    1,
    `expected one warning; got ${w.map((i) => i.message)}`,
  );
  assert(w[0]!.message.includes("freezes"), w[0]!.message);
});

Deno.test("checkInlineStyle: a static style object is NOT flagged", async () => {
  const w = await styleWarnings({
    "Panel.tsx":
      `export const Panel = () => <div style={{ color: "red", padding: 8 }}>hi</div>;`,
  });
  assertEquals(w, []);
});

Deno.test("checkInlineStyle: a reactive class= binding is fine (the recommended fix)", async () => {
  const w = await styleWarnings({
    "Panel.tsx":
      `import { theme } from "./theme.ts";\nexport const Panel = () => <div class={theme.color}>hi</div>;`,
  });
  assertEquals(w, []);
});
