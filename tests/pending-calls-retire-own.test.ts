// A finished call retires ITS OWN start number, not the oldest one.
//
// `pendingAmong(starts)` answers "is a call started since T still running?"
// — what a controlled field asks before it shows a refusal (control-drift.ts,
// prop-write.ts). Calls to one method answer out of order, and a finish used
// to retire the OLDEST number: with an older call to the same method in
// flight, the newer call's own end left its number pending (the field held
// the refusal back) and took the older call's number instead.
import { assert, assertEquals } from "@std/assert";
import {
  finishPending,
  pendingAmong,
  pendingCount,
  pendingStarted,
  resetPendingCalls,
  startPending,
} from "../src/protocol/pending-calls.ts";
import { createAckRegistry } from "../src/protocol/ack-registry.ts";

Deno.test("finishPending retires the finished call's own number", () => {
  resetPendingCalls();
  const older = startPending("c:m");
  const newer = startPending("c:m");
  finishPending("c:m", newer);
  assertEquals(pendingCount("c:m"), 1);
  assert(!pendingAmong([newer]), "the newer call finished");
  assert(pendingAmong([older]), "the older call is still running");
  finishPending("c:m", older);
  assertEquals(pendingCount("c:m"), 0);
  assert(!pendingAmong([older]));
  resetPendingCalls();
});

Deno.test("ack registry: the newer call's ack ends the newer call, not the older", async () => {
  resetPendingCalls();
  const acks = createAckRegistry(() => 0, () => {});
  const older = acks.register("a", { methodKey: "c:m" });
  const olderStart = pendingStarted();
  const newer = acks.register("b", { methodKey: "c:m" });
  const newerStart = pendingStarted();
  acks.resolve("b", 2);
  assertEquals(await newer, 2);
  assert(!pendingAmong([newerStart]), "the call started since T is done");
  assert(pendingAmong([olderStart]), "the older call still runs");
  acks.reject("a", new Error("x"));
  await older.catch(() => {});
  assertEquals(pendingCount("c:m"), 0);
  resetPendingCalls();
});
