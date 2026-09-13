// `$call`'s cycle cap counts siblings that are NESTED, not siblings that are
// merely running at the same time.
//
// One shared counter held each call until its promise settled, so a fan-out
// was measured as depth:
//
//   await Promise.all(ids.map((id) => s.$call.fetchOne(id)))   // 33 ids
//   → "exceeded 32 nested sibling calls — this is almost always a cycle"
//
// with no cycle anywhere. And a plain (non-async) sibling that RETURNS a
// promise was decremented twice — once by the promise's `finally`, once by the
// "sync path" `finally` — so the counter went negative and the cap stopped
// existing.
import { assert, assertEquals } from "@std/assert";
import { bootCells } from "../src/testing/cell-test.ts";
import { cell } from "../src/state/cell-create.ts";
import { MAX_CALL_DEPTH } from "../src/state/cell-call.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

const fan = cell("callfan", {
  state: { got: [] as number[] },
  methods: {
    async fetchOne(s: Any, id: number) {
      await new Promise((r) => setTimeout(r, 1));
      s.got.push(id);
      return id;
    },
    promiseReturning(_s: Any, id: number) {
      return Promise.resolve(id);
    },
    async loadAll(s: Any, n: number) {
      const ids = Array.from({ length: n }, (_, i) => i);
      const r = await Promise.all(ids.map((id) => s.$call.fetchOne(id)));
      return r.length;
    },
    // Many settled promise-returning siblings, THEN a real cycle: if each of
    // those had decremented twice, the counter would sit far below zero and
    // the cycle would run into the engine's stack limit instead of the cap.
    async drainThenCycle(s: Any, n: number) {
      for (let i = 0; i < n; i++) await s.$call.promiseReturning(i);
      s.$call.ping();
    },
    ping(s: Any) {
      s.$call.pong();
    },
    pong(s: Any) {
      s.$call.ping();
    },
    // An async cycle that recurses before its first await piles up on the
    // stack exactly like a sync one — still caught.
    async asyncA(s: Any): Promise<void> {
      await s.$call.asyncB();
    },
    async asyncB(s: Any): Promise<void> {
      await s.$call.asyncA();
    },
  },
} as Any) as Any;

Deno.test("$call: parallel siblings are not nesting", async () => {
  const h = await bootCells([fan]);
  try {
    const n = MAX_CALL_DEPTH * 3;
    assertEquals(await fan.loadAll(n), n);
    assertEquals(fan.got.length, n);
  } finally {
    h.dispose();
  }
});

Deno.test("$call: the cap still catches a cycle — after many promise-returning siblings too", async () => {
  const h = await bootCells([fan]);
  try {
    const msg = await fan.drainThenCycle(20_000).then(
      () => "resolved",
      (e: Error) => e.message,
    );
    assert(msg.includes(`exceeded ${MAX_CALL_DEPTH}`), msg);
    const amsg = await fan.asyncA().then(
      () => "resolved",
      (e: Error) => e.message,
    );
    assert(amsg.includes(`exceeded ${MAX_CALL_DEPTH}`), amsg);
  } finally {
    h.dispose();
  }
});
