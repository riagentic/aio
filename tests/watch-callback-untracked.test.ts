import { assertEquals } from "@std/assert";
import { signal } from "../src/state/signal.ts";
import { watch } from "../src/state/watch.ts";

// watch(source, fn) is documented as "Watch a single signal or computed for
// changes". A signal READ inside the callback must not become a dependency:
// writing that other signal is not a change of `source`, yet the callback is
// re-invoked with next === prev (the sibling `on()` untracks its callback).
Deno.test("watch: a signal read inside the callback does not re-trigger it", () => {
  const theme = signal("light");
  const user = signal("ann");
  const calls: [string, string | undefined, string][] = [];
  const stop = watch(theme, (next, prev) => {
    calls.push([next, prev, user.value]); // an ordinary read in a callback
  });
  theme.set("dark");
  assertEquals(calls, [["dark", "light", "ann"]]);
  user.set("bob"); // theme did NOT change
  assertEquals(calls, [["dark", "light", "ann"]]);
  stop();
});
