// A fix line is followed literally, so it must be RIGHT:
// - sync I/O in a reducer suggested `await Deno.readTextFileSync(…)` (still
//   blocks) and "hand the I/O to `s.$do(…)`" ($do takes only schedule/own
//   effects and throws on anything else) — it now names the async twin;
// - `Deno.*` in a cell file said "read it on the server — in a cell method",
//   which the flagged line (in a cell method) already did — it now names the
//   documented escape, a `*.server.ts` module behind a dynamic import.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { buildContext } from "../aiol/context.ts";
import { checkSyncMethodIO, checkUI } from "../aiol/checks.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import type { Checker } from "../aiol/types.ts";

async function issues(check: Checker, cellSrc: string) {
  const dir = await tempDir("aiol-fix-text-");
  try {
    await Deno.mkdir(join(dir, "src"));
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({ imports: { aio: "jsr:@riagentic/aio@1.0.0" } }),
    );
    await Deno.writeTextFile(join(dir, "src", "cell.ts"), cellSrc);
    await Deno.writeTextFile(
      join(dir, "src", "App.tsx"),
      `import { notes } from "./cell.ts";\nexport default () => <p>{notes.text}</p>;\n`,
    );
    const { ctx, report } = await buildContext(dir);
    await check(ctx);
    return report.issues;
  } finally {
    await dropTempDir(dir);
  }
}

const CELL = `import { cell } from "aio";
export const notes = cell("notes", {
  state: { text: "" },
  methods: {
    load(s) {
      s.text = Deno.readTextFileSync("a.txt");
    },
  },
});
`;

Deno.test("aiol sync I/O: the fix awaits the async twin, never the Sync call or $do", async () => {
  const [i] = await issues(checkSyncMethodIO, CELL);
  assertEquals(
    i!.fix,
    "async load(s) { const r = await Deno.readTextFile(…); s.x = r }",
  );
  assert(!i!.message.includes("$do"), i!.message);
  assertStringIncludes(i!.message, "`Deno.readTextFile()`");
});

Deno.test("aiol Deno in a cell file: the fix is a *.server.ts module, not 'a cell method'", async () => {
  const found = (await issues(checkUI, CELL)).filter((i) =>
    i.message.includes("server-only")
  );
  assertEquals(found.length, 1, JSON.stringify(found));
  assertEquals(found[0]!.severity, "error");
  assertStringIncludes(found[0]!.fix!, "*.server.ts");
  assert(!found[0]!.fix!.includes("in a cell method"), found[0]!.fix);
});
