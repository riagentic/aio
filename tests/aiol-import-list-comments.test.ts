// The import-list rewriters split `{…}` on "," and re-joined the pieces on ONE
// line. A `// comment` after the last specifier (common in a multi-line
// import) then swallowed the rest of the statement: `} from "aio";` landed
// inside the comment and --safe-fix left a file that did not parse.
//   • scheduleBlockingToTop (schedule.blocking → blocking) appended
//     `, blocking } from "aio"` after the comment;
//   • renameWords re-joined EVERY `import {…} from "aio…"` in the file, even
//     one the rename never touched;
//   • renameWords turned `{ Access, type CellAccess }` into
//     `{ Access, type Access }` — a duplicate binding, a compile error.
// Every rewriter now goes through ONE helper (`rewriteImportLists`) that
// splices into the original layout and leaves untouched statements alone.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  aliasRename,
  fixMovedImports,
  moveImports,
  pruneOrphanedEffectTypeImports,
  renameWords,
  scheduleBlockingToTop,
} from "../aiol/fixes.ts";
import { moduleStatements } from "../aiol/scan.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

Deno.test("scheduleBlockingToTop: a trailing // comment in the aio import survives", () => {
  const src =
    `import {\n  cell,\n  schedule, // the scheduler\n} from "aio";\n` +
    `schedule.blocking("a", f, 1);\n`;
  assertEquals(
    scheduleBlockingToTop(src),
    `import {\n  cell,\n  schedule, blocking, // the scheduler\n} from "aio";\n` +
      `blocking("a", f, 1);\n`,
  );
});

Deno.test("scheduleBlockingToTop: a one-line import still gains the name", () => {
  assertEquals(
    scheduleBlockingToTop(
      `import { cell, schedule } from "aio";\nschedule.blocking("a", f, 1);\n`,
    ),
    `import { cell, schedule, blocking } from "aio";\nblocking("a", f, 1);\n`,
  );
});

Deno.test("renameWords: an unrelated aio import with a trailing comment is not touched", () => {
  const untouched =
    `import {\n  cell,\n  schedule, // timers\n} from "aio/server";\n`;
  const src = `import type { CellAccess } from "aio";\n` + untouched +
    `export type X = CellAccess;\n`;
  assertEquals(
    renameWords(src, [["CellAccess", "Access"]]),
    `import type { Access } from "aio";\n` + untouched +
      `export type X = Access;\n`,
  );
});

Deno.test("renameWords: a rename never binds the same name twice", () => {
  // In one statement: the value binding also serves the type position.
  assertEquals(
    renameWords(
      `import { Access, type CellAccess } from "aio";\n` +
        `export type X = CellAccess<S>;\nconst a: Access<S> = 1;\n`,
      [["CellAccess", "Access"]],
    ),
    `import { Access } from "aio";\n` +
      `export type X = Access<S>;\nconst a: Access<S> = 1;\n`,
  );
  // Across statements: the emptied type-only import goes, with its line.
  assertEquals(
    renameWords(
      `import type { CellAccess } from "aio";\nimport { Access } from "aio";\n` +
        `export type X = CellAccess<S>;\n`,
      [["CellAccess", "Access"]],
    ),
    `import { Access } from "aio";\nexport type X = Access<S>;\n`,
  );
});

Deno.test("moveImports: a commented multi-line list keeps its comments and parses", () => {
  const src =
    `import {\n  cell, // the factory\n  testCell,\n  signal, // reactive\n} from "aio";\n`;
  assertEquals(
    moveImports(src, {
      from: "aio",
      to: "aio/testing",
      names: new Set(["testCell"]),
    }),
    `import {\n  cell, // the factory\n  signal, // reactive\n} from "aio";\n` +
      `import { testCell } from "aio/testing";\n`,
  );
  // Everything moves: only the specifier changes, the layout stays.
  assertEquals(
    moveImports(`import {\n  testCell, // harness\n} from "aio";\n`, {
      from: "aio",
      to: "aio/testing",
      names: new Set(["testCell"]),
    }),
    `import {\n  testCell, // harness\n} from "aio/testing";\n`,
  );
});

