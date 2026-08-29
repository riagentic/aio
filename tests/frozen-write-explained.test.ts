// A frozen-state write is explained wherever it is LOGGED.
//
// Committed cell state is frozen, so writing to it throws the engine's own
// sentence — `Cannot assign to read only property 'n' of object '#<Object>'` —
// which names neither the cell, nor the rule, nor the fix. `immutable.ts` has
// been the authority for the sentence that DOES since alpha70, and it was
// wired into three places: the reducer, the test harnesses, and a browser-only
// listener.
//
// Everywhere else got the raw text. Measured on a running server: a route
// handler that writes `app.state.x = 1` — the first shape a new author reaches
// for — logged the engine's line and nothing more. And a global error listener
// could never have helped, because every one of those paths is CAUGHT by the
// framework before it becomes an uncaught error. What they all share is that
// they LOG. Found by `scripts/audit-round.ts 24`.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { _resetFrozenWriteHint, log } from "../src/diagnostics/logger-api.ts";
import {
  frozenWriteMessage,
  isFrozenWriteError,
} from "../src/state/immutable.ts";

/** Capture what the logger emitted at error level. */
function captured(fn: () => void): string[] {
  const lines: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  try {
    fn();
  } finally {
    console.error = orig;
  }
  return lines;
}

Deno.test("frozen write: logging the engine's text adds the explanation", () => {
  _resetFrozenWriteHint();
  const lines = captured(() => {
    log.error(
      `route "/x" (GET /x) threw — TypeError: Cannot assign to read only ` +
        `property 'n' of object '#<Object>'`,
    );
  });
  const all = lines.join("\n");
  assertStringIncludes(all, "read only property");
  assertStringIncludes(all, "which is frozen");
  assertStringIncludes(
    all,
    "METHOD",
    "the explanation must name the FIX, not only the rule",
  );
});

Deno.test("frozen write: every engine spelling is recognised", () => {
  for (
    const raw of [
      "Cannot assign to read only property 'n' of object '#<Object>'",
      "Cannot add property 1, object is not extensible",
      "Cannot delete property 'x' of #<Object>",
      "Cannot assign to read-only property",
    ]
  ) {
    assert(isFrozenWriteError(raw), raw);
    _resetFrozenWriteHint();
    const lines = captured(() => log.error(`something: ${raw}`));
    assertStringIncludes(lines.join("\n"), "frozen");
  }
});

Deno.test("frozen write: said ONCE, not once per tick", () => {
  // A frozen write in a hot path would otherwise repeat the same paragraph on
  // every tick, which trains people to skip logs.
  _resetFrozenWriteHint();
  let explained = 0;
  const orig = console.error;
  console.error = (...a: unknown[]) => {
    if (String(a.join(" ")).includes("which is frozen")) explained++;
  };
  try {
    for (let i = 0; i < 50; i++) {
      log.error("boom: Cannot assign to read only property 'n' of object");
    }
  } finally {
    console.error = orig;
  }
  assertEquals(explained, 1);
});

Deno.test("frozen write: an unrelated error is not decorated", () => {
  _resetFrozenWriteHint();
  const lines = captured(() => {
    log.error("fetch failed: connection refused");
    log.error("a route threw — TypeError: x is not a function");
  });
  assertEquals(
    lines.some((l) => l.includes("which is frozen")),
    false,
    "a message about anything else must not grow a paragraph about freezing",
  );
});

Deno.test("frozen write: the explanation names the cell when it is known", () => {
  const withCell = frozenWriteMessage("raw", "notes");
  assertStringIncludes(withCell, "notes");
  const without = frozenWriteMessage("raw");
  assertStringIncludes(without, "cell state");
  assert(!without.includes("undefined"), without);
});
