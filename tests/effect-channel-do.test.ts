// alpha52 — the effect channel: `s.$do(effect, ...)` on sync AND async
// methods; `return` is for values. The old return-effects channel keeps
// working through beta with a one-time-per-method hint. own.set factories
// $do'd from an async method register in the SAME tick (no parked-factory
// residue). Spec: todo.md "the effect channel".
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { cell } from "../src/state/cell-create.ts";
import { bootCells } from "../src/testing/cell-test.ts";
import { schedule } from "../src/state/schedule.ts";
import { _pendingFactoryCount, own } from "../src/state/own.ts";
import { self } from "../src/state/self.ts";
import { log } from "../src/diagnostics/logger.ts";
import { _resetReturnEffectHints } from "../src/state/cell-methods-internals.ts";
import type { MethodDraftMeta } from "../src/state/cell-impl.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

async function captureWarnings(fn: () => Promise<void>): Promise<string[]> {
  const out: string[] = [];
  // deno-lint-ignore no-explicit-any
  const orig = (log as any).warn;
  // deno-lint-ignore no-explicit-any
  (log as any).warn = (...args: unknown[]) => {
    out.push(args.map(String).join(" "));
  };
  try {
    await fn();
  } finally {
    // deno-lint-ignore no-explicit-any
    (log as any).warn = orig;
  }
  return out;
}

Deno.test("$do (sync): a scheduled effect fires, and the return stays a value", async () => {
  const c = cell("do_sync", {
    state: { n: 0, ticks: 0 },
    methods: {
      tick(s: { ticks: number }) {
        s.ticks++;
      },
      arm(s: { n: number } & Partial<MethodDraftMeta>) {
        s.n++;
        s.$do!(schedule.after("do_sync:t", 50, self("tick")));
        return s.n; // a VALUE — travels to the caller alongside the effect
      },
    },
  });
  const h = await bootCells([c]);
  try {
    const v = await (c as Any).arm();
    assertEquals(v, 1, "the return is the value, not the effect");
    assertEquals((c as Any).ticks, 0);
    await h.advance(60);
    assertEquals((c as Any).ticks, 1, "the $do'd schedule fired");
  } finally {
    h.dispose();
  }
});

Deno.test("$do (sync): works with NO return at all (effects-only method)", async () => {
  const c = cell("do_sync2", {
    state: { ticks: 0 },
    methods: {
      tick(s: { ticks: number }) {
        s.ticks++;
      },
      arm(s: Record<string, unknown> & Partial<MethodDraftMeta>) {
        s.$do!(
          schedule.after("do_sync2:a", 10, self("tick")),
          schedule.after("do_sync2:b", 20, self("tick")),
        );
      },
    },
  });
  const h = await bootCells([c]);
  try {
    await (c as Any).arm();
    await h.advance(25);
    assertEquals((c as Any).ticks, 2, "both $do'd effects fired");
  } finally {
    h.dispose();
  }
});

Deno.test("$do: a non-effect argument throws loud, naming the method", async () => {
  const c = cell("do_bad", {
    state: { n: 0 },
    methods: {
      go(s: { n: number } & Partial<MethodDraftMeta>) {
        s.$do!({ type: "do_bad:go" } as Any); // an ACTION, not an effect
      },
      zero(s: Record<string, unknown> & Partial<MethodDraftMeta>) {
        (s.$do as Any)();
      },
    },
  });
  const h = await bootCells([c]);
  try {
    const e = await assertRejects(() => (c as Any).go());
    assertStringIncludes(String(e), "only takes effects");
    assertStringIncludes(String(e), "go()");
    const e2 = await assertRejects(() => (c as Any).zero());
    assertStringIncludes(String(e2), "no effect");
  } finally {
    h.dispose();
  }
});

Deno.test("$do (async): dispatched immediately — an own.set factory is consumed mid-method, not at return", async () => {
  let acquired = 0;
  let disposed = 0;
  let release: (() => void) | null = null;
  const gate = new Promise<void>((r) => (release = r));
  const c = cell("do_async_own", {
    state: { step: "idle" },
    methods: {
      async run(s: { step: string } & Partial<MethodDraftMeta>) {
        s.$do!(own.set("do_async_own:res", () => {
          acquired++;
          return () => disposed++;
        }));
        await gate;
        s.step = "done";
      },
    },
  });
  const h = await bootCells([c]);
  try {
    const p = (c as Any).run();
    // The method is parked on its gate — the factory must ALREADY be consumed
    // ($do dispatches immediately; the return-path buffer would still be
    // holding it, and its token parked in the side-channel).
    await h.settle();
    assertEquals(
      acquired,
      1,
      "own.set factory ran while the method was mid-flight",
    );
    assertEquals(
      _pendingFactoryCount(),
      0,
      "no parked factory left in the side-channel",
    );
    release!();
    await p;
    await h.settle();
    assertEquals((c as Any).step, "done");
  } finally {
    h.dispose();
    assertEquals(disposed, 1, "disposer ran on teardown");
  }
});

