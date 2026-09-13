// `redactActions: ["*"]` is the BROADEST thing an operator can write, and it
// was the only spelling that leaked.
//
// The cell set was built as `p.replace(/\*$/, "")`, which for the bare `"*"`
// is `""` — dropped by an `if (name)` guard. So the pattern that means
// "redact everything" named NO cells, and every cells-scoped sink no-opped:
// `logs/checkpoint.json`, the timeline's diffs, the `state-diff` debug log,
// and the problem report's withheld list.
//
// Measured end to end, same app, same dispatch, only the pattern differing:
//
//   ["vault:*"]  actions.jsonl redacted   checkpoint {"vault":"[redacted]"}
//   ["*"]        actions.jsonl redacted   checkpoint {"vault":{"pass":"…"}}
//
// The action journal was clean both ways, which is what makes it dangerous: an
// operator checking the obvious sink sees a redaction and stops looking.
// `redact.ts`'s own header calls "the app plugs one leak and keeps another"
// the failure the module exists to end, and records the same shape shipping
// once before for bare cell names.
import { assert, assertEquals } from "@std/assert";
import { makeRedactor } from "../src/diagnostics/redact.ts";

Deno.test('redact: "*" names every cell, not none', () => {
  const star = makeRedactor(["*"]);
  assertEquals(star("vault:unlockWith"), true, "the action half always worked");
  assertEquals(
    star.redactsAnyCell(),
    true,
    "the broadest pattern must have something to do — `cells.size === 0` read " +
      'as "nothing is redacted" and every state sink skipped',
  );
  for (const cell of ["vault", "user", "anything"]) {
    assertEquals(star.redactsCell(cell), true, `redactsCell(${cell})`);
  }
  // `"*:*"` and `"*:anything"` name every cell too.
  assert(makeRedactor(["*:*"]).redactsCell("vault"));
  assert(makeRedactor(["*:unlockWith"]).redactsCell("vault"));
});

Deno.test("redact: a narrow pattern still scopes to its own cell", () => {
  // The control — an "all" that swallowed every pattern would pass the test
  // above and redact a whole app's state for one cell's secret.
  const one = makeRedactor(["vault:*"]);
  assertEquals(one.redactsCell("vault"), true);
  assertEquals(one.redactsCell("todos"), false, "…and nothing else");
  assertEquals(one.redactsAnyCell(), true);

  const none = makeRedactor([]);
  assertEquals(none.redactsAnyCell(), false);
  assertEquals(none.redactsCell("vault"), false);
});

Deno.test("redact: the checkpoint withholds the slice for every pattern that covers it", async () => {
  const { _redactCheckpointState } = await import(
    "../src/diagnostics/checkpoint.ts"
  ) as unknown as {
    _redactCheckpointState: (
      s: Record<string, unknown>,
      r: ReturnType<typeof makeRedactor>,
    ) => Record<string, unknown>;
  };
  const state = { vault: { pass: "FAKE-NOT-REAL" }, ui: { tab: "home" } };
  for (const pattern of [["*"], ["vault:*"], ["vault"], ["vault:"]]) {
    const out = _redactCheckpointState(state, makeRedactor(pattern));
    assertEquals(
      out.vault,
      "[redacted]",
      `redactActions: ${JSON.stringify(pattern)} must withhold the slice — ` +
        `this file is written to disk`,
    );
  }
  // …and an unmatched cell is untouched by a narrow pattern.
  const narrow = _redactCheckpointState(state, makeRedactor(["vault:*"]));
  assertEquals(narrow.ui, { tab: "home" });
});

// …and on disk, which is where it actually mattered. The pure test above
// cannot see a sink that reads the redactor correctly and writes anyway, so
// this drives the real writer at a real path and greps the bytes.
Deno.test("redact: `*` keeps the secret out of the checkpoint FILE", async () => {
  const { createCheckpoint } = await import("../src/diagnostics/checkpoint.ts");
  const { tempDir } = await import("../src/testing/temp-dir.ts");
  const SECRET = "FAKE-NOT-REAL-passphrase";
  const data = {
    ts: Date.now(),
    state: { vault: { pass: SECRET }, ui: { tab: "home" } },
    recentActions: ["vault:unlockWith"],
  };

  for (const patterns of [["*"], ["vault:*"], ["vault"]]) {
    const dir = await tempDir("aio-redact-file-");
    try {
      const cp = createCheckpoint(dir, 0, makeRedactor(patterns));
      // deno-lint-ignore no-explicit-any
      await cp.write(data as any);
      await cp.flush();
      const written = await Deno.readTextFile(`${dir}/checkpoint.json`);
      assertEquals(
        written.includes(SECRET),
        false,
        `redactActions: ${JSON.stringify(patterns)} wrote the secret to a ` +
          `file on disk: ${written.slice(0, 160)}`,
      );
      assert(
        written.includes("redacted"),
        `…and must SAY the slice was withheld: ${written.slice(0, 160)}`,
      );
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  }
});
