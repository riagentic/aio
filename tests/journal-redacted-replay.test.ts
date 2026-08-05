// A redacted action cannot be replayed — so it must never be silently offered
// for replay.
//
// `redactActions` replaces an action's payload with "[redacted]". For a
// `cell:method` action the payload IS its arguments, so the entry that remains
// is not a degraded record of the call — it is an unusable one. Boot replayed
// it anyway:
//
//   aio.run({ cells: [vault], journal: true, redactActions: ["vault:*"] })
//
// — the documented configuration, verbatim from
// `docs/persistence/where-files-live.md` — made `aio.run()` REJECT with
// "Cannot read properties of undefined (reading 'length')", because the method
// ran with no arguments. The journal tail persists, so every restart after that
// failed identically until a human deleted the file by hand. A reducer that
// tolerates missing arguments got the quiet version: a wrong recovered state,
// reported as a successful recovery.
//
// The decision: skip it, and SAY SO. Not "journal a marker replay guesses at"
// (a guess is what produced the wrong state) and not "don't journal it at all"
// (the fact that the action happened, and where in the sequence, is the part
// redaction explicitly promises to keep — and `am timeline` shows it). The
// entry is written with a `redacted: true` refusal marker, replay skips it, and
// boot reports exactly which actions could not be reconstructed.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { aio } from "../src/server/aio.ts";
import { cell } from "../src/state/cell-create.ts";
import { _resetAioRuntime } from "../src/state/runtime-reset.ts";
import {
  createJournal,
  isUnreplayable,
  type JournalEntry,
  replayJournal,
} from "../src/server/journal.ts";
import { makeRedactor, REDACTED } from "../src/diagnostics/redact.ts";
import { generateReplayTest, isRedactedRow } from "../src/am/record.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

const SECRET = "correct-horse-battery-staple";

// ─── The marker, on disk ────────────────────────────────────────────────────

Deno.test("redacted journal entry carries a refusal marker, not just a blank payload", async () => {
  const dir = await Deno.makeTempDir({ prefix: "aio-jrr-mark-" });
  try {
    const path = `${dir}/j`;
    const j = createJournal(path, { redact: makeRedactor(["vault:*"]) });
    j.append({ type: "vault:unlockWith", payload: { args: [SECRET] } }, 1);
    j.append({ type: "notes:add", payload: { args: ["hi"] } }, 2);
    const lines = (await Deno.readTextFile(path)).trim().split("\n").map((l) =>
      JSON.parse(l)
    );
    assertEquals(lines[0].payload, REDACTED);
    assertEquals(
      lines[0].redacted,
      true,
      "replay must be able to refuse the entry without sniffing a sentinel " +
        "string — and the file outlives the config that redacted it",
    );
    assertEquals(
      lines[1].redacted,
      undefined,
      "unlisted actions are untouched",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ─── replayJournal refuses, and accounts for it ─────────────────────────────

type S = { n: number };
const reduce = (s: S, a: { type: string; payload?: unknown }) =>
  a.type === "add"
    ? { state: { n: s.n + (a.payload as { args: number[] }).args[0]! } }
    : { state: s };

Deno.test("replayJournal: a redacted entry is skipped and REPORTED, never replayed", () => {
  const entries: JournalEntry[] = [
    { seq: 1, type: "add", payload: { args: [5] }, ts: 0 },
    { seq: 2, type: "add", payload: REDACTED, ts: 0, redacted: true },
    { seq: 3, type: "add", payload: { args: [7] }, ts: 0 },
  ];
  const r = replayJournal({ n: 0 }, entries, reduce);
  assertEquals(r.state, { n: 12 }, "the replayable entries still replay");
  assertEquals(r.replayed, 2);
  assertEquals(r.skipped, [{ seq: 2, type: "add", reason: "redacted" }]);
});

Deno.test("replayJournal: a pre-marker journal (bare sentinel) is refused too", () => {
  // A file written before the marker existed still has to be safe to boot on.
  const entries: JournalEntry[] = [
    { seq: 1, type: "add", payload: REDACTED, ts: 0 },
  ];
  assertEquals(isUnreplayable(entries[0]!), true);
  const r = replayJournal({ n: 0 }, entries, reduce);
  assertEquals(r.state, { n: 0 });
  assertEquals(r.skipped.length, 1);
});

// ─── The whole point: boot survives ─────────────────────────────────────────

const vault = cell("jrr_vault", {
  state: { open: false, key: "" },
  methods: {
    unlockWith(s: { open: boolean; key: string }, passphrase: string) {
      // A realistic reducer: it TOUCHES the argument. Replayed with none, this
      // is the throw that took the whole boot down.
      s.key = passphrase.slice(0, passphrase.length);
      s.open = true;
    },
  },
});

Deno.test("boot: journal + redactActions is bootable, and says what it could not recover", async () => {
  const dir = await Deno.makeTempDir({ prefix: "aio-jrr-boot-" });
  try {
    // The tail a crash leaves behind, under the documented configuration.
    await Deno.writeTextFile(
      `${dir}/data.db.journal`,
      JSON.stringify({
        seq: 1,
        type: "jrr_vault:unlockWith",
        payload: REDACTED,
        ts: 1,
        redacted: true,
      }) + "\n",
    );

    // The logger writes through console.log (logger-format.ts), so capture
    // that — the assertion is about what the OPERATOR sees.
    const warnings: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => {
      warnings.push(a.map(String).join(" "));
    };

    _resetAioRuntime();
    let app: Any;
    try {
      app = await aio.run({
        cells: [vault],
        appId: "jrr",
        journal: true,
        redactActions: ["jrr_vault:*"],
        dbPath: `${dir}/data.db`,
        libraryMode: true,
        client: "server-only",
        baseDir: dir,
      } as Any);
    } finally {
      console.log = origLog;
    }

    // 1. It BOOTED. This is the bug: aio.run() used to reject, and the tail
    //    persists, so every restart failed the same way forever.
    assert(app, "aio.run() must not reject because an action was redacted");
    // 2. The redacted action did NOT half-apply.
    assertEquals(
      (app.getState() as Any).jrr_vault,
      { open: false, key: "" },
      "a skipped entry must leave no partial effect",
    );
    // 3. The user was TOLD. Recovery that quietly drops writes is the same
    //    lie in a quieter register.
    const said = warnings.join("\n");
    assertStringIncludes(said, "COULD NOT be replayed");
    assertStringIncludes(said, "jrr_vault:unlockWith");
    assertStringIncludes(said, "redactActions");

    await app.close();
    _resetAioRuntime();
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

// ─── `am record` / `am replay` agree with replay ────────────────────────────

Deno.test("am record: a redacted action becomes a marked gap, not a bogus call", () => {
  const src = generateReplayTest([
    { type: "vault:unlockWith", payload: REDACTED, redacted: true },
    { type: "notes:add", payload: { args: ["hi"] } },
  ]);
  assert(
    !/await vault\.unlockWith\(\);/.test(src),
    `a "runnable replay test" that calls unlockWith() with no arguments ` +
      `reproduces something other than what happened:\n${src}`,
  );
  assertStringIncludes(src, "UNREPRODUCIBLE");
  assertStringIncludes(src, "INCOMPLETE until you fill");
  assertStringIncludes(src, 'await notes.add("hi");');
});

Deno.test("am replay: a redacted row is refused, not dispatched as the literal string", () => {
  assertEquals(isRedactedRow({ payload: REDACTED }), true);
  assertEquals(isRedactedRow({ payload: undefined, redacted: true }), true);
  assertEquals(isRedactedRow({ payload: { args: [1] } }), false);
});
