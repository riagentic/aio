// An app-level `onRestore` that MUTATES the state and returns nothing.
//
// It is the shape every repair naturally takes, and the shape the framework
// itself accepts everywhere else: a cell's `onRestore` documents "mutate the
// draft, or return a replacement" and `runCellRestore` implements it
// (`next !== undefined ? next : input`), and the re-run journal replay does
// after a crash spells out the same rule ("mutated in place (or handed the
// draft back) ⇒ the draft's edits"). Boot alone did `state = onRestore(state)`,
// so a hook that returned nothing set the whole app state to `undefined` and
// `aio.run()` died with `TypeError: Cannot convert undefined or null to
// object` — on every boot, fresh install included, naming neither `onRestore`
// nor the app. Two deciders for one hook; this is the third agreeing with the
// other two.
//
// A return that is not state at all (a number, a boolean, null) still goes
// through the hook's error guard, named — it is a mistake, not a repair.
import { assertEquals, assertStringIncludes } from "@std/assert";
import { aio } from "../src/server/aio.ts";
import { cell } from "../src/state/cell-create.ts";
import { _resetAioRuntime } from "../src/state/runtime-reset.ts";
import { freePort } from "../src/testing/server-test.ts";

// deno-lint-ignore no-explicit-any
type D = any;

async function boot(onRestore: (s: D) => D, id: string) {
  _resetAioRuntime();
  const c = cell(`c${id}`, {
    state: { n: 0, busy: true },
    methods: {
      bump(s: D) {
        s.n += 1;
      },
    },
  } as D);
  const app = await aio.run({
    cells: [c],
    appId: `app-onrestore-mutates-${id}`,
    persist: false,
    libraryMode: true,
    singleton: false,
    client: "server-only",
    port: freePort(),
    onRestore,
  } as D);
  return { c: c as D, app };
}

Deno.test("app onRestore: mutating the state and returning nothing keeps the mutation", async () => {
  const { c, app } = await boot((s: D) => {
    s[`c${"a"}`].busy = false;
  }, "a");
  try {
    assertEquals(
      c.busy,
      false,
      "the repair must survive, not become undefined",
    );
    assertEquals(c.n, 0);
  } finally {
    await app.close();
    _resetAioRuntime();
  }
});

Deno.test("app onRestore: returning a replacement still replaces", async () => {
  const { c, app } = await boot(
    (s: D) => ({ ...s, cb: { ...s.cb, busy: false, n: 7 } }),
    "b",
  );
  try {
    assertEquals({ n: c.n, busy: c.busy }, { n: 7, busy: false });
  } finally {
    await app.close();
    _resetAioRuntime();
  }
});

Deno.test("app onRestore: a return that is not state is reported and the state kept", async () => {
  const errors: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => void errors.push(a.join(" "));
  try {
    const { c, app } = await boot(() => 42 as D, "c");
    try {
      assertEquals({ n: c.n, busy: c.busy }, { n: 0, busy: true });
    } finally {
      await app.close();
      _resetAioRuntime();
    }
  } finally {
    console.error = orig;
  }
  assertStringIncludes(errors.join("\n"), "onRestore");
});
