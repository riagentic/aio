// A dispatch from `onStop` is refused — and now says WHY, where someone reads it.
//
// `onStop` runs at teardown Phase 5: after the dispatch drain (Phase 1) and
// after the FINAL PERSIST (Phase 2). So a cell method called from it is
// refused, and admitting it would be worse than refusing — the write would
// move state the final snapshot has already read, landing in memory and never
// on disk.
//
// A field report's `onStop` was one line, `dm.lockVault()`, whose whole job is
// wiping key material on exit. It never ran, on every clean shutdown, and said
// so in a warning emitted at the one moment nobody is watching. The warning was
// right; what it could not say is "this is your onStop", which is the sentence
// that turns it from noise into an instruction.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { cell } from "../mod.ts";
import { testServer } from "../src/testing/server-test.ts";
import { createDispatch } from "../src/state/dispatch.ts";
import { _setUserStopHookActive } from "../src/state/dispatch.ts";

async function dropWarnings(inHook: boolean): Promise<string[]> {
  const warns: string[] = [];
  const dispatch = createDispatch<
    { n: number },
    { type: string },
    { type: string }
  >({
    reduce: (s) => ({ state: s, effects: [] }),
    execute: () => {},
    getState: () => ({ n: 0 }),
    setState: () => {},
    onDone: () => {},
    log: {
      debug: () => {},
      warn: (m: string) => warns.push(m),
      error: () => {},
    },
    debug: false,
  });
  dispatch.close();
  // …and DRAIN, because that is where onStop runs: teardown Phase 5, after
  // the drain (Phase 1) and after the final persist (Phase 2). A dispatch
  // during the drain itself is a different message.
  await dispatch.drain(50);
  _setUserStopHookActive(inHook);
  try {
    dispatch({ type: "wallet:lockVault" }).catch(() => {});
  } finally {
    _setUserStopHookActive(false);
  }
  return warns;
}

Deno.test("onStop: the drop warning names the hook and why it cannot be saved", async () => {
  const [msg] = await dropWarnings(true);
  assert(msg, "a dispatch after close() must warn");
  assertStringIncludes(msg, "wallet:lockVault");
  assertStringIncludes(msg, "your `onStop` hook");
  assertStringIncludes(msg, "AFTER the final persist");
  // …and it says what to do instead, which is the whole point.
  assertStringIncludes(msg, "plain function");
});

Deno.test("onStop: a drop from anywhere else does not blame onStop", async () => {
  // A message that blamed onStop for every late dispatch would send people to
  // read a hook they never wrote.
  const [msg] = await dropWarnings(false);
  assert(msg);
  assertStringIncludes(msg, "wallet:lockVault");
  assertEquals(msg.includes("onStop"), false);
});

Deno.test("onStop: the hook still runs, and a plain call inside it works", async () => {
  let plainRan = false;
  let locked = false;
  const vault = cell("onstop-vault", {
    state: { n: 0 },
    methods: {
      bump(s) {
        s.n++;
      },
    },
  });
  {
    await using _server = await testServer({
      cells: [vault],
      onStop: () => {
        // What the docs now tell people to do: a plain function, not a method.
        plainRan = true;
        locked = true;
      },
    });
  }
  assert(plainRan, "onStop itself must still run — nothing here changes that");
  assert(locked);
});
