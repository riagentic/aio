// `jump: true` marks a TIME-TRAVEL row only on a sync-reaction line
// (`SyncReaction.jump`, journal.ts). `planReplay` read it on every row, so a
// real user action whose own payload says `jump: true` — a platformer's
// `player:move {jump: true}` — was skipped as time travel, and `am replay`
// silently did not reproduce it.
import "./store-sandbox.ts";
import { assertEquals } from "@std/assert";
import { planReplay } from "../src/am/am-cmd-timeline.ts";
import { SYNC_REACTION_TYPE } from "../src/server/journal.ts";

Deno.test("planReplay: a user action with {jump: true} in its payload is SENT", () => {
  const plan = planReplay([
    { seq: 1, type: "player:move", payload: { args: [{ jump: true }] } },
    { seq: 2, type: "player:move", payload: { jump: true } },
  ]);
  assertEquals(plan.send.map((r) => r.seq), [1, 2]);
  assertEquals(plan.skip, []);
});

Deno.test("planReplay: a sync-reaction row with jump: true is still time travel", () => {
  const plan = planReplay([
    {
      seq: 1,
      type: SYNC_REACTION_TYPE,
      payload: { cell: "doc", at: 3, jump: true },
    },
    { seq: 2, type: SYNC_REACTION_TYPE, payload: { cell: "doc", at: 4 } },
  ]);
  assertEquals(plan.send, []);
  assertEquals(plan.skip.map((k) => k.reason), ["time-travel", "reaction"]);
});

Deno.test("planReplay: a disable's reset row is named as a reset, not hidden as internal", () => {
  // `<cell>:__destroy {reset: true}` is journalled since hunt round 4. Skipped
  // as "internal", the replay rebuilt ["a","after"] where the app had
  // ["after"] — and said nothing about why.
  const plan = planReplay([
    { seq: 1, type: "list:add", payload: { args: ["a"] } },
    { seq: 2, type: "list:__destroy", payload: { reset: true } },
    { seq: 3, type: "list:add", payload: { args: ["after"] } },
    { seq: 4, type: "list:__destroy" }, // a shutdown's: internal, as ever
  ]);
  assertEquals(plan.send.map((r) => r.seq), [1, 3]);
  assertEquals(plan.skip.map((k) => k.reason), ["reset", "internal"]);
});