Deno.test("$do (async): schedule effect + returned value coexist", async () => {
  const c = cell("do_async_val", {
    state: { ticks: 0 },
    methods: {
      tick(s: { ticks: number }) {
        s.ticks++;
      },
      async work(s: Record<string, unknown> & Partial<MethodDraftMeta>) {
        await Promise.resolve();
        s.$do!(schedule.after("do_async_val:t", 30, self("tick")));
        return "payload";
      },
    },
  });
  const h = await bootCells([c]);
  try {
    const v = await (c as Any).work();
    assertEquals(v, "payload");
    await h.advance(40);
    assertEquals((c as Any).ticks, 1);
  } finally {
    h.dispose();
  }
});

Deno.test("deprecated: RETURNING effects still works, with a ONE-TIME hint per method", async () => {
  _resetReturnEffectHints();
  const c = cell("do_legacy", {
    state: { ticks: 0 },
    methods: {
      tick(s: { ticks: number }) {
        s.ticks++;
      },
      arm() {
        return schedule.after("do_legacy:t", 10, { type: "do_legacy:tick" });
      },
      async armAsync() {
        await Promise.resolve();
        return schedule.after("do_legacy:t2", 10, { type: "do_legacy:tick" });
      },
    },
  });
  const h = await bootCells([c]);
  try {
    const warns = await captureWarnings(async () => {
      await (c as Any).arm();
      await (c as Any).arm(); // second call — hint must NOT repeat
      await (c as Any).armAsync();
      await h.settle();
    });
    await h.advance(15);
    assertEquals((c as Any).ticks, 2, "both legacy channels still fire");
    const hints = warns.filter((w) => w.includes("deprecated"));
    assertEquals(
      hints.filter((w) => w.includes("'arm'")).length,
      1,
      "one hint for the sync method, exactly once",
    );
    assertEquals(
      hints.filter((w) => w.includes("'armAsync'")).length,
      1,
      "one hint for the async method",
    );
    assert(hints.every((w) => w.includes("s.$do")), "the hint names the fix");
  } finally {
    h.dispose();
  }
});

Deno.test("deprecated return path + $do can MIX in one method (both run)", async () => {
  _resetReturnEffectHints();
  const c = cell("do_mix", {
    state: { ticks: 0 },
    methods: {
      tick(s: { ticks: number }) {
        s.ticks++;
      },
      arm(s: Record<string, unknown> & Partial<MethodDraftMeta>) {
        s.$do!(schedule.after("do_mix:a", 10, self("tick")));
        return schedule.after("do_mix:b", 20, self("tick")); // legacy
      },
    },
  });
  const h = await bootCells([c]);
  try {
    await (c as Any).arm();
    await h.advance(25);
    assertEquals((c as Any).ticks, 2, "$do'd and returned effects both fired");
  } finally {
    h.dispose();
  }
});

Deno.test("$do effect payloads referencing the draft commit as plain data", async () => {
  const c = cell("do_payload", {
    state: { items: [1, 2], got: null as unknown },
    methods: {
      recv(s: { got: unknown }, v: unknown) {
        s.got = v;
      },
      arm(s: { items: number[] } & Partial<MethodDraftMeta>) {
        s.items.push(3);
        // Payload references the DRAFT — must survive draft revocation
        // (cloned where cloneEffects runs, while the draft is alive).
        s.$do!(
          schedule.after("do_payload:t", 10, {
            type: "do_payload:recv",
            payload: { args: [s.items] },
          }),
        );
      },
    },
  });
  const h = await bootCells([c]);
  try {
    await (c as Any).arm();
    await h.advance(15);
    assertEquals(
      (c as Any).got,
      [1, 2, 3],
      "draft-referencing payload landed as plain data",
    );
  } finally {
    h.dispose();
  }
});
