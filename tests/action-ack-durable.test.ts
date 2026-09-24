// The two deciders an ack reads about DURABILITY (server/action-ack.ts):
// `_durableFor` — what must be on disk before this action may be acked — and
// `_dispatchUnsaved` — the `unsaved` sentence when that save failed.
//
// Both are read by every door (WS, UDS, trojan, the sync handler), so each is
// held still here at the unit, beside the end-to-end proofs in
// journal-owed-saves-all-callers.test.ts.
import { assertEquals } from "@std/assert";
import {
  _dispatchUnsaved,
  _durableFor,
  _noteUnsaved,
} from "../src/server/action-ack.ts";

type Owed = WeakMap<object, Set<Promise<string | undefined>>>;

Deno.test("_durableFor: nothing owed is no wait; owed saves are one verdict, read once", async () => {
  const owed: Owed = new WeakMap();
  const quiet = { type: "c:m" };
  assertEquals(_durableFor(owed, quiet), undefined, "nothing owed → no wait");

  const landed = { type: "c:ok" };
  owed.set(landed, new Set([Promise.resolve(undefined)]));
  assertEquals(await _durableFor(owed, landed), undefined, "every save landed");
  // Read-and-clear: the second ack of the same frame waits for nothing.
  assertEquals(_durableFor(owed, landed), undefined);

  const failed = { type: "c:bad" };
  owed.set(
    failed,
    new Set([
      Promise.resolve(undefined),
      Promise.resolve("disk full"),
      Promise.resolve("disk full"), // one save answering two requests
      Promise.resolve("store refused"),
    ]),
  );
  assertEquals(
    await _durableFor(owed, failed),
    "disk full; store refused",
    "each distinct failure, once",
  );
  assertEquals(_durableFor(owed, failed), undefined);
});

Deno.test("_dispatchUnsaved: keyed to the frame or its async call id, never another call's", () => {
  const a = { type: "c:m" }, b = { type: "c:m" };
  _noteUnsaved(a, undefined, "a is not on disk");
  assertEquals(_dispatchUnsaved(a), "a is not on disk");
  assertEquals(_dispatchUnsaved(b), undefined, "a concurrent frame is clean");

  // An async call's ack comes at the method's end: keyed by its call id, and
  // read ONCE.
  const call = "call-7";
  _noteUnsaved(undefined, call, "the call's write set did not land");
  const frame = { type: "c:m", payload: { _callId: call } };
  assertEquals(_dispatchUnsaved(frame), "the call's write set did not land");
  assertEquals(_dispatchUnsaved(frame), undefined, "read-and-clear");
  assertEquals(_dispatchUnsaved(null), undefined);
  assertEquals(_dispatchUnsaved("c:m"), undefined);
});
