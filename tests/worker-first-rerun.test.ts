// `concurrency: "first"` on a `worker: true` cell whose run reads the caller.
//
// A method not yet seen reading `serverUser()` dedups across callers; when the
// run it adopted turns out to have read ANOTHER caller, the adopter runs
// itself. In a worker, the owner had already stopped counting that adopter in
// `$pending` (the "adopted" report), so the rerun must be counted again — or
// `$pending("scan")` reads 0 for the whole of Bob's running call, where the
// same cell in-isolate reads 1.
//
// This file is its own worker entry: the real worker re-imports it and boots
// into cell-host mode; the tests register only on the main isolate.
import { assertEquals } from "@std/assert";
import { aio, cell, isCellWorker, serverRequest, serverUser } from "../mod.ts";
import { testServer } from "../src/testing/server-test.ts";
import { enc } from "../src/protocol/envelope.ts";

export const rerunW = cell("rerunW", {
  worker: true,
  state: { n: 0 },
  concurrency: { scan: "first" },
  methods: {
    async scan(_s: { n: number }) {
      await new Promise((r) => setTimeout(r, 200));
      return `scan-of-${serverUser()?.id}`;
    },
    async who(_s: { n: number }) {
      await Promise.resolve();
      const url = new URL(serverRequest()?.url ?? "http://none/");
      return `who-${url.searchParams.get("token")}`;
    },
  },
});

// A main-isolate ttl whose answer comes from the worker cell's read of the
// caller: that read happens in another isolate, where no scope of the ttl's
// reaches — so it must come home with the reply, or Bob gets Alice's answer.
export const viaW = cell("viaW", {
  state: { n: 0 },
  ttl: { greet: 60_000 },
  methods: {
    async greet(_s: { n: number }) {
      return `hi ${await (rerunW as unknown as {
        who: () => Promise<string>;
      }).who()}`;
    },
  },
});

if (isCellWorker()) {
  await aio.run({
    appId: "worker-first-rerun",
    cells: [rerunW],
    client: "server-only",
    persist: false,
    libraryMode: true,
  });
} else {
  const ENTRY = import.meta.url;
  const W = rerunW as unknown as { $pending: (m?: string) => number };
  const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /** Call `type` over a real WS as the user `token` resolves to. */
  async function callAs(
    port: number,
    token: string,
    type = "rerunW:scan",
  ): Promise<unknown> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
    const cid = `scan-${token}`;
    try {
      return await new Promise((resolve, reject) => {
        const bail = setTimeout(() => reject(new Error("no ack")), 10_000);
        ws.onerror = () => {
          clearTimeout(bail);
          reject(new Error("ws error"));
        };
        ws.onopen = () =>
          ws.send(
            enc("action", {
              type,
              payload: { args: [] },
              cid,
            }),
          );
        ws.onmessage = (e) => {
          const m = JSON.parse(String(e.data));
          if (m.t === "ack" && m.d?.cid === cid) {
            clearTimeout(bail);
            resolve(m.d.ok ? m.d.value : { err: m.d.error });
          }
        };
      });
    } finally {
      ws.close();
    }
  }

  async function observe(real: boolean) {
    await using srv = await testServer({
      cells: [rerunW],
      resolveUser: (tok: string) => ({ id: tok, role: "member" }),
      ...(real ? { workers: "real" as const, workerEntry: ENTRY } : {}),
    });
    const a = callAs(srv.port, "alice");
    await tick(60);
    const b = callAs(srv.port, "bob"); // adopts Alice's running scan
    await tick(80);
    const whileShared = W.$pending("scan");
    await tick(160); // Alice's run is over; Bob's rerun is mid-flight
    const whileRerun = W.$pending("scan");
    const results = [await a, await b];
    await tick(20);
    return { whileShared, whileRerun, results, after: W.$pending("scan") };
  }

  Deno.test('worker "first": an adopter of another caller\'s run reruns, counted in $pending', async () => {
    const worker = await observe(true);
    assertEquals(worker, {
      whileShared: 1,
      whileRerun: 1,
      results: ["scan-of-alice", "scan-of-bob"],
      after: 0,
    });
    assertEquals(await observe(false), worker, "in-isolate reads the same");
  });

  async function greetAs(real: boolean) {
    await using srv = await testServer({
      cells: [rerunW, viaW],
      resolveUser: (tok: string) => ({ id: tok, role: "member" }),
      ...(real ? { workers: "real" as const, workerEntry: ENTRY } : {}),
    });
    const alice = await callAs(srv.port, "alice", "viaW:greet");
    return [alice, await callAs(srv.port, "bob", "viaW:greet")];
  }

  Deno.test("a ttl answered by a worker cell's read of the caller is keyed per caller", async () => {
    const worker = await greetAs(true);
    assertEquals(worker, ["hi who-alice", "hi who-bob"]);
    assertEquals(await greetAs(false), worker, "in-isolate reads the same");
  });
}
