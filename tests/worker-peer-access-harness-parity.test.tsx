// A `worker: true` cell refuses in every harness what its real thread refuses.
//
// Every harness runs worker cells on the main isolate, where every other cell
// is right there: a worker method reading `peer.v` got the live value, and one
// calling `peer.bump()` dispatched it. A real worker holds only its own slice
// and binds no cell, so both THROW there — an app doing either was green in
// bootCells / testUI / testServer and broken the moment the cell got its
// thread (docs/state/cell-workers.md documents both refusals).
//
// And `wpHeavy.$pending("slow")` read 1 in process but 0 against a real
// worker: the count is kept by the executor that runs the method, which is on
// the other thread. The pool now counts the call on the main isolate.
//
// The real worker answers first; every harness must give the same answer.
import { assert, assertEquals } from "@std/assert";
import { testServer } from "../src/testing/server-test.ts";
import { bootCells, testCell } from "../src/testing/cell-test.ts";
import { testUI } from "../src/testing/ui-test.ts";
import { h } from "../src/air/vdom.ts";
import { wpHeavy, wpPeer } from "./fixtures/worker-peer-access-app.ts";

const ENTRY = import.meta.resolve("./fixtures/worker-peer-access-app.ts");

type Heavy = {
  readPeer: () => Promise<number>;
  callPeer: () => Promise<number>;
  callSelf: () => Promise<number>;
  slow: (ms: number) => Promise<number>;
  n: number;
  $pending: (m?: string) => number;
};
const H = wpHeavy as unknown as Heavy;

/** The rejection message, or `ok <value>`. */
const answer = (p: () => Promise<unknown>) =>
  p().then((v) => `ok ${v}`, (e: Error) => e.message);

type Answers = {
  readPeer: string;
  callPeer: string;
  callSelf: string;
  pending: number;
};

async function ask(settle: () => Promise<void>): Promise<Answers> {
  const readPeer = await answer(H.readPeer);
  const callPeer = await answer(H.callPeer);
  const callSelf = await answer(H.callSelf);
  const running = H.slow(60);
  await new Promise((r) => setTimeout(r, 20));
  const pending = H.$pending("slow");
  await running;
  await settle();
  return { readPeer, callPeer, callSelf, pending };
}

let real: Answers | undefined;

Deno.test("worker parity: what a REAL worker answers", async () => {
  await using _srv = await testServer({
    cells: [wpPeer, wpHeavy],
    workers: "real",
    workerEntry: ENTRY,
  });
  real = await ask(() => Promise.resolve());
  assert(
    real.readPeer.includes('cannot read "wpPeer.v"'),
    `real peer read: ${real.readPeer}`,
  );
  assert(
    real.callPeer.startsWith("[wpPeer] bump() called before"),
    `real peer call: ${real.callPeer}`,
  );
  assert(
    real.callSelf.startsWith("[wpHeavy] readOwn() called before"),
    `real own call: ${real.callSelf}`,
  );
  assertEquals(real.pending, 1, "the main isolate sees the call in flight");
});

Deno.test("worker parity: testServer in-isolate answers the same", async () => {
  assert(real, "runs after the real-worker case");
  await using _srv = await testServer({ cells: [wpPeer, wpHeavy] });
  assertEquals(await ask(() => Promise.resolve()), real);
});

Deno.test("worker parity: bootCells answers the same", async () => {
  assert(real, "runs after the real-worker case");
  await using h = await bootCells([wpPeer, wpHeavy]);
  assertEquals(await ask(() => h.settle()), real);
  // Outside a worker method, nothing changed: the test reads and calls freely.
  assertEquals((wpPeer as unknown as { v: number }).v, 7);
  assertEquals(await (wpPeer as unknown as { bump: () => unknown }).bump(), 1);
});

Deno.test("worker parity: testUI answers the same — and a render its commit triggers may read any cell", async () => {
  assert(real, "runs after the real-worker case");
  // The component reads the PEER and is re-rendered by the WORKER cell's
  // commit — a render queued from inside the worker method's scope. It is UI
  // code on the main isolate and must never be refused.
  const App = () =>
    h(
      "div",
      null,
      h(
        "span",
        { class: "label" },
        `peer:${(wpPeer as unknown as { v: number }).v} n:${H.n}`,
      ),
    );
  await using ui = await testUI(App, { cells: [wpPeer, wpHeavy] });
  assertEquals(await ask(() => ui.settle()), real);
  assert(ui.html().includes("peer:7 n:1"), ui.html());
});

testCell(wpHeavy, "worker parity: testCell answers the same", async (t) => {
  assert(real, "runs after the real-worker case");
  const send = t.send as unknown as {
    readPeer: () => Promise<number>;
    callPeer: () => Promise<number>;
    callSelf: () => Promise<number>;
  };
  assertEquals(await answer(send.readPeer), real.readPeer);
  assertEquals(await answer(send.callPeer), real.callPeer);
  assertEquals(await answer(send.callSelf), real.callSelf);
});
