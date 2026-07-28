// llama-master #16 — "no harness for aio's central claim: one state, many
// surfaces". The promise that sells the framework is that an Electron window, a
// browser tab and `am` all read the same state with no transport code. A real app
// shipped two of those clients and said: "I have never tested two of them at
// once, because there is nothing to test them with… so the claim I lean on
// hardest is the one my 281-test suite says nothing about."
//
// These are real WS peers against a real `aio.run()` — nothing simulated, because
// a harness that faked the transport would report success for the one thing it
// exists to check.
import { assert, assertEquals } from "@std/assert";
import { cell } from "../mod.ts";
import { testMultiClient } from "../src/testing/multi-client-test.ts";

type S = { count: number; log: string[] };

const counter = cell("mc-counter", {
  state: { count: 0, log: [] } as S,
  methods: {
    increment(s: S, by = 1) {
      s.count += by;
    },
    note(s: S, msg: string) {
      s.log.push(msg);
    },
  },
});

Deno.test("multi-client: every surface receives the same state", async () => {
  await using m = await testMultiClient({ cells: [counter] }, 3);
  assertEquals(m.clients.length, 3);

  // The claim, at rest: three independent sockets, one state.
  await m.converged();
  for (const c of m.clients) {
    assertEquals(c.state<S>("mc-counter").count, 0, `client ${c.index}`);
  }
});

Deno.test("multi-client: a dispatch from ONE surface reaches the others", async () => {
  await using m = await testMultiClient({ cells: [counter] }, 2);
  await m.clients[0]!.dispatch({
    type: "mc-counter:increment",
    payload: { args: [5] },
  });
  await m.converged();

  assertEquals(
    m.serverState<S>("mc-counter").count,
    5,
    "the server applied it",
  );
  assertEquals(
    m.clients[1]!.state<S>("mc-counter").count,
    5,
    "…and the OTHER client saw it, with no transport code in the app",
  );
});

Deno.test("multi-client: both surfaces dispatching at once — no lost update", async () => {
  // The case the reporter said they could not reason about from the outside:
  // two clients send the same action in the same tick. Increments must compose,
  // not clobber — the server's dispatch queue is the single ordering point.
  await using m = await testMultiClient({ cells: [counter] }, 2);
  await m.dispatchAll({ type: "mc-counter:increment", payload: { args: [1] } });
  await m.converged();

  assertEquals(
    m.serverState<S>("mc-counter").count,
    2,
    "two clients, two increments — a lost update would show as 1",
  );
  for (const c of m.clients) {
    assertEquals(c.state<S>("mc-counter").count, 2, `client ${c.index} agrees`);
  }
});

Deno.test("multi-client: concurrent appends from 3 surfaces all survive", async () => {
  // Array append is where a naive last-write-wins broadcast loses data.
  await using m = await testMultiClient({ cells: [counter] }, 3);
  await Promise.all(
    m.clients.map((c) =>
      c.dispatch({
        type: "mc-counter:note",
        payload: { args: [`c${c.index}`] },
      })
    ),
  );
  await m.converged();

  const log = m.serverState<S>("mc-counter").log;
  assertEquals(log.length, 3, `all three appends survived: ${log.join(",")}`);
  for (const c of m.clients) {
    assertEquals(
      c.state<S>("mc-counter").log.length,
      3,
      `client ${c.index} has every entry`,
    );
  }
});

Deno.test("multi-client: each app instance is isolated from the last", async () => {
  // Two apps over ONE cell def is refused by design (a cell binds to exactly one
  // app), so this runs them in sequence — which is also what "a later run starts
  // clean" means.
  {
    await using m = await testMultiClient({ cells: [counter] }, 1);
    await m.clients[0]!.dispatch({
      type: "mc-counter:increment",
      payload: { args: [7] },
    });
    await m.converged();
    assertEquals(m.serverState<S>("mc-counter").count, 7);
  }
  {
    await using m = await testMultiClient({ cells: [counter] }, 1);
    assertEquals(
      m.serverState<S>("mc-counter").count,
      0,
      "a fresh app starts from the cell's declared state — no leak between tests",
    );
  }
});

Deno.test("multi-client: converged() waits for the work, not just for equality", async () => {
  // The harness's own trap, and the reason this test exists: right after a send
  // leaves a socket, every client still agrees with the server — because the
  // action hasn't arrived yet. A convergence check that only compared states
  // would pass at that instant, for the wrong reason, and report success for the
  // exact thing it was built to verify.
  await using m = await testMultiClient({ cells: [counter] }, 2);

  // Fire and DON'T wait: converged() must do the waiting.
  m.clients[0]!.cli.send({
    type: "mc-counter:increment",
    payload: { args: [4] },
  });
  await m.converged();

  assertEquals(
    m.serverState<S>("mc-counter").count,
    4,
    "converged() returned only after the dispatch had actually landed",
  );
  assertEquals(m.clients[1]!.state<S>("mc-counter").count, 4);
});

Deno.test("multi-client: a client's own view is what IT received", async () => {
  // Not the server's state read twice — the point of the harness is that these
  // are genuinely separate views that must agree.
  await using m = await testMultiClient({ cells: [counter] }, 2);
  assert(
    m.clients[0]!.fullState() !== m.clients[1]!.fullState(),
    "each client holds its own object, not a shared reference",
  );
  await m.clients[1]!.dispatch({
    type: "mc-counter:increment",
    payload: { args: [2] },
  });
  await m.converged();
  assertEquals(m.clients[0]!.state<S>("mc-counter").count, 2);
  assertEquals(m.clients[1]!.state<S>("mc-counter").count, 2);
});
