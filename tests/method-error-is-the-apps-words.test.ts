// The message an app shows a user must be the app's own.
//
// A method's throw was rewritten as `Cell '<cell>' method '<m>' threw:
// <original>`. That prefix is the framework talking about itself, and a
// caller's `e.message` is exactly what an app renders: `examples/contacts` —
// the "read this first" example — does `setError(e.message)`, so a shopper who
// typed a bad address saw
//
//   Cell 'contacts' method 'create' threw: not an email address: nope
//
// while `docs/state/the-bridge.md` promised "the client await rejects with the
// message". The original was reachable only through `e.cause.message`, which
// no doc mentioned.
//
// The context is not lost — it became DATA an app can branch on without
// matching prose, and the log line already named the cell and method itself.
import { assert, assertEquals } from "@std/assert";
import { cell } from "../mod.ts";
import { bootCells } from "../src/testing/cell-test.ts";

Deno.test("method error: the caller gets the method's own message", async () => {
  const contacts = cell("contacts-words", {
    state: { rows: [] as string[] },
    methods: {
      create(_s: { rows: string[] }, email: string) {
        throw new Error(`not an email address: ${email}`);
      },
      async createAsync(_s: { rows: string[] }, email: string) {
        await Promise.resolve();
        throw new Error(`not an email address: ${email}`);
      },
    },
  });
  await using _ = await bootCells([contacts]);

  for (
    const call of [
      () => contacts.create("nope"),
      () => contacts.createAsync("nope"),
    ]
  ) {
    let caught: Error | null = null;
    try {
      await call();
    } catch (e) {
      caught = e as Error;
    }
    assert(caught, "the call must reject");
    assertEquals(caught!.message, "not an email address: nope");
    // …and the framework's own name is nowhere in it.
    assert(
      !caught!.message.includes("Cell '"),
      `the framework must not name itself in a user-facing message: ${
        caught!.message
      }`,
    );
    // The identity is not lost: the LOG line names both — the sync path also
    // wraps this in an AioError whose `context` carries `cellName` and
    // `actionType`, which is data an app can branch on rather than prose it
    // would have to match.
  }
});

Deno.test("method error: a frozen-state mutation still gets its hint", async () => {
  // The hint is guidance about THIS failure rather than the framework naming
  // itself, so it stays in the message — that is the difference the change
  // turns on, and without this test "strip the prefix" could take the hint too.
  const other = cell("other-words", {
    state: { list: [] as number[] },
    methods: { noop() {} },
  });
  const bad = cell("bad-words", {
    state: { n: 0 },
    methods: {
      cheat(s: { n: number }) {
        s.n++;
        (other.list as number[]).push(1); // another cell's committed state
      },
    },
  });
  await using _ = await bootCells([other, bad]);

  let caught: Error | null = null;
  try {
    await bad.cheat();
  } catch (e) {
    caught = e as Error;
  }
  assert(caught, "the illegal mutation must throw");
  assert(
    caught!.message.includes("in-place mutation of frozen state"),
    caught!.message,
  );
  assert(
    !caught!.message.startsWith("Cell '"),
    `the framework must not name itself first: ${caught!.message}`,
  );
});
