// One subscriber must never be able to silence the others.
//
// `Listeners.notify` looped unguarded, so the FIRST listener to throw
// cancelled every listener after it — and the throw propagated out of
// `notify` into whatever raised the event. Four registries share this class:
// `_rListeners` (router-core) is every `useRoute()` in the app, so one
// component's route handler throwing left the rest of the app on the OLD
// route. Half the screen navigates, half does not, and the one console line
// names neither half.
//
// The same shape, disposal side: `cleanupSignalBindings` ran an element's
// disposers in an unguarded loop and deleted the registry entry AFTER it, so
// one throwing disposer left the element's remaining bindings live — still
// subscribed, still writing into a node that has left the document — and
// leaked the element for the life of the page.
import { assert, assertEquals } from "@std/assert";
import { Listeners } from "../src/state/listeners.ts";
import { getLogger, setLogger } from "../src/diagnostics/logger-api.ts";

Deno.test("listeners: a throwing subscriber does not silence the rest", () => {
  const errs: string[] = [];
  const prev = getLogger();
  setLogger({
    pub: (lvl: string, _cat: string, msg: string) => {
      if (lvl === "error") errs.push(msg);
    },
    // deno-lint-ignore no-explicit-any
  } as any);
  try {
    const ls = new Listeners<number>();
    const seen: string[] = [];
    ls.add(() => seen.push("first"));
    ls.add(() => {
      throw new Error("subscriber blew up");
    });
    ls.add(() => seen.push("third"));

    // …and it must not throw at the CALLER either: the caller is the router
    // or the state layer, mid-navigation.
    ls.notify(1);

    assertEquals(
      seen,
      ["first", "third"],
      "every subscriber must be notified — the one after the thrower was " +
        "being skipped, which is how half an app stays on the old route",
    );
    assert(
      errs.some((e) => e.includes("subscriber threw")),
      `the throw must be reported, not swallowed: ${JSON.stringify(errs)}`,
    );
  } finally {
    setLogger(prev);
  }
});

Deno.test("listeners: unsubscribe still works, and notify survives an empty set", () => {
  const ls = new Listeners<number>();
  const seen: number[] = [];
  const off = ls.add((v) => seen.push(v));
  ls.notify(1);
  off();
  ls.notify(2);
  assertEquals(seen, [1]);
  assertEquals(ls.size, 0);
  ls.notify(3); // no listeners — not an error
});
