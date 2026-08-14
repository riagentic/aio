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
