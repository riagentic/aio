// Cross-transport differential: a REFUSED call on a `worker: true` cell.
//
// `action-ack.ts` is "ONE decider for 'did this action actually DO anything?'"
// — a method the cell no longer has, a cell that was never booted, a disabled
// cell, a `validate` refusal — because `dispatch` resolves whether or not
// anything ran, and an ack taken from that promise alone says `ok: true` for a
// change that never happened ("a stale client after a rename is the everyday
// version of it: the UI reports success forever and the data never moves").
//
// It reads `takeRejectionFor(action, cell)`, which is keyed to the ACTION
// OBJECT. A worker cell's action does not survive as that object:
//
//   · real worker — the action is postMessage'd, the refusal is recorded in
//     the WORKER's isolate, and the host replied `done` regardless, so the
//     main isolate had nothing to read;
//   · in-isolate (libraryMode / testServer default) — `_workerBoundaryDispatch`
//     structured-clones the action to reproduce the thread boundary and
//     dispatches the CLONE, so the refusal was recorded against an object
//     nobody asks about.
//
// Measured before the fix, same frame, two answers:
//   main-isolate cell  → {ok:false, code:"ACTION_REFUSED", error:"… does NOTHING …"}
//   worker cell        → {ok:true}
//
// …while the server log printed the "does NOTHING" warning for BOTH. The
// harness half matters as much as the production half: a test environment
// more permissive than production manufactures green-test-broken-prod.
import { assertEquals, assertStringIncludes } from "@std/assert";
import { enc } from "../src/protocol/envelope.ts";
import { freePort } from "../src/testing/server-test.ts";
import { testServer } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { isolationProbe } from "./fixtures/worker-isolation-app.ts";

const ENTRY = import.meta.resolve("./fixtures/worker-isolation-app.ts");

type Ack = { cid?: string; ok?: boolean; error?: string; code?: string };

async function wsAck(port: number, d: Record<string, unknown>): Promise<Ack> {
  const ws = new WebSocket(`ws://localhost:${port}/ws`);
  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error("ws never opened"));
  });
  let t: ReturnType<typeof setTimeout> | undefined;
  const ack = new Promise<Ack>((res) => {
    ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data)) as { t: string; d?: unknown };
      if (m.t === "ack") res(m.d as Ack);
    };
    t = setTimeout(() => res({}), 8_000);
  }).finally(() => clearTimeout(t));
  ws.send(enc("action", d));
  const got = await ack;
  ws.close();
  await new Promise((r) => setTimeout(r, 30));
  return got;
}

Deno.test("worker cell: an unknown method is REFUSED on the ack, exactly as a main-isolate cell is", async () => {
  const { aio, cell } = await import("../mod.ts");
  const { _resetAioRuntime } = await import("../src/state/runtime-reset.ts");
  _resetAioRuntime();
  const w = cell("xwrefw", {
    worker: true,
    state: { n: 0 },
    methods: {
      bump(s: { n: number }, by: number) {
        s.n += by;
        return s.n;
      },
    },
    // `worker` is a real cell option; the inline literal needs the cast.
    // deno-lint-ignore no-explicit-any
  } as any);
  const m = cell("xwrefm", {
    state: { n: 0 },
    methods: {
      bump(s: { n: number }, by: number) {
        s.n += by;
        return s.n;
      },
    },
  });
  const dir = await tempDir("worker-refusal-");
  const app = await aio.run({
    cells: [w, m],
    appId: `xwref-${Deno.pid}`,
    client: "server-only",
    persist: false,
    libraryMode: true,
    singleton: false,
    port: freePort(),
    baseDir: dir,
    dbPath: ":memory:",
  } as never);
  const h = app as unknown as { port: number; close: () => Promise<void> };
  try {
    const main = await wsAck(h.port, {
      type: "xwrefm:nope",
      payload: { args: [] },
      cid: "m1",
    });
    const worker = await wsAck(h.port, {
      type: "xwrefw:nope",
      payload: { args: [] },
      cid: "w1",
    });
    // The control: this is what the ack for a refused call looks like.
    assertEquals(
      main.ok,
      false,
      "a main-isolate cell refuses an unknown method",
    );
    assertEquals(main.code, "ACTION_REFUSED");
    assertEquals(
      worker.ok,
      false,
      `a worker cell acked ok for a method it does not have: ${
        JSON.stringify(worker)
      }`,
    );
    assertEquals(worker.code, "ACTION_REFUSED", "same classification");
    assertStringIncludes(worker.error ?? "", "does NOTHING");
    assertStringIncludes(worker.error ?? "", "xwrefw:nope");

    // …and a real call is untouched.
    const ok = await wsAck(h.port, {
      type: "xwrefw:bump",
      payload: { args: [2] },
      cid: "w2",
    });
    assertEquals(
      ok.ok,
      true,
      `a real worker-cell call still succeeds: ${JSON.stringify(ok)}`,
    );
  } finally {
    await h.close();
    await dropTempDir(dir);
  }
});

Deno.test("real worker: an unknown method is REFUSED on the ack too", async () => {
  await using srv = await testServer({
    cells: [isolationProbe],
    workers: "real",
    workerEntry: ENTRY,
  });
  const port = (srv as unknown as { port: number }).port;
  const bad = await wsAck(port, {
    type: "isolationProbe:nope",
    payload: { args: [] },
    cid: "r1",
  });
  assertEquals(
    bad.ok,
    false,
    `a REAL worker acked ok for a method it does not have: ${
      JSON.stringify(bad)
    }`,
  );
  assertEquals(bad.code, "ACTION_REFUSED");
  assertStringIncludes(bad.error ?? "", "does NOTHING");

  const good = await wsAck(port, {
    type: "isolationProbe:bump",
    payload: { args: [] },
    cid: "r2",
  });
  assertEquals(
    good.ok,
    true,
    `a real call still succeeds: ${JSON.stringify(good)}`,
  );
});
