// `workerRespawn: true` — a crashed worker cell is started again — and
// `crashWorker(cell)`, the test hook that proves what an app does about it.
//
// A crashed `worker: true` cell answers every later call with the crash until
// the app restarts (tests/worker-lifecycle-once.test.ts). A field report: its
// one heavy cell held the key derivation and the device sessions, so a single
// uncaught error in an FFI callback meant no unlock and no signing until the
// user restarted the app. The default stays; `workerRespawn` is the opt-in.
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  bootCells,
  crashWorker,
  testCell,
  testServer,
} from "../src/cell-test.ts";
import { plainProbe, respawnProbe } from "./fixtures/worker-respawn-app.ts";

const ENTRY = import.meta.resolve("./fixtures/worker-respawn-app.ts");

type Probe = {
  inc(k: number): Promise<number>;
  where(): Promise<{ isolate: string; inits: number }>;
  crash(): Promise<void>;
  dieMidway(): Promise<void>;
  hold(ms: number): Promise<number>;
};
const R = respawnProbe as unknown as Probe;
const P = plainProbe as unknown as Probe;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const real = (c: typeof respawnProbe | typeof plainProbe) =>
  testServer({ cells: [c], workers: "real", workerEntry: ENTRY });
const health = async (url: string) =>
  await (await fetch(`${url}/__aio/health`)).json() as {
    status: string;
    degraded?: { name: string; lastError: string }[];
  };

/** Wait for a worker other than `was` to answer. */
async function nextIsolate(was: string) {
  for (let i = 0; i < 250; i++) {
    const now = await R.where().catch(() => null);
    if (now && now.isolate !== was) return now;
    await sleep(20);
  }
  throw new Error("no respawned worker answered within 5s");
}

Deno.test("workerRespawn — after a real crash the next call runs on a fresh worker, from the last committed state", async () => {
  await using srv = await real(respawnProbe);
  assertEquals(await R.inc(5), 5);
  const first = await R.where();
  assertEquals(first.inits, 1);
  // In flight when the thread dies: refused with the crash, not left hanging.
  const e = await assertRejects(() => R.dieMidway(), Error, "crashed");
  assertStringIncludes(e.message, "worker loop died");
  const second = await nextIsolate(first.isolate);
  // A new isolate, and ITS onInit ran — once.
  assertEquals(second.inits, 1);
  // What the dead worker committed before it died is kept (5 + 100); what it
  // never reached (+1000) is not.
  assertEquals(await R.inc(1), 106);
  assertEquals(
    (srv.state() as { respawnProbe: { n: number } }).respawnProbe.n,
    106,
  );
  // The fresh worker's `ready` ended the degraded episode.
  assertEquals((await health(srv.url)).status, "healthy");
});

Deno.test("workerRespawn — a crash loop is bounded: the third crash in the window stays dead and says so", async () => {
  await using srv = await real(respawnProbe);
  let iso = (await R.where()).isolate;
  for (const _ of [1, 2]) {
    crashWorker(respawnProbe);
    iso = (await nextIsolate(iso)).isolate;
  }
  const held = R.hold(2_000);
  crashWorker(respawnProbe);
  await assertRejects(() => held, Error, "crash 3 in 60s");
  const e = await assertRejects(() => R.inc(1), Error, "respawn stopped");
  assertStringIncludes(e.message, 'cell worker "respawnProbe" crashed');
  assertStringIncludes(e.message, "was not applied");
  const h = await health(srv.url);
  assertEquals(h.status, "degraded");
  const entry = h.degraded?.find((d) => d.name === "cell-worker:respawnProbe");
  assertStringIncludes(entry?.lastError ?? "", "crash 3 in 60s");
  // Nothing left to crash — said, not swallowed.
  assertThrows(() => crashWorker(respawnProbe), Error, "no live worker");
});

