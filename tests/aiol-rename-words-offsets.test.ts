// `renameWords` (the --safe-fix for connectDevTools → connectReduxDevTools,
// CellAccess → Access, …) mapped each match offset "back to the original via
// the running shift". But String.replace already hands the callback offsets
// into its INPUT string, so subtracting the shift read the code mask at the
// wrong place. After the import was renamed (+5 chars), a call on the line
// under a comment was judged "inside the comment" and left alone: the fix
// renamed the import and orphaned the call — the file no longer type-checked.
// With several renames the mask (of the ORIGINAL text) was also read against
// the already-rewritten text of the later passes.
import { assert, assertEquals } from "@std/assert";
import { renameWords } from "../aiol/fixes.ts";

Deno.test("renameWords: a call below a comment is renamed together with its import", () => {
  const src = `import { connectDevTools } from "aio";\n` +
    `// wire the redux devtools in dev\n` +
    `connectDevTools(counter);\n`;
  const out = renameWords(src, [["connectDevTools", "connectReduxDevTools"]]);
  assert(out !== null);
  assertEquals(
    out,
    `import { connectReduxDevTools } from "aio";\n` +
      `// wire the redux devtools in dev\n` +
      `connectReduxDevTools(counter);\n`,
  );
});

Deno.test("renameWords: several renames read the mask of the text each pass scans", () => {
  // Pass 1 shortens `CellAccess` → `Access` (-4 per hit), so every offset of
  // pass 2 moves; a mask of the original text then misjudges comment/string
  // boundaries for `ExtractState`.
  const src = `import type { CellAccess, ExtractState } from "aio";\n` +
    `type A = CellAccess<S>; type B = CellAccess<S>; type C = CellAccess<S>;\n` +
    `// ExtractState in a comment stays\n` +
    `type D = ExtractState<typeof c>;\n` +
    `const note = "ExtractState in a string stays";\n`;
  const out = renameWords(src, [
    ["CellAccess", "Access"],
    ["ExtractState", "StateOf"],
  ]);
  assertEquals(
    out,
    `import type { Access, StateOf } from "aio";\n` +
      `type A = Access<S>; type B = Access<S>; type C = Access<S>;\n` +
      `// ExtractState in a comment stays\n` +
      `type D = StateOf<typeof c>;\n` +
      `const note = "ExtractState in a string stays";\n`,
  );
});
