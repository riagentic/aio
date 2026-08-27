// errors that teach: one consistent what / fix / docs format for
// developer-facing framework errors, generalized from the credential refusal.
import { assert, assertEquals } from "@std/assert";
import { teachableError, teachMessage } from "../src/diagnostics/error.ts";

Deno.test("teachMessage: what + fix, optional docs, in the fixed format", () => {
  assertEquals(
    teachMessage("no cells to run", "pass cells: [...]"),
    "no cells to run\n  → fix: pass cells: [...]",
  );
  const withDoc = teachMessage("X happened", "do Y", "docs/z.md");
  assert(withDoc.includes("→ fix: do Y"));
  assert(withDoc.includes("→ docs: docs/z.md"));
});

// The prefix lives on ONE side, and it is the side with nowhere else to put it.
// `teachMessage` output goes to `log.warn`/`log.error`, which already print the
// category they inferred from the call site — a hand-written `[aio]` there made
// the line read `ERROR  aio  [aio] …`, the same fact twice. A thrown Error has
// no category column, so `teachableError` names its own source.
Deno.test("teachMessage carries no [aio] prefix; teachableError does", () => {
  assert(!teachMessage("a", "b").includes("[aio]"));
  assert(teachableError("a", "b").message.startsWith("[aio] a"));
});

Deno.test("teachableError: throwable, carries the teachable message", () => {
  const e = teachableError("boom", "fix it", "docs/a.md");
  assert(e instanceof Error);
  assert(e.message.startsWith("[aio] boom"));
  assert(e.message.includes("→ fix: fix it"));
});