Deno.test("worker: true — the default is unchanged: a crash is final, later calls are refused by name", async () => {
  await using _srv = await real(plainProbe);
  assertEquals(await P.inc(1), 1);
  const held = P.hold(2_000);
  crashWorker(plainProbe);
  await assertRejects(() => held, Error, "crashed");
  await sleep(100);
  const e = await assertRejects(() => P.inc(1), Error, "crashed");
  assertStringIncludes(e.message, "plainProbe");
  assertStringIncludes(e.message, "unreachable for the life of the process");
});

Deno.test("crashWorker under bootCells: in-flight refused; worker: true stays dead, by name", async () => {
  await using _h = await bootCells([plainProbe]);
  assertEquals(await P.inc(2), 2);
  const held = P.hold(20);
  crashWorker(plainProbe);
  await assertRejects(() => held, Error, 'cell worker "plainProbe" crashed');
  const e = await assertRejects(() => P.inc(1), Error, "crashed");
  assertStringIncludes(e.message, 'action "plainProbe:inc" was not applied');
  assertThrows(() => crashWorker(plainProbe), Error, "already crashed");
  await sleep(40); // the in-process body cannot be killed: let its timer end
});

Deno.test("crashWorker under bootCells: workerRespawn serves the next call from the committed state, three crashes end it", async () => {
  await using _h = await bootCells([respawnProbe]);
  assertEquals(await R.inc(2), 2);
  const held = R.hold(20);
  crashWorker(respawnProbe);
  await assertRejects(() => held, Error, "crashed");
  assertEquals(await R.inc(1), 3);
  crashWorker(respawnProbe);
  assertEquals(await R.inc(1), 4);
  crashWorker(respawnProbe);
  await assertRejects(() => R.inc(1), Error, "crash 3 in 60s");
  await sleep(40);
});

Deno.test("crashWorker: a harness's crash does not outlive it, and a cell nobody runs is refused", async () => {
  {
    // Dead in the test above's sense — a fresh boot starts alive.
    await using _h = await bootCells([plainProbe]);
    crashWorker(plainProbe);
  }
  assertThrows(() => crashWorker(plainProbe), Error, "no live worker");
  await using _h = await bootCells([plainProbe]);
  await P.inc(1);
  // In-isolate testServer has no worker and no in-process door: said so.
  assertThrows(
    () => crashWorker({ __aio: { id: "nobody", worker: true } }),
    Error,
    'workers: "real"',
  );
  assertThrows(
    () => crashWorker({ __aio: { id: "plain" } }),
    Error,
    "not a worker cell",
  );
});

testCell(
  plainProbe,
  "crashWorker under testCell: later calls are refused by name",
  async (t) => {
    const send = t.send as unknown as Probe;
    assertEquals(await send.inc(1), 1);
    crashWorker(plainProbe);
    const e = await assertRejects(() => send.inc(1), Error, "crashed");
    assertStringIncludes(e.message, "plainProbe");
  },
);

Deno.test("cell(): a mistyped or misplaced workerRespawn is refused at declaration", async () => {
  const { cell } = await import("../mod.ts");
  const refused = (cfg: Record<string, unknown>) =>
    assertThrows(
      () => cell("wrsBad", { state: { n: 0 }, ...cfg } as never),
      Error,
    ).message;
  assertStringIncludes(
    refused({ worker: true, workerRespawn: "yes" }),
    'workerRespawn must be a boolean, got "yes"',
  );
  assertStringIncludes(
    refused({ workerRespawn: true }),
    "workerRespawn: true needs worker: true",
  );
  assertStringIncludes(
    refused({ worker: true, workerRespwan: true }),
    "workerRespawn",
  );
  const ok = cell("wrsOk", {
    state: { n: 0 },
    worker: true,
    workerRespawn: true,
  });
  assert(ok.__aio.worker === true && ok.__aio.workerRespawn === true);
  assert(
    cell("wrsPlain", { state: { n: 0 }, worker: true }).__aio.workerRespawn ===
      false,
  );
});
