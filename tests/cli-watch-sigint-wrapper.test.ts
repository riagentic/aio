// `src/cli/watch.ts` wraps Deno.addSignalListener / removeSignalListener at
// module load, to know whether the app has a SIGINT listener of its own. A
// global wrapper is shared with every other library in the process, so it has
// to be indistinguishable from the original: name and arity, arguments, return
// value, errors — and wrapped ONCE, even when two copies of the module load.
import { assert, assertEquals, assertThrows } from "@std/assert";

const origAdd = Deno.addSignalListener;
const origRemove = Deno.removeSignalListener;
const WATCH = new URL("../src/cli/watch.ts", import.meta.url).href;

Deno.test({
  name:
    "cli watch: the SIGINT wrapper is identity-transparent and wrapped once",
  ignore: Deno.build.os === "windows", // no SIGUSR1 there
  fn: async () => {
    await import(WATCH);
    const add = Deno.addSignalListener;
    const remove = Deno.removeSignalListener;
    assertEquals(add.name, origAdd.name);
    assertEquals(add.length, origAdd.length);
    assertEquals(remove.name, origRemove.name);
    assertEquals(remove.length, origRemove.length);

    // The original's error, unchanged, for a bad signal.
    const bad = "SIGNOPE" as Deno.Signal;
    const want = assertThrows(() => origAdd(bad, () => {})) as Error;
    const got = assertThrows(() => add(bad, () => {})) as Error;
    assertEquals(got.constructor, want.constructor);
    assertEquals(got.message, want.message);

    // A listener added through the wrapper fires; the return value passes.
    let fired = 0;
    const h = () => void fired++;
    assertEquals(add("SIGUSR1", h), undefined);
    try {
      Deno.kill(Deno.pid, "SIGUSR1");
      const until = Date.now() + 2000;
      while (fired === 0 && Date.now() < until) {
        await new Promise((r) => setTimeout(r, 10));
      }
      assertEquals(fired, 1);
    } finally {
      assertEquals(remove("SIGUSR1", h), undefined);
    }

    // A second copy of the module (two aio versions in one app) must not wrap
    // the wrapper — that copy's own listener would count as the app's.
    await import(`${WATCH}?second-copy`);
    assert(Deno.addSignalListener === add, "wrapped twice");
    assert(Deno.removeSignalListener === remove, "wrapped twice");
  },
});
