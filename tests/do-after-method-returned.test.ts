// `s.$do` handed out by a method outlived it. A sync method's `$do` pushed into
// the effect list its reduce had ALREADY classified and returned — so a
// captured `s.$do(...)` called from a `setTimeout` (or stashed and called by a
// later method) ran nothing and said nothing. A plain async method's `$do`
// after settle still sends the effect (its state view is sealed then, see
// async-view-sealed-after-settle.test.ts) — not silent, left as is — but a
// transactional one buffered it into a write-set that had already published:
// dropped, silently. Both silent cases now run nothing and LOG the refusal by
// cell, method and "after the method returned" — dev and prod alike, once.
// Where it is thrown depends on who would catch it: inside another method
// body (the stashed `$do`) it throws and fails that method; from a timer or a
// listener it does NOT throw — nothing is there to catch it, and an uncaught
// throw would end the process (1.0.10 was a silent no-op there, not a crash).
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { cell } from "../src/state/cell-create.ts";
import { bootCells } from "../src/testing/cell-test.ts";
import { schedule } from "../src/state/schedule.ts";
import { self } from "../src/state/self.ts";
import type { MethodDraftMeta } from "../src/state/cell-impl.ts";
import { getLogger, setLogger } from "../src/diagnostics/logger-api.ts";

// deno-lint-ignore no-explicit-any
type Any = any;
type Do = MethodDraftMeta["$do"];

const late: { error?: string; stash?: Do } = {};
const lateCall = (d: Do, id: string) => {
  try {
    d!(schedule.after(id, 1, self("tick")));
    late.error = "(no error)";
  } catch (e) {
    late.error = String(e);
  }
};

const mk = (name: string, transaction = false) =>
  cell(name, {
    state: { ticks: 0 },
    methods: {
      tick(s: { ticks: number }) {
        s.ticks++;
      },
      arm(s: Record<string, unknown> & MethodDraftMeta) {
        const d = s.$do;
        setTimeout(() => lateCall(d, `${name}:sync`), 5);
      },
      armProp(s: Record<string, unknown> & MethodDraftMeta) {
        // Not a detached reference: the property read itself happens late.
        setTimeout(() => {
          try {
            s.$do!(schedule.after(`${name}:prop`, 1, self("tick")));
            late.error = "(no error)";
          } catch (e) {
            late.error = String(e);
          }
        }, 5);
      },
      stash(s: Record<string, unknown> & MethodDraftMeta) {
        late.stash = s.$do;
      },
      useStash(s: { ticks: number }) {
        s.ticks = 100;
        late.stash!(schedule.after(`${name}:stash`, 1, self("tick")));
      },
      async armAsync(s: Record<string, unknown> & MethodDraftMeta) {
        await Promise.resolve();
        const d = s.$do;
        setTimeout(() => lateCall(d, `${name}:async`), 5);
      },
    },
    ...(transaction ? { transaction: true } : {}),
  } as Any);

/** Every `log.error` line while `fn` runs. */
async function errorsDuring(fn: () => Promise<unknown>): Promise<string[]> {
  const seen: string[] = [];
  const prev = getLogger();
  setLogger({
    logDir: "",
    pub: (lvl: string, _cat: string, msg: string) => {
      if (lvl === "error") seen.push(msg);
    },
    perf: () => {},
    flush: () => Promise.resolve(),
  } as Any);
  try {
    await fn();
  } finally {
    setLogger(prev);
  }
  return seen;
}

const LATE = "s.$do(...) called after the method returned";

async function run(
  name: string,
  method: string,
  transaction = false,
): Promise<{ ticks: number; errors: string[] }> {
  const c = mk(name, transaction);
  const h = await bootCells([c]);
  let ticks = -1;
  try {
    late.error = undefined;
    const errors = await errorsDuring(async () => {
      await (c as Any)[method]();
      await new Promise((r) => setTimeout(r, 20));
      await h.advance(50);
      ticks = (c as Any).ticks;
    });
    return { ticks, errors: errors.filter((m) => m.includes(LATE)) };
  } finally {
    h.dispose();
  }
}

// `lateCall` records a throw instead of letting it escape the timer: in a real
// app nothing catches it there, and it ends the process. "(no error)" means
// the late call returned.
Deno.test("$do (sync) captured and called after the method returned is refused by name in the log, runs nothing, throws nothing", async () => {
  const { ticks, errors } = await run("do_late_sync", "arm");
  assertEquals(late.error, "(no error)", "no throw into the timer");
  assertEquals(errors.length, 1, "logged exactly once");
  assertStringIncludes(
    errors[0] ?? "(none)",
    "[do_late_sync] arm(): s.$do(...) called after the method returned",
  );
  assertEquals(ticks, 0, "the late effect did not run");
});

Deno.test("$do (sync) read off s after the method returned throws too", async () => {
  // The draft is revoked at return, so the late READ of `s.$do` already
  // throws (a proxy TypeError) — loud before our refusal is even reached.
  const { ticks } = await run("do_late_prop", "armProp");
  assertStringIncludes(late.error ?? "(unset)", "revoked");
  assertEquals(ticks, 0);
});

Deno.test("$do (async, transaction) after the call settled is refused by name in the log — not dropped into a published write-set, no throw", async () => {
  const { ticks, errors } = await run("do_late_tx", "armAsync", true);
  assertEquals(late.error, "(no error)", "no throw into the timer");
  assertEquals(errors.length, 1, "logged exactly once");
  assertStringIncludes(
    errors[0] ?? "(none)",
    "[do_late_tx] armAsync(): s.$do(...) called after the method returned",
  );
  assertEquals(ticks, 0);
});

Deno.test("$do (sync) stashed and called by a LATER method fails that call — no effect, no write", async () => {
  const c = mk("do_late_stash");
  const h = await bootCells([c]);
  try {
    await (c as Any).stash();
    const errors = await errorsDuring(() =>
      assertRejects(
        () => (c as Any).useStash(),
        Error,
        "[do_late_stash] stash(): s.$do(...) called after the method returned",
      )
    );
    // Logged at the refusal, and again by the dispatcher as the failing
    // call's error — the point is that it is never zero.
    assert(
      errors.some((m) => m.includes(LATE)),
      "the refusal is logged as well",
    );
    await h.advance(50);
    assertEquals((c as Any).ticks, 0, "the failing call committed nothing");
  } finally {
    h.dispose();
  }
});

Deno.test("$do (async, transaction) stashed and called by a LATER method fails that call", async () => {
  const c = cell("do_late_tx_stash", {
    state: { ticks: 0 },
    transaction: true,
    methods: {
      tick(s: { ticks: number }) {
        s.ticks++;
      },
      async stash(s: Record<string, unknown> & MethodDraftMeta) {
        await Promise.resolve();
        late.stash = s.$do;
      },
      useStash(s: { ticks: number }) {
        s.ticks = 100;
        late.stash!(schedule.after("do_late_tx_stash:x", 1, self("tick")));
      },
    },
  } as Any);
  const h = await bootCells([c]);
  try {
    await (c as Any).stash();
    await assertRejects(
      () => (c as Any).useStash(),
      Error,
      "[do_late_tx_stash] stash(): s.$do(...) called after the method returned",
    );
    await h.advance(50);
    assertEquals((c as Any).ticks, 0, "the failing call committed nothing");
  } finally {
    h.dispose();
  }
});
