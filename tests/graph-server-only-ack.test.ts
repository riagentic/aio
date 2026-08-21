// `// aio-ok: server-only` — the acknowledgement path the warning never had.
//
// A field report launched for weeks with
// `⚠ src/cell/job.ts:292 — Deno.remove is server-only` on every start, pointing
// at a `finally` block inside a method that only ever runs on the server,
// cleaning up a file it had itself created. The rule is right in general and
// wrong there, and with no way to say so it became permanent noise printed next
// to the ✖ lines that genuinely break the client — which trains a developer to
// skim the one output they most need to read carefully.
//
// The line it must not cross: a WARNING is acknowledgeable ("this path never
// runs in the browser" is a claim only the author can make). A BLOCKING error
// is not ("this import exists in the browser build" is not a claim, it is a
// blank screen).
import { assertEquals } from "@std/assert";
import {
  BLOCKING_CATEGORIES,
  checkPlatformSafety,
  isServerOnlySuppressed,
} from "../src/server/graph-validator.ts";

Deno.test("server-only: a bare Deno.* use still warns", () => {
  const errs = checkPlatformSafety(
    `export function clean(p: string) {\n  Deno.remove(p);\n}\n`,
    "src/job.ts",
  );
  assertEquals(errs.length, 1);
  assertEquals(errs[0]!.category, "server-only-api");
  assertEquals(errs[0]!.line, 2);
});

Deno.test("server-only: the marker on the flagged line silences it", () => {
  const errs = checkPlatformSafety(
    `export function clean(p: string) {\n` +
      `  Deno.remove(p); // aio-ok: server-only — this method is server-side\n` +
      `}\n`,
    "src/job.ts",
  );
  assertEquals(errs, []);
});

Deno.test("server-only: the marker on the line ABOVE silences it", () => {
  // Where the reason belongs, and where `deno fmt` cannot move it — the same
  // lesson `aiol-ok` already learned.
  const errs = checkPlatformSafety(
    `export function clean(p: string) {\n` +
      `  // aio-ok: server-only — cleanup of a file this method itself made\n` +
      `  Deno.remove(p);\n` +
      `}\n`,
    "src/job.ts",
  );
  assertEquals(errs, []);
});

Deno.test("server-only: the marker silences ONE line, not the file", () => {
  const errs = checkPlatformSafety(
    `export function a(p: string) {\n` +
      `  Deno.remove(p); // aio-ok: server-only — acknowledged\n` +
      `  Deno.readTextFileSync(p);\n` +
      `}\n`,
    "src/job.ts",
  );
  assertEquals(errs.length, 1);
  assertEquals(errs[0]!.line, 3, "the un-acknowledged line must still warn");
});

Deno.test("server-only: a BLOCKING import cannot be acknowledged away", () => {
  const errs = checkPlatformSafety(
    `import { readFile } from "node:fs"; // aio-ok: server-only — nice try\n`,
    "src/job.ts",
  );
  assertEquals(errs.length, 1);
  assertEquals(
    errs[0]!.category,
    "server-only-import",
    "a guaranteed blank screen is not a matter of opinion — a silenceable " +
      "one would be worse than the noise this feature removes",
  );
  assertEquals(BLOCKING_CATEGORIES.has(errs[0]!.category), true);
});

Deno.test("server-only: a bare `// aio-ok` does NOT silence — the category is named", () => {
  const errs = checkPlatformSafety(
    `export function a(p: string) {\n` +
      `  // aio-ok — some other reason entirely\n` +
      `  Deno.remove(p);\n` +
      `}\n`,
    "src/job.ts",
  );
  assertEquals(
    errs.length,
    1,
    "a marker for one rule must not quietly cover another",
  );
});

Deno.test("isServerOnlySuppressed: a blank line breaks the association", () => {
  const lines = [
    "// aio-ok: server-only — justifies what, exactly?",
    "",
    "Deno.remove(p);",
  ];
  assertEquals(isServerOnlySuppressed(lines, 3), false);
  assertEquals(isServerOnlySuppressed(lines, 1), true);
});

