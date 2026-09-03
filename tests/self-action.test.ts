// alpha52 — `self(method, ...args)`: self-referencing action descriptors,
// resolved by the DISPATCHING cell. Kills the `: CellEffect` TS7022 annotation
// for self-scheduling methods. Unknown method names throw at cell() when
// statically present (cancelOn), else at dispatch — loud both ways; a
// descriptor that reaches the scheduler unresolved is refused.
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { cell } from "../src/state/cell-create.ts";
import { bootCells } from "../src/testing/cell-test.ts";
import { createScheduleManager, schedule } from "../src/state/schedule.ts";
import { self, selfMethodOf } from "../src/state/self.ts";
import type { MethodDraftMeta } from "../src/state/cell-impl.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

Deno.test("self(): builds a marked descriptor with args", () => {
  const a = self("tick", 1, "x");
  assertEquals(selfMethodOf(a), "tick");
  assertEquals(a.payload, { args: [1, "x"] });
  assertEquals(selfMethodOf({ type: "cell:tick" }), null);
  assertThrows(() => self(""), Error, "non-empty");
});

Deno.test("self() in a $do'd schedule resolves to THIS cell's method (no CellEffect annotation)", async () => {
  const c = cell("selfcycle", {
    state: { n: 0 },
    methods: {
      // NOTE: no `: CellEffect` return annotation, no cell self-reference —
      // the exact TS7022 shape this feature deletes.
      tick(s: { n: number } & MethodDraftMeta, by = 1) {
        s.n += by;
        if (s.n < 3) {
          s.$do!(schedule.after("selfcycle:next", 10, self("tick", 1)));
        }
      },
    },
  });
  const h = await bootCells([c]);
  try {
    await (c as Any).tick(1);
    assertEquals((c as Any).n, 1);
    await h.advance(10);
    assertEquals((c as Any).n, 2);
    await h.advance(10);
    assertEquals(
      (c as Any).n,
      3,
      "the chain re-armed itself twice then stopped",
    );
    await h.advance(50);
    assertEquals((c as Any).n, 3, "no further arming");
  } finally {
    h.dispose();
  }
});

Deno.test("self() naming an UNKNOWN method throws at dispatch, naming cell + known methods", async () => {
  const c = cell("selfbad", {
    state: { n: 0 },
    methods: {
      go(s: { n: number } & MethodDraftMeta) {
        s.$do!(schedule.after("selfbad:t", 10, self("tikc"))); // typo
      },
    },
  });
  const h = await bootCells([c]);
  try {
    const e = await assertRejects(() => (c as Any).go());
    assertStringIncludes(String(e), 'self("tikc")');
    assertStringIncludes(String(e), "selfbad");
    assertStringIncludes(String(e), "go"); // known methods listed
  } finally {
    h.dispose();
  }
});

Deno.test("self() in cancelOn is validated at cell() time — unknown method throws at DEFINITION", () => {
  const e = assertThrows(() =>
    cell("selfcancelbad", {
      state: { n: 0 },
      cancelOn: { search: [self("claer")] }, // typo — statically present
      methods: {
        clear(s: { n: number }) {
          s.n = 0;
        },
        async search(s: { n: number }) {
          await Promise.resolve();
          s.n++;
        },
      },
    })
  );
  assertStringIncludes(String(e), 'self("claer")');
  assertStringIncludes(String(e), "clear");
});

Deno.test("self() in cancelOn resolves and CANCELS the in-flight call", async () => {
  let release: (() => void) | null = null;
  const c = cell("selfcancel", {
    state: { n: 0, aborted: false },
    transaction: false, // the abort flag is written AFTER the signal fires
    cancelOn: { search: [self("clear")] },
    methods: {
      clear(s: { n: number }) {
        s.n = 0;
      },
      async search(s: { aborted: boolean } & MethodDraftMeta) {
        await new Promise<void>((r) => (release = r));
        s.aborted = s.$signal.aborted;
      },
    },
  });
  const h = await bootCells([c]);
  try {
    const p = (c as Any).search();
    await (c as Any).clear(); // the self-resolved trigger
    release!();
    await p;
    await h.settle();
    assertEquals(
      (c as Any).aborted,
      true,
      "clear() aborted the running search()",
    );
  } finally {
    h.dispose();
  }
});

Deno.test("an UNRESOLVED self() reaching the scheduler is refused loudly (aio.run schedules)", () => {
  const noop = { info() {}, warn() {}, error() {}, debug() {} };
  const m = createScheduleManager(() => {}, noop);
  const e = assertThrows(() =>
    m.start([{ id: "cfg", after: 1000, action: self("tick") }])
  );
  assertStringIncludes(String(e), "never resolved");
  assert(m.active().length === 0, "nothing armed");
  const e2 = assertThrows(() =>
    m.handle(schedule.after("dyn", 1000, self("tick")))
  );
  assertStringIncludes(String(e2), 'self("tick")');
});
