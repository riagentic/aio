import { assertEquals } from "@std/assert";
import { Listeners } from "../src/state/listeners.ts";

// Same contract signal.ts states for its subscribers ("Unsubscribing has to
// cancel the notification already in the queue, not just future ones"): a
// listener removed DURING a notify — e.g. an earlier route listener that
// unmounts the component owning a later one — must not be called afterwards.
// `notify` iterates an Array.from snapshot, so the removed one still runs.
Deno.test("Listeners: a listener unsubscribed mid-notify is not called", () => {
  const l = new Listeners<number>();
  const calls: string[] = [];
  let unsubB: () => void = () => {};
  l.add(() => {
    calls.push("A");
    unsubB(); // A tears down B's owner
  });
  unsubB = l.add(() => calls.push("B"));
  l.notify(1);
  assertEquals(calls, ["A"]);
});
