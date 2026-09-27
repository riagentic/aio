// `worker: true` must not make a wrong-type write pass where the same cell on
// the main isolate is refused — and `testServer` refuses it at all.
//
// Dev refuses a committed write that changes a persisted field's declared type
// (declared-shape-guard.ts). The owner ran that guard over the patches a
// worker cell streamed home — already committed in the worker, a
// framework-applied batch the guard only warns about — so the identical method
// threw on the main isolate and resolved as a worker cell. The worker's own
// reduce runs the guard now, on the owner's decision. And `testServer`
// (`persist: false`) installed no guard at all, though the dev app it stands
// in for persists by default. A refused call counts one cell error, as any
// method throw does — the worker's async path counted it twice.
import { assertEquals, assertRejects } from "@std/assert";
import { testServer } from "../src/testing/server-test.ts";
import { typedMain, typedWorker } from "./fixtures/worker-type-guard-app.ts";

const ENTRY = import.meta.resolve("./fixtures/worker-type-guard-app.ts");

type Calls = {
  setN: (v: unknown) => Promise<unknown>;
  setNLater: (v: unknown) => Promise<unknown>;
  n: number;
};

Deno.test("worker cell: a write that changes a declared type is refused in dev, as on the main isolate", async () => {
  await using srv = await testServer({
    cells: [typedWorker, typedMain],
    workers: "real",
    workerEntry: ENTRY,
  } as never);
  const cells = (srv.app as unknown as {
    cells: { health(): { name: string; errors: number }[] };
  }).cells;
  const errors = (id: string) =>
    cells.health().find((h) => h.name === id)!.errors;
  const pairs = [["typedMain", typedMain], ["typedWorker", typedWorker]];
  for (const [id, c] of pairs as [string, unknown][]) {
    const m = c as Calls;
    await assertRejects(() => m.setN("x"), Error, `${id}.n`);
    await assertRejects(() => m.setNLater({ a: 1 }), Error, `${id}.n`);
    await m.setN(7);
    assertEquals(m.n, 7, id);
    // One refused call is one cell error, sync or async, in either isolate.
    await new Promise((r) => setTimeout(r, 50));
    assertEquals(errors(id), 2, id);
  }
});
