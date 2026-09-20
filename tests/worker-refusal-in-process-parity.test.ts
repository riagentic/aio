// `worker: true` must not change what an in-process `await cell.method()` does
// with a REFUSED write.
//
// `refusalsReject` is opt-in for a stated reason (cell-compose-reduce.ts): "the
// aligned behaviour cannot be the default in 1.x — an app doing
// `await c.method(); if (c.x !== want) …` in process would get a rejection
// where it had a value". So with the flag off, a refused write RESOLVES in
// process (with a dev warning) and is answered ACTION_REFUSED on the wire.
//
// The worker host's refusal ack posts `fail`, and `fail` with a callId is
// `resolveCall(callId, undefined, err)` — a REJECTION of the awaiting caller.
// That gave one config three behaviours:
//
//   main-isolate cell            → resolves
//   in-isolate worker stand-in   → resolves  (dispatch is the main dispatch)
//   REAL worker cell             → rejects
//
// …so adding `worker: true` to a working cell changed what its callers see,
// and `refusalsReject: false` stopped meaning anything for that cell. The wire
// ack is where the refusal belongs; the in-process promise answers to the flag.
import { assert, assertEquals } from "@std/assert";
import { testServer } from "../src/testing/server-test.ts";
import {
  refusingMain,
  refusingWorker,
} from "./fixtures/worker-validate-app.ts";

const ENTRY = import.meta.resolve("./fixtures/worker-validate-app.ts");

/** resolved | rejected — never the assertion itself, so the two cells are
 *  compared rather than one of them asserted. */
async function outcome(
  call: () => Promise<unknown>,
): Promise<{ kind: "resolved" | "rejected"; detail: string }> {
  try {
    const v = await call();
    return { kind: "resolved", detail: String(v) };
  } catch (e) {
    return { kind: "rejected", detail: String(e) };
  }
}

Deno.test("worker cell: a refused write answers its in-process caller the way a main-isolate cell does", async () => {
  await using srv = await testServer({
    cells: [refusingWorker, refusingMain],
    workers: "real",
    workerEntry: ENTRY,
    // Left at its default (false) on purpose — that is the contract under test.
  } as never);
  void srv;

  // The control: a plain cell with the same validate.
  const main = await outcome(() =>
    (refusingMain as unknown as { setN: (n: number) => Promise<unknown> })
      .setN(99)
  );
  const worker = await outcome(() =>
    (refusingWorker as unknown as { setN: (n: number) => Promise<unknown> })
      .setN(99)
  );

  assertEquals(
    main.kind,
    "resolved",
    `refusalsReject is off, so the in-process caller is resolved: ${main.detail}`,
  );
  assertEquals(
    worker.kind,
    main.kind,
    `\`worker: true\` changed the answer an in-process caller gets for a ` +
      `refused write — main: ${main.kind} (${main.detail}), worker: ` +
      `${worker.kind} (${worker.detail}). refusalsReject decides that, not ` +
      `which isolate the cell runs in.`,
  );

  // …and the refusal still HAPPENED: neither write landed.
  const w = refusingWorker as unknown as { n: number };
  const m = refusingMain as unknown as { n: number };
  assert(w.n <= 10, `the worker cell's refused write must not land: ${w.n}`);
  assert(m.n <= 10, `the main cell's refused write must not land: ${m.n}`);
});

// The other half of the same flag. A worker composes its own reduce and was
// never handed `refusalsReject`, so with the flag ON the main-isolate cell
// threw and the worker cell resolved — the same divergence, mirrored. The flag
// now crosses the thread, and the reply is chosen by it.
Deno.test("worker cell: refusalsReject:true rejects an in-process caller on both isolates", async () => {
  await using srv = await testServer({
    cells: [refusingWorker, refusingMain],
    workers: "real",
    workerEntry: ENTRY,
    refusalsReject: true,
  } as never);
  void srv;

  const main = await outcome(() =>
    (refusingMain as unknown as { setN: (n: number) => Promise<unknown> })
      .setN(99)
  );
  const worker = await outcome(() =>
    (refusingWorker as unknown as { setN: (n: number) => Promise<unknown> })
      .setN(99)
  );
  assertEquals(
    main.kind,
    "rejected",
    `refusalsReject is on: ${main.detail}`,
  );
  assertEquals(
    worker.kind,
    main.kind,
    `the flag has to mean the same thing inside a worker — main: ` +
      `${main.kind} (${main.detail}), worker: ${worker.kind} ` +
      `(${worker.detail})`,
  );
});
