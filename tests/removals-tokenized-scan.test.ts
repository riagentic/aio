// `am pin`'s removed-API scan reads CODE, not text: a removed key spelled in a
// template string, a comment, a string literal, or a regex is a fixture or a
// remark, not a config the app boots with. A field report: an app's own
// upgrade-test fixture carried `execute:` in a template string and the pin
// refused to move an app whose real config was already migrated. The refusal
// also QUOTES the line it matched, so the reader sees what it saw.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { isFixturePath, removalsInSource } from "../src/state/removals.ts";
import { blockerLines, preflight } from "../src/am/am-cmd-pin.ts";

const TEMPLATE = 'const fixture = `cell("x", { execute: {}, state: {} })`;\n';
const COMMENT = "// the old form was `execute: {}` — see the upgrade guide\n";
const BLOCK = "/* execute: { foo() {} } used to live here */\n";
const STRING = 'const msg = "config key execute: is gone";\n';
const REGEX = "const re = /execute:\\s*\\{/;\n";
const REAL = `export const c = cell("c", {
  state: { n: 0 },
  execute: { run() {} },
});
`;

Deno.test("removalsInSource: a removed key inside strings/templates/comments/regex is NOT a hit", () => {
  for (const src of [TEMPLATE, COMMENT, BLOCK, STRING, REGEX]) {
    assertEquals(
      removalsInSource(src).map((h) => h.removal.key),
      [],
      `false positive on: ${src.trim()}`,
    );
  }
});

Deno.test("removalsInSource: the real config key IS a hit, on the right line, with the line quoted", () => {
  const src = TEMPLATE + COMMENT + STRING + REAL;
  const hits = removalsInSource(src);
  assertEquals(hits.map((h) => h.removal.key), ["execute"]);
  assertEquals(hits[0]!.line, 6);
  assertEquals(hits[0]!.text, "execute: { run() {} },");
});

Deno.test("isFixturePath: test/fixture paths warn, real paths refuse", () => {
  for (
    const p of [
      "tests/upgrade.test.ts",
      "src/test/fixtures.ts",
      "src/cell.test.ts",
      "src/fixtures/old.ts",
      "src/util/selftest.ts",
      "src/util/selftest/cases.ts",
      "src\\tests\\a.ts",
    ]
  ) assert(isFixturePath(p), `${p} should be a fixture path`);
  for (const p of ["src/cell.ts", "src/testimony.ts", "src/contest/x.ts"]) {
    assert(!isFixturePath(p), `${p} should NOT be a fixture path`);
  }
});

Deno.test("preflight: only the real config refuses; a fixture path is marked warn; both quote the line", async () => {
  const dir = await Deno.makeTempDir({ prefix: "aio-tokenized-" });
  try {
    const files: Record<string, string> = {
      "src/gen.ts": 'import { cell } from "aio";\n' + TEMPLATE + "cell;\n",
      "src/notes.ts": 'import { cell } from "aio";\n' + COMMENT + STRING +
        "cell;\n",
      "src/real.ts": 'import { cell } from "aio";\n' + REAL,
      "tests/upgrade.test.ts": 'import { cell } from "aio";\n' + REAL,
    };
    for (const [rel, body] of Object.entries(files)) {
      await Deno.mkdir(join(dir, rel, ".."), { recursive: true });
      await Deno.writeTextFile(join(dir, rel), body);
    }
    const found = await preflight(dir, "v1.0.0-alpha67");
    assertEquals(
      found.map((b) => [b.where, b.fixture]),
      [["src/real.ts:4", false], ["tests/upgrade.test.ts:4", true]],
    );
    const quoted = blockerLines(found[0]!);
    assertStringIncludes(quoted, "src/real.ts:4");
    assertStringIncludes(quoted, "| execute: { run() {} },");
    assertStringIncludes(quoted, "removed in");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
