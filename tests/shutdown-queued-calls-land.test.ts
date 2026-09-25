// A call ACCEPTED before `close()` — but still queued behind a per-cell lock
// (`transaction: { serialize: true }`, `concurrency: "queue"`) — must land.
//
// Hunt finding: 20 serialized calls, then `app.close()`. All 20 promises
// RESOLVED, and 19 writes were gone after reboot — only a debug log said so.
// Shutdown's abort sweep reached the queued calls' controllers (they exist from
// dispatch), so each one started its body with an already-fired signal, and a
// transaction that ends aborted discards its write-set and resolves
// `undefined`. The same 20 calls without `transaction` all landed. The
// documented contract (docs/debugging/errors.md, DISPATCH_DRAINING) is that a
// closing app refuses NEW input and in-flight writes still land: a queued
// call is accepted input whose body simply has not run yet, so shutdown's
// abort is not its to take — only a body already running is interrupted.
import { assert, assertEquals } from "@std/assert";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

const N = 20;

async function assertQueuedCallsLand(
  id: string,
  extra: Record<string, unknown>,
  writes: (s: Any, i: number) => void,
  read: (st: Any) => number[],
) {
  const { aio, cell } = await import("../mod.ts");
  const dir = await tempDir(`aio-queued-land-${id}-`);
  const mk = () =>
    cell(id, {
      ...extra,
      state: { log: [] as number[], f: {} as Record<string, number> },
      methods: {
        async add(s: Any, i: number) {
          await Promise.resolve();
          writes(s, i);
          return i;
        },
      },
    } as Any) as Any;
  const boot = (c: unknown) =>
    aio.run({
      cells: [c],
      appId: `queued-land-${id}`,
      appDir: dir,
      client: "server-only",
      libraryMode: true,
      singleton: false,
      persist: true,
      port: freePort(),
    } as Any);
  try {
    let c = mk();
    let app = await boot(c);
    const outcomes = Array.from(
      { length: N },
      (_, i) => (c.add(i) as Promise<number>).then((v) => v, (e) => e),
    );
    // Close while (almost) every call is still queued behind the lock.
    const closing = app.close();
    const results = await Promise.all(outcomes);
    await closing;
    c = mk();
    app = await boot(c);
    try {
      const disk = read(app.getState()[id]);
      assertEquals(
        results,
        Array.from({ length: N }, (_, i) => i),
        "every accepted call resolves with its own value",
      );
      assertEquals(
        [...disk].sort((a, b) => a - b),
        Array.from({ length: N }, (_, i) => i),
        "every accepted call's write is on disk after reboot",
      );
    } finally {
      await app.close();
    }
  } finally {
    await dropTempDir(dir);
  }
}

Deno.test("shutdown: serialized transactional calls queued at close() all land", async () => {
  await assertQueuedCallsLand(
    "qland_ser",
    { transaction: { serialize: true } },
    (s, i) => s.log.push(i),
    (st) => st.log,
  );
});

Deno.test("shutdown: concurrency queue calls queued at close() all land", async () => {
  await assertQueuedCallsLand(
    "qland_q",
    { concurrency: { add: "queue" } },
    (s, i) => s.log.push(i),
    (st) => st.log,
  );
});

Deno.test("shutdown: transaction: true (unserialized) calls at close() all land", async () => {
  await assertQueuedCallsLand(
    "qland_tx",
    { transaction: true },
    // Disjoint keys: concurrent transactions that do not conflict.
    (s, i) => {
      s.f[`k${i}`] = i;
    },
    (st) => Object.values(st.f) as number[],
  );
});

