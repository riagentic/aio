// `onRestore: async (s) => { … }` — the hook written with an `async` keyword
// it was never allowed to have.
//
// Restore runs before the server starts and is not awaited anywhere, so an
// async hook hands back a Promise instead of state. A Promise IS an object, so
// every shape check passed it: the app-level hook made the WHOLE app state a
// Promise (`Object.keys(promise)` is `[]`, so boot even reported "state: 0
// keys" and started), and a cell's made that cell's slice one — every read
// `undefined`, every method writing into a Promise, and the first persist
// storing `{}` over the real data.
//
// A thenable is not state. Both hooks say so through the error guard they
// already have, and the restored state is kept exactly as it was.
import { assertEquals, assertStringIncludes } from "@std/assert";
import { runCellRestore } from "../src/server/aio-boot.ts";
import { aio } from "../src/server/aio.ts";
import { cell } from "../src/state/cell-create.ts";
import { _resetAioRuntime } from "../src/state/runtime-reset.ts";
import { freePort } from "../src/testing/server-test.ts";

// deno-lint-ignore no-explicit-any
type D = any;

function capturingLog() {
  const said: string[] = [];
  return {
    said,
    log: {
      info: () => {},
      warn: () => {},
      error: (m: string) => void said.push(m),
    } as D,
  };
}

Deno.test("runCellRestore: an async cell onRestore is refused, the slice kept", () => {
  const { said, log } = capturingLog();
  const slice = { n: 1 };
  const out = runCellRestore(
    "c",
    (async (s: D) => {
      s.n = 2;
      return s;
    }) as D,
    slice,
    undefined,
    log,
  );
  assertEquals(out, { n: 2 }, "the mutation it did make is kept");
  assertStringIncludes(said.join("\n"), "onRestore(c)");
  assertStringIncludes(said.join("\n"), "async");
});

Deno.test("runCellRestore: a sync hook returning a plain object is untouched", () => {
  const { said, log } = capturingLog();
  const out = runCellRestore(
    "c",
    (s: D) => ({ ...s, n: 9 }),
    { n: 1 },
    undefined,
    log,
  );
  assertEquals(out, { n: 9 });
  assertEquals(said, []);
});

Deno.test("app onRestore: an async hook is refused — the app state never becomes a Promise", async () => {
  const errors: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => void errors.push(a.join(" "));
  _resetAioRuntime();
  const c = cell("ca", {
    state: { n: 3 },
    methods: {
      bump(s: D) {
        s.n += 1;
      },
    },
  } as D);
  try {
    const app = await aio.run({
      cells: [c],
      appId: "onrestore-async-refused",
      persist: false,
      libraryMode: true,
      singleton: false,
      client: "server-only",
      port: freePort(),
      onRestore: (async (s: D) => s) as D,
    } as D);
    try {
      assertEquals(
        (c as D).n,
        3,
        "the state is the restored one, not a Promise",
      );
    } finally {
      await app.close();
    }
  } finally {
    console.error = orig;
    _resetAioRuntime();
  }
  assertStringIncludes(errors.join("\n"), "onRestore");
  assertStringIncludes(errors.join("\n"), "async");
});
