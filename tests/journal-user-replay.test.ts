// Replay ran every journalled action as NOBODY, and a throwing entry killed
// the boot.
//
// Two defects in one recovery path:
//
//  • **Identity was not recorded.** A method that reads `serverUser()` — an
//    authorization check, an "own rows only" filter, a per-caller quota — is a
//    DIFFERENT function under a different caller. Replaying it as `undefined`
//    either throws (best case) or silently reduces to the wrong state (worst),
//    and the wrong state is then persisted as the recovered truth.
//  • **A throw was fatal, forever.** The journal tail survives the crash, so an
//    entry that throws on boot throws on the NEXT boot too: `aio.run()`
//    rejected identically every time until a human deleted the file. Recovery
//    must never be the reason a process cannot start — so a rejected entry is
//    skipped, reported, and the app comes up.
import { assertEquals } from "@std/assert";
import { runWithUser, serverUser } from "../src/server/auth-context.ts";
import {
  createJournal,
  type JournalEntry,
  replayJournal,
} from "../src/server/journal.ts";
import type { AioUser } from "../src/server/aio-types.ts";

type S = { seen: string[]; n: number };
const ALICE: AioUser = { id: "alice", role: "admin" };

const entry = (
  seq: number,
  type: string,
  extra: Partial<JournalEntry> = {},
): JournalEntry => ({ seq, type, ts: 1, ...extra });

// ── identity ────────────────────────────────────────────────────────────

Deno.test("journal: replay runs each action under the user that dispatched it", () => {
  const reduce = (s: S): { state: S } => ({
    // The method's own view of who is calling — the whole point of recording it.
    state: { ...s, seen: [...s.seen, serverUser()?.id ?? "nobody"] },
  });

  const r = replayJournal<S, { type: string }>(
    { seen: [], n: 0 },
    [
      entry(1, "notes:add", { user: ALICE }),
      entry(2, "notes:add"), // server-origin (a schedule, an effect)
      entry(3, "notes:add", { user: { id: "bob", role: "user" } }),
    ],
    reduce,
  );

  assertEquals(
    r.state.seen,
    ["alice", "nobody", "bob"],
    "replaying everything as nobody is what made a per-caller method recover " +
      "the wrong state — silently",
  );
  assertEquals(r.replayed, 3);
  assertEquals(r.skipped, []);
});

Deno.test("journal: the appended entry carries the caller, and only when there is one", async () => {
  const dir = await Deno.makeTempDir({ prefix: "aio-journal-user-" });
  try {
    const j = createJournal(`${dir}/journal`);
    j.append({ type: "notes:add", payload: { a: 1 }, user: ALICE }, 1);
    j.append({ type: "notes:tick" }, 2); // a schedule — nobody dispatched it
    j.close();

    const rows = createJournal(`${dir}/journal`).readSince(0);
    assertEquals(rows.length, 2);
    assertEquals(rows[0]!.user, ALICE);
    assertEquals(
      rows[1]!.user,
      undefined,
      "absent, not a fake user — `undefined` is exactly what it ran under",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("journal: the ambient user is restored, not leaked past replay", () => {
  const reduce = (s: S): { state: S } => ({
    state: { ...s, seen: [...s.seen, serverUser()?.id ?? "nobody"] },
  });
  runWithUser({ id: "outer", role: "user" }, () => {
    replayJournal<S, { type: string }>({ seen: [], n: 0 }, [
      entry(1, "x", { user: ALICE }),
    ], reduce);
    assertEquals(
      serverUser()?.id,
      "outer",
      "replay must not bleed its impersonation into the caller's context",
    );
  });
});

// ── a rejected entry must not become an unbootable app ───────────────────

Deno.test("journal: an entry the reducer REJECTS is skipped, named, and survivable", () => {
  const reduce = (s: S, a: { type: string }): { state: S } => {
    if (a.type === "notes:poison") throw new Error("guard no longer holds");
    return { state: { ...s, n: s.n + 1 } };
  };

  const r = replayJournal<S, { type: string }>(
    { seen: [], n: 0 },
    [
      entry(1, "notes:add"),
      entry(2, "notes:poison"),
      entry(3, "notes:add"),
    ],
    reduce,
  );

  assertEquals(r.replayed, 2, "the entries AROUND the bad one still apply");
  assertEquals(r.state.n, 2);
  assertEquals(r.skipped.length, 1);
  assertEquals(r.skipped[0]!.seq, 2);
  assertEquals(r.skipped[0]!.reason, "threw");
  assertEquals(
    r.skipped[0]!.error?.includes("guard no longer holds"),
    true,
    "the reducer's own message is the only clue to WHY — dropping it leaves " +
      "an operator with a seq number and nothing else",
  );
});

Deno.test("journal: a poison entry does not come back to kill the next boot", () => {
  // The bug this closes: the tail persists, so a fatal replay is fatal every
  // time. Replaying the SAME entries twice must be stable, not compounding.
  const reduce = (s: S, a: { type: string }): { state: S } => {
    if (a.type === "boom") throw new Error("nope");
    return { state: { ...s, n: s.n + 1 } };
  };
  const entries = [entry(1, "ok"), entry(2, "boom")];

  const first = replayJournal<S, { type: string }>(
    { seen: [], n: 0 },
    entries,
    reduce,
  );
  const second = replayJournal<S, { type: string }>(
    { seen: [], n: 0 },
    entries,
    reduce,
  );
  assertEquals([first.replayed, first.skipped.length], [1, 1]);
  assertEquals(
    [second.replayed, second.skipped.length],
    [1, 1],
    "boot #2 recovers exactly as far as boot #1 — no crash, no drift",
  );
});

Deno.test("journal: redacted and threw are told apart", () => {
  const reduce = (s: S, a: { type: string }): { state: S } => {
    if (a.type === "boom") throw new Error("x");
    return { state: s };
  };
  const r = replayJournal<S, { type: string }>(
    { seen: [], n: 0 },
    [entry(1, "vault:unlock", { redacted: true }), entry(2, "boom")],
    reduce,
  );
  assertEquals(r.skipped.map((s) => s.reason), ["redacted", "threw"]);
  assertEquals(
    r.skipped[0]!.error,
    undefined,
    "a policy skip has no reducer error to report, and must not invent one",
  );
});
