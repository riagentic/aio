// A `--safe-fix` must never edit a program's own TEXT.
//
// The project's standing rule is that a source rewrite consults `codeMask`; a
// string body, a template body, a regex body and a comment are not code. Four
// fixes did not, so a `useCell(...).state.x` inside a migration-hint string, a
// `backoff:` inside a comment, a `deps: […], fn: …` inside a doc string, or a
// dynamic `import("aio")` inside a template were rewritten — silently changing
// a value the app ships. `fixPollBackoffKey` additionally matched an ACTION
// PAYLOAD that happened to carry `every:` and `backoff:`, and renamed the
// payload's own field (a real behaviour change).
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import {
  fixPollBackoffKey,
  fixRenameTargetToClient,
  fixSelectorDepsTuple,
  fixUseCellStateReads,
  moveImports,
  pollBackoffCalls,
} from "../aiol/fixes.ts";

/** Apply a file fix to `src` in a scratch file; return the result. */
async function fixedWith(
  fix: (p: string) => () => Promise<boolean>,
  src: string,
): Promise<{ out: string; changed: boolean }> {
  const dir = await tempDir("aiol-fix-mask-");
  try {
    const p = `${dir}/src.ts`;
    await Deno.writeTextFile(p, src);
    const changed = await fix(p)();
    return { out: await Deno.readTextFile(p), changed };
  } finally {
    await dropTempDir(dir);
  }
}

Deno.test("fixUseCellStateReads: a string or comment is not rewritten", async () => {
  const src = `import { useCell } from "aio";
import { counter } from "./cell.ts";
export const HINT = "useCell(counter).state.count → counter.count";
// old: useCell(counter).state.count
export function App() { return useCell(counter).state.count; }
`;
  const { out } = await fixedWith(fixUseCellStateReads, src);
  assertStringIncludes(out, `"useCell(counter).state.count → counter.count"`);
  assertStringIncludes(out, "// old: useCell(counter).state.count");
  assertStringIncludes(out, "return counter.count;");
});

Deno.test("fixSelectorDepsTuple: a string or comment is not rewritten", async () => {
  const src = `export const DOC = "deps: [a], fn: (s, x) => x";
// deps: [a], fn: (s, x) => x
export const sel = { deps: [a], fn: (s, x) => x };
`;
  const { out } = await fixedWith(fixSelectorDepsTuple, src);
  assertStringIncludes(out, `"deps: [a], fn: (s, x) => x"`);
  assertStringIncludes(out, "// deps: [a], fn: (s, x) => x");
  assertStringIncludes(out, "fn: (s, [x]) => x");
});

Deno.test("fixPollBackoffKey: an action payload's `backoff` field is DATA", async () => {
  const src =
    `s.$do(schedule.poll("sync", s.attempt, syncAction({ every: "day", backoff: 3 }), { every: 5000, factor: 2 }));
`;
  assertEquals(pollBackoffCalls(src), [], "the payload is not the opts");
  const { out, changed } = await fixedWith(fixPollBackoffKey, src);
  assertEquals(changed, false);
  assertEquals(out, src);
});

Deno.test("fixPollBackoffKey: the opts key IS renamed, in either arg order", async () => {
  // aio's `schedule`: only a name the file imports from aio is rewritten.
  const AIO = `import { schedule } from "aio";\n`;
  // New order: opts is the 4th argument.
  const now = AIO +
    `return schedule.poll("id", s.attempt, { type: "t" }, { every: 5000, backoff: 2 });`;
  assertStringIncludes(
    (await fixedWith(fixPollBackoffKey, now)).out,
    "{ every: 5000, factor: 2 }",
  );
  // Old order: opts is the 3rd.
  const old = AIO +
    `return schedule.poll("id", s.attempt, { every: 5000, backoff: 2 }, { type: "t" });`;
  const r = await fixedWith(fixPollBackoffKey, old);
  assertStringIncludes(r.out, "{ every: 5000, factor: 2 }");
  assertStringIncludes(r.out, `{ type: "t" }`);
  // The same call with nothing that binds `schedule`: left as written.
  const bare = old.slice(AIO.length);
  assertEquals(await fixedWith(fixPollBackoffKey, bare), {
    out: bare,
    changed: false,
  });
});

Deno.test("fixPollBackoffKey: a comment or string spelling is not rewritten", async () => {
  const src =
    `return schedule.poll("p", s.attempt, A.tick(), { every: 1000 /* backoff: 2 */, label: "backoff: 2" });\n`;
  const { out, changed } = await fixedWith(fixPollBackoffKey, src);
  assertEquals(changed, false);
  assertStringIncludes(out, "/* backoff: 2 */");
  assertStringIncludes(out, `"backoff: 2"`);
});

Deno.test("fixRenameTargetToClient: a deno.jsonc project is fixed too", async () => {
  const dir = await tempDir("aiol-jsonc-");
  try {
    await Deno.writeTextFile(
      `${dir}/deno.jsonc`,
      `{\n  "target": "browser"\n}\n`,
    );
    assertEquals(await fixRenameTargetToClient(dir), true);
    const out = await Deno.readTextFile(`${dir}/deno.jsonc`);
    assertStringIncludes(out, `"client": "browser"`);
    assert(!out.includes(`"target"`), out);
    // A real jsonc with comments is DECLINED, never half-applied.
    await Deno.writeTextFile(
      `${dir}/deno.jsonc`,
      `{\n  // why\n  "target": "browser"\n}\n`,
    );
    assertEquals(await fixRenameTargetToClient(dir), false);
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("moveImports: a dynamic import inside a string or comment is left alone", () => {
  const mv = { from: "aio", to: "aio/testing", names: new Set(["testCell"]) };
  for (
    const wrap of [
      (s: string) => `export const DOC = '${s}';`,
      (s: string) => `export const DOC = \`${s}\`;`,
      (s: string) => `// ${s}`,
    ]
  ) {
    const src = `import { testCell } from "aio";\n${
      wrap('{ testCell } = await import("aio")')
    }\n`;
    const out = moveImports(src, mv);
    assert(out, "the static import moves");
    assertStringIncludes(out!, 'from "aio/testing"');
    assertStringIncludes(out!, '{ testCell } = await import("aio")');
    assert(!out!.includes('await import("aio/testing")'), out!);
  }
});