Deno.test("server-only: the fix text tells you the marker exists", () => {
  const errs = checkPlatformSafety(`Deno.remove(p);\n`, "src/job.ts");
  assertEquals(
    errs[0]!.fix.includes("aio-ok: server-only"),
    true,
    "an escape hatch nobody can discover is not an escape hatch",
  );
});

// …and the acknowledgement has to be reachable in a REAL file, which is the
// half that was broken for as long as the feature existed.
//
// The scan ran over a copy of the source with comments deleted, and a deleted
// block comment takes its NEWLINES with it — under a comment claiming "line
// count preserved — replacements are same-line", true of `//` comments and
// false of every JSDoc block. A field report measured it: 681 lines, 39
// newlines destroyed, the `Deno.remove` on line 330 reported as line 326.
// `isServerOnlySuppressed` then read lines 325/326, found no marker, and the
// warning survived — so the escape hatch could not be used by any file with
// JSDoc in it, which is most files. The reporter moved the call into a
// `.server.ts` module instead, which is what the warning wanted, but the
// acknowledgement path was simply unreachable.
Deno.test("server-only: a JSDoc block above the call does not move the line", () => {
  const src = `/**
 * A doc comment, of the kind every method in a real file carries.
 * Three lines of it, so a collapsed block would shift by three.
 */
export function clean(p: string) {
  Deno.remove(p);
}
`;
  const errs = checkPlatformSafety(src, "src/job.ts");
  assertEquals(errs.length, 1);
  assertEquals(
    errs[0]!.line,
    6,
    "the line the reader sees — a line number nobody can find is worse " +
      "than no line number",
  );
  // The number is not decoration: this is what reads it.
  assertEquals(
    isServerOnlySuppressed(src.split("\n"), errs[0]!.line!),
    false,
    "no marker here yet",
  );
});

Deno.test("server-only: the marker works in a file full of block comments", () => {
  const src = `/** Header.
 *  Two lines.
 */
const tmp = (p: string) => p + "/tmp";

/**
 * Another block, further down.
 * With more lines in it.
 * And more.
 */
export function clean(p: string) {
  // aio-ok: server-only — this method only ever runs on the server
  Deno.remove(tmp(p));
}
`;
  assertEquals(
    checkPlatformSafety(src, "src/job.ts"),
    [],
    "the acknowledgement must be findable after any number of block comments",
  );
});

// The general property, so this cannot regress by one line rather than by all
// of them: wherever the call sits, the reported line is the line it is on.
Deno.test("server-only: reported line == real line, at every depth", () => {
  for (let blocks = 0; blocks < 6; blocks++) {
    for (let extra = 0; extra < 4; extra++) {
      const header = Array.from(
        { length: blocks },
        (_, i) => `/**\n${" *  x\n".repeat(extra)} *  block ${i}\n */\n`,
      ).join("");
      const src =
        `${header}export function clean(p: string) {\n  Deno.remove(p);\n}\n`;
      const trueLine = src.split("\n").findIndex((l) =>
        l.includes("Deno.remove")
      ) + 1;
      const errs = checkPlatformSafety(src, "src/job.ts");
      assertEquals(errs.length, 1, `blocks=${blocks} extra=${extra}`);
      assertEquals(
        errs[0]!.line,
        trueLine,
        `blocks=${blocks} extra=${extra}: reported ${
          errs[0]!.line
        }, actually ${trueLine}`,
      );
    }
  }
});

// A `Deno.` mentioned INSIDE a doc comment or a string is not a use of it —
// the masking half of the same change, which the old strip also did (by
// deletion) and must keep doing.
Deno.test("server-only: a Deno.* inside a comment or a string is not a call", () => {
  const src = `/** Do not call Deno.remove here. */
export const hint = "run Deno.remove yourself";
export function safe() {
  return hint;
}
`;
  assertEquals(checkPlatformSafety(src, "src/job.ts"), []);
});