// The other half of the contract: a queued call whose body IS signal-aware —
// the documented stand-down loop `while (!s.$signal.aborted) { … }` — must
// stop because the app closed. Shutdown interrupts every body it has not
// seen finish; a queued one is interrupted the moment it starts. Nothing of
// a closed app may keep running after `close()` resolves, and a lock that
// frees INSIDE the drain must not make `close()` sit out the whole deadline.
async function standDown(
  id: string,
  extra: Record<string, unknown>,
  holdMs: number,
) {
  const { aio, cell } = await import("../mod.ts");
  const dir = await tempDir(`aio-queued-standdown-${id}-`);
  let ticks = 0;
  const c = cell(id, {
    ...extra,
    state: { n: 0 },
    methods: {
      async job(s: Any, hold: number) {
        if (hold > 0) {
          // The holder ignores its signal: the lock frees at `hold`.
          await new Promise((r) => setTimeout(r, hold));
          return "held";
        }
        while (!s.$signal.aborted) {
          await new Promise((r) => setTimeout(r, 50));
          ticks++;
        }
        return "stopped";
      },
    },
  } as Any) as Any;
  const app = await aio.run({
    cells: [c],
    appId: `queued-standdown-${id}`,
    appDir: dir,
    client: "server-only",
    libraryMode: true,
    singleton: false,
    persist: true,
    port: freePort(),
  } as Any);
  try {
    const holder = c.job(holdMs).then(() => {}, () => {});
    let settled = false;
    const queued = (c.job(0) as Promise<unknown>).then(
      (v) => (settled = true, v),
      (e) => (settled = true, e),
    );
    await new Promise((r) => setTimeout(r, 20));
    const t0 = Date.now();
    await app.close();
    const closeMs = Date.now() - t0;
    const ticksAtClose = ticks;
    // Let the holder free the lock (if it has not) and anything left run.
    await holder;
    await new Promise((r) => setTimeout(r, 300));
    return { closeMs, ticksAtClose, ticks, settled, queued };
  } finally {
    await dropTempDir(dir);
  }
}

for (
  const [mode, extra] of [
    ["serialize", { transaction: { serialize: true } }],
    ["queue", { concurrency: { job: "queue" } }],
  ] as const
) {
  Deno.test(`shutdown: a ${mode} stand-down loop queued past the drain deadline never runs after close()`, async () => {
    // The holder outlives the 3 s drain: the queued call starts AFTER close()
    // resolved, and must find its signal already fired.
    const r = await standDown(`qsd_late_${mode}`, extra, 3300);
    assertEquals(r.ticks, r.ticksAtClose, "the loop ticked after close()");
    assertEquals(r.settled, true, "the queued call never settled");
  });

  Deno.test(`shutdown: a ${mode} stand-down loop whose lock frees inside the drain ends it early`, async () => {
    const r = await standDown(`qsd_early_${mode}`, extra, 300);
    assertEquals(r.settled, true, "the queued call never settled");
    assertEquals(r.ticks, r.ticksAtClose, "the loop ticked after close()");
    assert(
      r.closeMs < 2000,
      `close() waited ${r.closeMs}ms — the whole drain deadline`,
    );
  });
}

Deno.test("shutdown: a queued transaction that read $signal and stood down commits nothing", async () => {
  // The other side of "a body that never read its signal commits whole": one
  // that DID read it may have stopped half-way, and half a transaction must
  // never reach disk.
  const { aio, cell } = await import("../mod.ts");
  const dir = await tempDir("aio-queued-standdown-tx-");
  const mk = () =>
    cell("qsd_tx", {
      transaction: { serialize: true },
      state: { half: 0 },
      methods: {
        async job(s: Any, hold: number) {
          if (hold > 0) {
            await new Promise((r) => setTimeout(r, hold));
            return "held";
          }
          s.half = 1; // the first half of the transaction…
          await Promise.resolve();
          if (s.$signal.aborted) return "stood down"; // …and it stops here
          s.half = 2;
          return "whole";
        },
      },
    } as Any) as Any;
  const boot = (c: unknown) =>
    aio.run({
      cells: [c],
      appId: "queued-standdown-tx",
      appDir: dir,
      client: "server-only",
      libraryMode: true,
      singleton: false,
      persist: true,
      port: freePort(),
    } as Any);
  try {
    let c = mk();
    let app = await boot(c);
    const holder = c.job(200).then(() => {}, () => {});
    const queued = (c.job(0) as Promise<unknown>).then((v) => v, (e) => e);
    await new Promise((r) => setTimeout(r, 20));
    await app.close();
    await holder;
    assertEquals(
      await queued,
      undefined,
      "a cancelled call resolves undefined",
    );
    c = mk();
    app = await boot(c);
    try {
      assertEquals(app.getState().qsd_tx.half, 0, "half a transaction landed");
    } finally {
      await app.close();
    }
  } finally {
    await dropTempDir(dir);
  }
});
