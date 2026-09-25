// A worker cell's `onInit` runs ONCE per boot — not again on every re-seed.
//
// The main isolate re-seeds a worker cell whenever it swaps state wholesale
// (time travel, `app.loadSnapshot`) by re-sending the `init` message. The host
// treated every `init` as a boot and walked `initAll` again, so each undo in
// the devtools and each snapshot load re-ran the cell's `onInit` in the worker:
// a device opened again, a watcher armed again, and an onInit that dispatches
// (docs/state/lifecycle.md idiom #1) wrote AGAIN on top of the state that had
// just been restored. The same cell on the main isolate inits once.
import { assertEquals } from "@std/assert";
import { testServer } from "../src/testing/server-test.ts";
import { reseedProbe } from "./fixtures/worker-reseed-app.ts";

const ENTRY = import.meta.resolve("./fixtures/worker-reseed-app.ts");

Deno.test("worker cell: a re-seed (snapshot load) does not re-run onInit", async () => {
  await using srv = await testServer({
    cells: [reseedProbe],
    workers: "real",
    workerEntry: ENTRY,
  });
  assertEquals(await reseedProbe.initCount(), 1, "one boot, one onInit");
  await reseedProbe.set(7);
  const snap = srv.app.snapshot!();
  const boots = (srv.state() as { reseedProbe: { boots: number } })
    .reseedProbe.boots;
  srv.app.loadSnapshot!(snap);
  srv.app.loadSnapshot!(snap);
  // The worker holds the restored slice (it serves the next call from it)…
  await reseedProbe.set(8);
  assertEquals(
    (srv.state() as { reseedProbe: { n: number } }).reseedProbe.n,
    8,
  );
  // …and its lifecycle did not start over.
  assertEquals(
    await reseedProbe.initCount(),
    1,
    "onInit re-ran in the worker on a re-seed",
  );
  assertEquals(
    (srv.state() as { reseedProbe: { boots: number } }).reseedProbe.boots,
    boots,
    "the re-seed replayed onInit's dispatch on top of the restored state",
  );
});

// The boot half of the same message. `onInit` ran when `init` arrived — at
// spawn, before the main isolate had wired its broadcast — so the write an
// `onInit` dispatches (lifecycle.md idiom #1) was applied in the worker and
// REFUSED on main: REDUCE_ERROR "reading 'broadcastTT'" at every boot, and the
// authoritative replica never held the write the worker went on building on.
Deno.test("worker cell: onInit's dispatch at boot lands on the main isolate", async () => {
  await using srv = await testServer({
    cells: [reseedProbe],
    workers: "real",
    workerEntry: ENTRY,
  });
  const boots = () =>
    (srv.state() as { reseedProbe: { boots: number } }).reseedProbe.boots;
  // A round trip to the worker: FIFO, so its onInit's patch is home by the
  // time this call answers.
  assertEquals(await reseedProbe.initCount(), 1);
  for (let i = 0; i < 50 && boots() === 0; i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
  assertEquals(boots(), 1, "onInit's write never reached the main replica");
});
