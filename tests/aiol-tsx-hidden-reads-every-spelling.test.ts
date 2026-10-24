// A component read of a `visible`-hidden field THROWS at render. The lint
// saw only `vault.apiKey`: the destructured `const { apiKey } = vault` and the
// bracket `vault["apiKey"]` (the same proxy get) passed, and a file's SECOND
// hidden field was never reported while the first stood (a `break` that the
// comment beside it said was per field).
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { buildContext } from "../aiol/context.ts";
import { checkTsxHiddenReads } from "../aiol/checks.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const CELL = `import { cell } from "aio";
export const vault = cell("vault", {
  state: { label: "prod", apiKey: "", pin: "", nested: { secret: "", ok: 1 } },
  visible: { exclude: ["apiKey", "pin", "nested.secret"] },
  methods: { rotate(s, next: string) { s.apiKey = next; } },
});
`;

async function found(app: string): Promise<string[]> {
  const dir = await tempDir("aiol-tsx-hidden-");
  try {
    await Deno.mkdir(join(dir, "src"));
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({ imports: { aio: "jsr:@riagentic/aio@1.0.0" } }),
    );
    await Deno.writeTextFile(join(dir, "src", "cell.ts"), CELL);
    await Deno.writeTextFile(join(dir, "src", "App.tsx"), app);
    const { ctx, report } = await buildContext(dir);
    await checkTsxHiddenReads(ctx);
    return report.issues.map((i) =>
      `${i.line}:${/`vault\.([\w.]+)`/.exec(i.message)?.[1]}`
    )
      .sort();
  } finally {
    await dropTempDir(dir);
  }
}

const HEAD = `import { vault } from "./cell.ts";\n`;

Deno.test("aiol tsx hidden read: destructuring and bracket reads are reads", async () => {
  assertEquals(
    await found(
      HEAD +
        `export const A = () => { const { label, apiKey: k } = vault; return <p>{label}{k}</p>; };\n`,
    ),
    ["2:apiKey"],
  );
  assertEquals(
    await found(HEAD + `export const A = () => <p>{vault["pin"]}</p>;\n`),
    ["2:pin"],
  );
  // Visible fields in the same spellings stay silent.
  assertEquals(
    await found(
      HEAD +
        `export const A = () => { const { label } = vault; return <p>{label}{vault["label"]}</p>; };\n`,
    ),
    [],
  );
});

Deno.test("aiol tsx hidden read: every hidden field in a file is reported once", async () => {
  assertEquals(
    await found(
      HEAD +
        `export const A = () => <p>{vault.apiKey}{vault.apiKey}</p>;\n` +
        `export const B = () => <p>{vault.pin}{vault.nested.secret}</p>;\n`,
    ),
    ["2:apiKey", "3:nested.secret", "3:pin"],
  );
});
