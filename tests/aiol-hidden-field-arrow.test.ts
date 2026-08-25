// aiol rule 25 must see EXPRESSION-BODIED arrow selectors/methods:
// `seedLen: (s) => s.seed.length` reads the hidden field exactly like the
// braced form, and was invisible to the scanner (a field report).
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { buildContext } from "../aiol/context.ts";
import { checkSyncMethodHiddenReads } from "../aiol/checks.ts";

async function issues(src: string) {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(dir, "src"), { recursive: true });
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({ imports: { aio: "jsr:@riagentic/aio@1.0.0" } }),
    );
    await Deno.writeTextFile(join(dir, "src/vault.ts"), src);
    const { ctx, report } = await buildContext(dir);
    await checkSyncMethodHiddenReads(ctx);
    return report.issues;
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const HEAD = `import { cell } from "aio";
export const vault = cell("vault", {
  state: { seed: "", hasSeed: false },
  visible: { exclude: ["seed"] },
  sync: true,
`;

Deno.test("aiol: an expression-bodied arrow selector reading a hidden field is flagged like the block form", async () => {
  const found = await issues(
    HEAD + `  selectors: {
    blockLen: (s) => { return s.seed.length; },
    exprLen: (s) => s.seed.length,
    bare: s => s.seed !== "",
    fine: (s) => s.hasSeed,
    later: async (s) => s.seed.length,
  },
});
`,
  );
  assertEquals(
    found.map((
      i,
    ) => [i.line, /"(\w+)"/.exec(i.message.split("selector")[1] ?? "")?.[1]]),
    [[7, "blockLen"], [8, "exprLen"], [9, "bare"]],
    JSON.stringify(found, null, 1),
  );
});

Deno.test("aiol: an expression-bodied sync METHOD of a sync cell is flagged too; nothing hidden read → clean", async () => {
  const found = await issues(
    HEAD + `  methods: {
    check: (s) => void s.seed,
    bump: (s) => { s.hasSeed = true; },
  },
});
`,
  );
  assertEquals(found.length, 1, JSON.stringify(found, null, 1));
  assertEquals(found[0]!.line, 7);
  const clean = await issues(
    HEAD +
      `  selectors: { ok: (s) => s.hasSeed, ok2: (s) => ({ a: s.hasSeed }) },
});
`,
  );
  assertEquals(clean, []);
});
