// A `listensTo` reaction journalled as data (aio.ts `_journalReaction`) is
// neither an action nor a time-travel jump, and the journal's readers must not
// report it as either: `am record` printed "the run TIME-TRAVELLED (1 jump)"
// for a run that never jumped, and `am replay` listed it as a skipped jump
// (external review, rev4). The user's own jumps still read as jumps.
//
// A reaction a SYNC OP caused is the one kind the journal cannot re-create:
// the op is in the op-log, not the journal. It is said as exactly that —
// and counted like a jump in `am record` — never skipped in silence (rev7).
import { assert, assertEquals } from "@std/assert";
import { generateReplayTest } from "../src/am/record.ts";
import { planReplay } from "../src/am/am-cmd-timeline.ts";
import {
  isListenerReaction,
  isSyncOpReaction,
  LISTENS_TO_CMD,
  LISTENS_TO_SYNC_OP_CMD,
  SYNC_REACTION_TYPE,
  TT_RESTORE_TYPE,
} from "../src/server/journal.ts";

const syncReaction = {
  seq: 2,
  ts: 1,
  type: SYNC_REACTION_TYPE,
  payload: { cell: "mirror", at: 7, state: { got: ["a"] } },
};
const kvReaction = {
  seq: 3,
  ts: 1,
  type: TT_RESTORE_TYPE,
  payload: { cmd: LISTENS_TO_CMD, cells: { tally: { n: 1 } } },
};
const jump = {
  seq: 4,
  ts: 1,
  type: TT_RESTORE_TYPE,
  payload: { cmd: "undo", cells: { tally: { n: 0 } } },
};
const call = { seq: 1, ts: 1, type: "inbox:post", payload: { args: ["p"] } };
const syncOpSync = {
  seq: 5,
  ts: 1,
  type: SYNC_REACTION_TYPE,
  payload: { cell: "mirror", at: 9, ops: [], base: 2, bySyncOp: true },
};
const syncOpKv = {
  seq: 6,
  ts: 1,
  type: TT_RESTORE_TYPE,
  payload: { cmd: LISTENS_TO_SYNC_OP_CMD, cells: {}, deltas: { tally: {} } },
};

Deno.test("journal readers: a listensTo reaction line is a reaction, not a jump or a call", () => {
  assert(isListenerReaction(syncReaction));
  assert(isListenerReaction(kvReaction));
  assert(!isListenerReaction(jump), "the user's own jump stays a jump");
  assert(!isListenerReaction(call));

  const plan = planReplay([call, syncReaction, kvReaction, jump]);
  assertEquals(plan.send.map((r) => r.seq), [1], "only the call is sent");
  assertEquals(
    plan.skip.map((s) => [s.seq, s.reason]),
    [[2, "reaction"], [3, "reaction"], [4, "time-travel"]],
  );

  const quiet = generateReplayTest([call, syncReaction, kvReaction]);
  assert(!quiet.includes("TIME-TRAVELLED"), quiet);
  assert(!quiet.includes("sync op"), quiet);
  assert(quiet.includes('await inbox.post("p");'), quiet);
  const loud = generateReplayTest([call, kvReaction, jump]);
  assert(loud.includes("TIME-TRAVELLED (1 jump)"), loud);
});

Deno.test("journal readers: a reaction a sync op caused is said to be unreproduced, never skipped silently", () => {
  for (const e of [syncOpSync, syncOpKv]) {
    assert(isListenerReaction(e) && isSyncOpReaction(e), e.type);
  }
  for (const e of [syncReaction, kvReaction, jump, call]) {
    assert(!isSyncOpReaction(e), e.type);
  }
  const plan = planReplay([call, syncOpSync, syncOpKv, syncReaction]);
  assertEquals(
    plan.skip.map((s) => [s.seq, s.reason]),
    [[5, "sync-reaction"], [6, "sync-reaction"], [2, "reaction"]],
  );
  const flow = generateReplayTest([call, syncOpSync, syncOpKv]);
  assert(
    flow.includes(
      "2 listensTo reactions in this run were caused by a sync op",
    ) &&
      flow.includes("not in the journal — not reproduced"),
    flow,
  );
  assert(!flow.includes("TIME-TRAVELLED"), flow);
});