Deno.test("moveImports: a declined rewrite is still a finding, and the fix says 'not fixed'", async () => {
  // A target spec with a quote reads back as a different spec, so
  // rewriteImportLists declines. fixMovedImports used to rewrite the file
  // identically and report "fixed" while the finding stayed — and the rule
  // (which asks moveImports whether the import needs moving) must still
  // report it: a declined fix is a manual fix, never silence.
  const mv = { from: "aio", to: 'aio"x', names: new Set(["testCell"]) };
  for (
    const src of [
      `import { testCell } from "aio";\n`,
      `import { cell, testCell } from "aio";\n`,
    ]
  ) {
    assert(moveImports(src, mv) !== null, `the rule must still see ${src}`);
    const dir = await tempDir("aiol-move-declined-");
    try {
      const f = join(dir, "a.ts");
      await Deno.writeTextFile(f, src);
      assertEquals(await fixMovedImports(f, mv)(), false, src);
      assertEquals(await Deno.readTextFile(f), src);
    } finally {
      await dropTempDir(dir);
    }
  }
});

Deno.test("import lists: a quoted import name is read and rewritten as written", () => {
  // `codeText` blanks string bodies; the entry text was taken from it, so
  // `"x-y" as xy` read as `" " as xy`, was WRITTEN back that way, and the
  // readback — the same scanner — agreed with the corruption.
  assertEquals(
    moduleStatements(`import { "a  b" as x, y } from "m";`)[0]!.list!.entries
      .map((e) => e.text),
    [`"a  b" as x`, "y"],
  );
  const mv = { from: "aio", to: "aio/testing", names: new Set(["testCell"]) };
  assertEquals(
    moveImports(`import { cell, "x-y" as xy, testCell } from "aio";\n`, mv),
    `import { cell, "x-y" as xy } from "aio";\n` +
      `import { testCell } from "aio/testing";\n`,
  );
  assertEquals(
    moveImports(
      `import {\n  'a,b' as ab, // q\n  testCell,\n} from "aio";\n`,
      mv,
    ),
    `import {\n  'a,b' as ab, // q\n} from "aio";\n` +
      `import { testCell } from "aio/testing";\n`,
  );
});

Deno.test("import lists: an import attribute clause travels with every emitted import", () => {
  const mv = { from: "aio", to: "aio/testing", names: new Set(["testCell"]) };
  for (const kw of ["with", "assert"]) {
    const attrs = ` ${kw} { type: "json" }`;
    // Split: both halves keep the clause, and the statement stays whole.
    assertEquals(
      moveImports(`import { cell, testCell } from "aio"${attrs};\ngo;\n`, mv),
      `import { cell } from "aio"${attrs};\n` +
        `import { testCell } from "aio/testing"${attrs};\ngo;\n`,
    );
    // Everything moves: only the specifier changes.
    assertEquals(
      moveImports(`import { testCell } from "aio"${attrs};\n`, mv),
      `import { testCell } from "aio/testing"${attrs};\n`,
    );
  }
  // A statement that loses every name goes WITH its clause.
  assertEquals(
    pruneOrphanedEffectTypeImports(
      `import { type CellEffect } from "aio" with { type: "json" };\nlet a;\n`,
    ),
    `let a;\n`,
  );
});

Deno.test("aliasRename: only the statement holding the name is rewritten", () => {
  const other = `import {\n  parseCli, // flags\n} from "aio/extras";\n`;
  assertEquals(
    aliasRename(
      `import { lint } from "aio/extras";\n` + other,
      "aio/extras",
      "lint",
      "checkCells",
    ),
    `import { checkCells as lint } from "aio/extras";\n` + other,
  );
});

Deno.test("pruneOrphanedEffectTypeImports: a commented multi-line list survives", () => {
  assertEquals(
    pruneOrphanedEffectTypeImports(
      `import {\n  cell, // the factory\n  type CellEffect,\n} from "aio";\nexport const c = cell;\n`,
    ),
    `import {\n  cell, // the factory\n} from "aio";\nexport const c = cell;\n`,
  );
});
