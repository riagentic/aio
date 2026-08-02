// errors that teach: one consistent what / fix / docs format for
// developer-facing framework errors, generalized from the credential refusal.
import { assert, assertEquals } from "@std/assert";
import { teachableError, teachMessage } from "../src/diagnostics/error.ts";

Deno.test("teachMessage: what + fix, optional docs, in the fixed format", () => {
  assertEquals(
    teachMessage("no cells to run", "pass cells: [...]"),
    "[aio] no cells to run\n  → fix: pass cells: [...]",
  );
  const withDoc = teachMessage("X happened", "do Y", "docs/z.md");
  assert(withDoc.includes("→ fix: do Y"));
  assert(withDoc.includes("→ docs: docs/z.md"));
});

Deno.test("teachableError: throwable, carries the teachable message", () => {
  const e = teachableError("boom", "fix it", "docs/a.md");
  assert(e instanceof Error);
  assert(e.message.startsWith("[aio] boom"));
  assert(e.message.includes("→ fix: fix it"));
});
