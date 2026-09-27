// `testMultiClient().clients[i].dispatch` contract:
// - of several CONCURRENT dispatches, none resolves on another's patch or on
//   the no-op grace (it used to: every one resolved on the first update, so a
//   test awaiting a slow method read state the method had not written);
// - it never rejects where it used to resolve: a long-running method, one
//   that waits on a peer's action, and a refused one all resolve (a strict
//   "resolve on ack" version made each of them reject after 5 s).
import { assert, assertEquals } from "@std/assert";
import { cell } from "../mod.ts";
import { testMultiClient } from "../src/testing/multi-client-test.ts";

type S = {
  fast: number;
  slowA: number;
  slowB: number;
  running: boolean;
  waited: boolean;
  released: boolean;
};

let stopLoop = false;
let releaseSlow = () => {};
const slowGate = new Promise<void>((r) => releaseSlow = r);
let openGate = () => {};
const gate = new Promise<void>((r) => openGate = r);

const c = cell("mc-acked", {
  state: {
    fast: 0,
    slowA: 0,
    slowB: 0,
    running: false,
    waited: false,
    released: false,
  } as S,
  methods: {
    bumpFast(s: S) {
      s.fast += 1;
    },
    async gatedA(s: S) {
      await slowGate;
      s.slowA += 1;
    },
    async gatedB(s: S) {
      await slowGate;
      s.slowB += 1;
    },
    async loop(s: S) {
      s.running = true;
      while (!stopLoop) await new Promise((r) => setTimeout(r, 20));
      s.running = false;
    },
    async waitPeer(s: S) {
      await gate;
      s.waited = true;
    },
    release(s: S) {
      s.released = true;
      openGate();
    },
    refuse(_s: S) {
      throw new Error("nope");
    },
  },
});

const act = (m: string) => ({ type: `mc-acked:${m}`, payload: { args: [] } });

Deno.test("multi-client dispatch: concurrent calls settle on their own acks, not a patch or the grace", async () => {
  await using m = await testMultiClient({ cells: [c] }, 1);
  const cl = m.clients[0]!;
  const settled: string[] = [];
  const a = cl.dispatch(act("gatedA")).then(() => settled.push("a"));
  const b = cl.dispatch(act("gatedB")).then(() => settled.push("b"));
  // A patch while both are in flight (another method's write) and the whole
  // grace window pass: neither may settle.
  await m.clients[0]!.call("mc-acked", "bumpFast");
  await new Promise((r) => setTimeout(r, 600));
  assertEquals(settled, [], "nothing settles before the release");
  releaseSlow();
  await a;
  assertEquals(cl.state<S>("mc-acked").slowA, 1, "a resolved after its write");
  await b;
  await m.converged();
  assertEquals(m.serverState<S>("mc-acked").slowB, 1);
});

Deno.test("multi-client dispatch: a long-running method resolves on its first patch", async () => {
  stopLoop = false;
  await using m = await testMultiClient({ cells: [c] }, 1);
  try {
    const t0 = Date.now();
    await m.clients[0]!.dispatch(act("loop"));
    assert(Date.now() - t0 < 1000, `took ${Date.now() - t0}ms`);
    assertEquals(m.clients[0]!.state<S>("mc-acked").running, true);
  } finally {
    stopLoop = true;
  }
});

Deno.test("multi-client dispatch: a method waiting on a peer's action resolves", async () => {
  await using m = await testMultiClient({ cells: [c] }, 2);
  const t0 = Date.now();
  await m.clients[0]!.dispatch(act("waitPeer"));
  assert(Date.now() - t0 < 1000, `took ${Date.now() - t0}ms`);
  await m.clients[1]!.dispatch(act("release"));
  await m.converged();
  assertEquals(m.serverState<S>("mc-acked").waited, true);
});

Deno.test("multi-client dispatch: a refused method resolves and leaves state unchanged", async () => {
  await using m = await testMultiClient({ cells: [c] }, 1);
  const before = m.serverState<S>("mc-acked");
  await m.clients[0]!.dispatch(act("refuse"));
  assertEquals(m.serverState<S>("mc-acked"), before);
});
