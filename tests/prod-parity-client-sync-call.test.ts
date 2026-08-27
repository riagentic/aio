// Prod parity: a SYNC method called from a client crosses the wire.
//
// The gap: every test in this repo calls a cell method in-process
// (`todos.add("milk")`, testCell, testUI). A browser tab, an Electron window
// and `am` do not — they put an action frame on a socket. For an ASYNC method
// the harness already had the wire path (`connectCli().bind()`); for a plain
// non-async method it did not, so four differences that a client sees on every
// single call were invisible to the whole suite:
//
//   1. the ARGUMENT is JSON, not a reference — a Date arrives as a string
//   2. the RETURN value is JSON-vetted — anything JSON cannot carry is dropped
//   3. a THROW comes back as a message, with no Error identity and no stack
//   4. `access: false` refuses the CLIENT and not the server-side caller
//
// A test that only ever called in-process could not see any of them, which is
// the harness-more-permissive-than-production class this project treats as
// disqualifying. `client.call(cell, method, ...args)` is the real path — a real
// server, a real WebSocket, the frame a browser sends — and every case below
// asserts the wire result and the in-process result SIDE BY SIDE, so the
// difference is the thing under test rather than a footnote.
import { assert, assertEquals, assertRejects } from "@std/assert";
import { testMultiClient } from "../src/testing/multi-client-test.ts";
import { cell } from "../src/state/cell.ts";

const WHEN = new Date("2020-01-02T03:04:05.000Z");

/** Every method here is SYNC on purpose — that is the case with no wire path. */
const wire = cell("wireSync", {
  state: { argKind: "", calls: 0 },
  methods: {
    /** Report the runtime type of `payload.when` as the BODY sees it. */
    inspect(s: { argKind: string; calls: number }, payload: { when: unknown }) {
      s.calls++;
      s.argKind = payload?.when instanceof Date ? "Date" : typeof payload?.when;
      return s.argKind;
    },
    /** Return something JSON cannot carry intact. */
    rich(s: { calls: number }) {
      s.calls++;
      return { n: 1, when: WHEN, onDone: () => "hi", tags: new Set(["a"]) };
    },
    /** Throw, so the two error paths can be compared. */
    boom(_s: unknown) {
      throw new Error("boom: the method refused");
    },
  },
});

/** Server-side only: `access: false` means no client may CALL its methods. */
const guarded = cell("wireGuarded", {
  access: false,
  state: { n: 0 },
  methods: {
    bump(s: { n: number }) {
      s.n++;
      return s.n;
    },
  },
});

Deno.test("client sync call: the ARGUMENT is JSON on the wire, a reference in-process", async () => {
  await using m = await testMultiClient({ cells: [wire] }, 1);
  const client = m.clients[0]!;

  // In-process — the server-side call every test writes today.
  assertEquals(
    await wire.inspect({ when: WHEN }),
    "Date",
    "in-process, the method body receives the real Date",
  );

  // The same call, from a client. JSON has no Date, so the body sees a string.
  assertEquals(
    await client.call("wireSync", "inspect", { when: WHEN }),
    "string",
    "over the wire a Date arrives as an ISO string — if this ever reads " +
      '"Date" the harness has stopped crossing the wire and every ' +
      "argument-shape bug is invisible again",
  );

  // Both landed on the server: this is one cell, two call paths, two results.
  await m.converged();
  assertEquals(m.serverState<{ calls: number }>("wireSync").calls, 2);
});

Deno.test("client sync call: the RETURN value is JSON-vetted on the wire", async () => {
  await using m = await testMultiClient({ cells: [wire] }, 1);
  const client = m.clients[0]!;

  const local = await wire.rich() as {
    n: number;
    when: Date;
    onDone: () => string;
    tags: Set<string>;
  };
  assertEquals(local.n, 1);
  assert(local.when instanceof Date, "in-process the Date is a Date");
  assertEquals(typeof local.onDone, "function", "…and the function survives");
  assert(local.tags instanceof Set, "…and so does the Set");

  const remote = await client.call<Record<string, unknown>>(
    "wireSync",
    "rich",
  );
  assertEquals(remote.n, 1);
  assertEquals(
    remote.when,
    WHEN.toISOString(),
    "over the wire a Date is an ISO string",
  );
  assertEquals(
    "onDone" in remote,
    false,
    "over the wire the function is simply GONE — the key vanishes, which is " +
      "the exact shape that reads as `undefined is not a function` in a browser",
  );
  assertEquals(remote.tags, {}, "over the wire a Set is an empty object");
});

Deno.test("client sync call: a THROW crosses as a message, not as an Error", async () => {
  await using m = await testMultiClient({ cells: [wire] }, 1);
  const client = m.clients[0]!;

  const localErr = await assertRejects(() => wire.boom(), Error);
  assert(
    /boom: the method refused/.test(localErr.message),
    `in-process the caller gets the reason: ${localErr.message}`,
  );
  assert(
    (localErr.stack ?? "").includes("src/state/dispatch.ts"),
    "…on a real server-side stack that walks back into the runtime",
  );

  const remoteErr = await assertRejects(
    () => client.call("wireSync", "boom"),
    Error,
  );
  // The wire carries `String(err)`, so the message is reconstructed and the
  // original stack is gone. It must still REJECT — a refusal that resolved
  // would be the worst of the two worlds.
  assert(
    /boom: the method refused/.test(remoteErr.message),
    `the refusal must carry the reason: ${remoteErr.message}`,
  );
  assert(
    !(remoteErr.stack ?? "").includes("src/state/dispatch.ts"),
    "the wire cannot carry the server-side stack, and must not pretend to — " +
      "the client's Error is reconstructed from a string",
  );
});

Deno.test("client sync call: access: false refuses the CLIENT, not the server", async () => {
  await using m = await testMultiClient({ cells: [guarded] }, 1);
  const client = m.clients[0]!;

  // Server-side: allowed. This is what an in-process test measures, and it is
  // why `access: false` could be declared, tested, and still be wrong.
  assertEquals(await guarded.bump(), 1);

  await assertRejects(
    () => client.call("wireGuarded", "bump"),
    Error,
    undefined,
    "a client call to an access:false cell must be refused — an in-process " +
      "test can never observe this",
  );
  await m.converged();
  assertEquals(
    m.serverState<{ n: number }>("wireGuarded").n,
    1,
    "the refused client call must not have applied",
  );
});

Deno.test("client sync call: a typo fails loud instead of resolving undefined", async () => {
  await using m = await testMultiClient({ cells: [wire] }, 1);
  const client = m.clients[0]!;

  // The server ignores an unknown action type and acks OK, so without this
  // check a misspelled method resolves with `undefined` and the test passes
  // for the wrong reason.
  await assertRejects(
    () => client.call("wireSync", "inspekt", {}),
    Error,
    'cell "wireSync" has no method "inspekt"',
  );
  await assertRejects(
    () => client.call("wireSyncc", "inspect", {}),
    Error,
    'this app has no cell "wireSyncc"',
  );
});
