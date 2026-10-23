// peer(): one aio app calling another BY NAME — no cell definition, no source
// of the other app — through the other app's own door. Real apps
// (`testApps`), real sockets.
import { assert, assertEquals, assertRejects } from "@std/assert";
import { cell } from "../src/state/cell-create.ts";
import { testApps } from "../src/testing/apps-test.ts";
import { peer, type PeerDescription } from "../src/server/peer.ts";
import { AppLock } from "../src/server/single-instance-lock.ts";

let n = 0;
/** Factories: a definition binds to one app (D2), and names stay unique. */
const make = () => {
  const id = n++;
  const ledger = cell(`ledger${id}`, {
    state: { balance: 0 },
    methods: {
      credit(s: { balance: number }, by: number) {
        s.balance += by;
        return s.balance;
      },
      async slowDouble(_s: { balance: number }, x: number) {
        await new Promise((r) => setTimeout(r, 5));
        return x * 2;
      },
      boom(_s: { balance: number }) {
        throw new Error("ledger says no");
      },
    },
  });
  const vault = cell(`vault${id}`, {
    state: { v: 0 },
    access: false, // server-only: no network caller may call it
    methods: {
      open(s: { v: number }) {
        s.v = 1;
      },
    },
  });
  const ops = cell(`ops${id}`, {
    state: { n: 0 },
    // anonymous callers may call `status`, never `wipe`
    access: (_u, m) => m === "status",
    methods: {
      status(_s: { n: number }) {
        return "up";
      },
      wipe(s: { n: number }) {
        s.n = 0;
      },
    },
  });
  return { ledger, vault, ops, id };
};

Deno.test("peer: call by name — sync and async return values, errors carry the other app's reason", async () => {
  const c = make();
  await using world = await testApps({
    svc: { cells: [c.ledger, c.vault, c.ops] },
  });
  using p = (await peer(world.get("svc").url))!;
  assert(p);
  assertEquals(await p.call(`ledger${c.id}`, "credit", 5), 5);
  assertEquals(await p.call(`ledger${c.id}`, "credit", 2), 7);
  assertEquals(await p.call(`ledger${c.id}`, "slowDouble", 21), 42);
  await assertRejects(
    () => p.call(`ledger${c.id}`, "boom"),
    Error,
    "ledger says no",
  );
  await assertRejects(() => p.call(`ledger${c.id}`, "nope"));
  await assertRejects(() => p.call(`nocell${c.id}`, "x"));
  // state is live, as the other app lets this caller see it
  assertEquals(
    (p.state as Record<string, { balance: number }>)[`ledger${c.id}`]
      ?.balance,
    7,
  );
});

Deno.test("peer: access is the other app's — a denied call rejects, describe lists only what this caller may call", async () => {
  const c = make();
  await using world = await testApps({
    svc: { cells: [c.ledger, c.vault, c.ops] },
  });
  using p = (await peer(world.get("svc").url))!;
  await assertRejects(() => p.call(`vault${c.id}`, "open"), Error, "denied");
  await assertRejects(() => p.call(`ops${c.id}`, "wipe"), Error, "denied");
  assertEquals(await p.call(`ops${c.id}`, "status"), "up");

  const d: PeerDescription = await p.describe();
  assert(d.app.length > 0);
  assert(d.aio.length > 0);
  assertEquals(d.cells[`ledger${c.id}`]?.methods, {
    credit: { args: 1, async: false },
    slowDouble: { args: 1, async: true },
    boom: { args: 0, async: false },
  });
  assertEquals(Object.keys(d.cells[`ops${c.id}`]?.methods ?? {}), ["status"]);
  assert(!(`vault${c.id}` in d.cells), "a server-only cell must not be listed");
});

Deno.test("peer: cell<T>() is a typed handle over call(), and is not thenable", async () => {
  const c = make();
  await using world = await testApps({ svc: { cells: [c.ledger] } });
  using p = (await peer(world.get("svc").url))!;
  type Ledger = {
    credit(by: number): number;
    slowDouble(x: number): Promise<number>;
  };
  const ledger = p.cell<Ledger>(`ledger${c.id}`);
  const v: number = await ledger.credit(3);
  assertEquals(v, 3);
  assertEquals(await ledger.slowDouble(4), 8);
  assertEquals((ledger as Record<string, unknown>).then, undefined);
});

Deno.test("peer: no running instance of the appId → null; a dead URL throws, naming the target", async () => {
  assertEquals(await peer(`no-such-app-${crypto.randomUUID()}`), null);
  await assertRejects(
    () => peer("http://127.0.0.1:9", { readyTimeoutMs: 300 }),
    Error,
    'peer("http://127.0.0.1:9")',
  );
});

Deno.test("peer: offline defaults to fail — a call after the other app stopped rejects at once", async () => {
  const c = make();
  await using world = await testApps({ svc: { cells: [c.ledger] } });
  using p = (await peer(world.get("svc").url))!;
  assertEquals(await p.call(`ledger${c.id}`, "credit", 1), 1);
  await world.get("svc").close();
  const end = Date.now() + 5_000;
  while (p.connected && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 10));
  }
  const t0 = Date.now();
  await assertRejects(
    () => p.call(`ledger${c.id}`, "credit", 1),
    Error,
    "NOT sent",
  );
  assert(Date.now() - t0 < 1_000);
});

Deno.test("peer(appId): finds the started instance by its lock; a starting one is not there yet; two homes refuse to guess", async () => {
  const c = make();
  await using world = await testApps({ svc: { cells: [c.ledger] } });
  const appId = `peerlock${Deno.pid}x${c.id}`;
  const a = new AppLock(appId);
  const b = new AppLock(appId, `/tmp/aio-peer-other-home-${c.id}`);
  try {
    assertEquals((await a.acquire(world.get("svc").port)).ok, true);
    a.update({ status: "starting" });
    assertEquals(
      await peer(appId),
      null,
      "a starting instance is not callable yet",
    );
    a.update({ status: "started" });
    {
      using p = (await peer(appId))!;
      assertEquals(await p.call(`ledger${c.id}`, "credit", 4), 4);
    }
    assertEquals((await b.acquire(world.get("svc").port)).ok, true);
    b.update({ status: "started" });
    await assertRejects(() => peer(appId), Error, "2 instances are running");
  } finally {
    a.release();
    b.release();
  }
});

Deno.test("peer: an app that does not know describe() is named; other describe failures pass through as they are", async () => {
  const c = make();
  await using world = await testApps({ svc: { cells: [c.ledger] } });
  using p = (await peer(world.get("svc").url))!;
  // What an aio older than describe() answers: an unknown cell.
  const old = await p.call("$aioold", "describe").catch((e: Error) =>
    e.message
  );
  assert(
    /\$aioold/.test(String(old)),
    `the refusal must name the cell: ${old}`,
  );
  await world.get("svc").close();
  const end = Date.now() + 5_000;
  while (p.connected && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 10));
  }
  const e = await p.describe().catch((x: Error) => x);
  assert(e instanceof Error);
  assert(e.message.includes("NOT sent"), e.message);
  assert(!e.message.includes("older than"), e.message);
});

Deno.test("peer: cell() handles are inert to what the runtime reads — toJSON, toString, valueOf, then", async () => {
  const c = make();
  await using world = await testApps({ svc: { cells: [c.ledger] } });
  using p = (await peer(world.get("svc").url))!;
  const h = p.cell<{ credit(n: number): number }>(`ledger${c.id}`) as Record<
    string,
    unknown
  >;
  for (const k of ["then", "toJSON", "toString", "valueOf", "constructor"]) {
    assertEquals(h[k], undefined, k);
  }
  assertEquals(JSON.stringify(h), "{}");
  assertEquals(await (h.credit as (n: number) => Promise<number>)(2), 2);
});

Deno.test("peer(appId): a wildcard bind recorded in the lock is reached on loopback", async () => {
  const c = make();
  await using world = await testApps({ svc: { cells: [c.ledger] } });
  const appId = `peerhost${Deno.pid}x${c.id}`;
  const a = new AppLock(appId);
  try {
    assertEquals((await a.acquire(world.get("svc").port)).ok, true);
    a.update({ status: "started", host: "0.0.0.0" });
    using p = (await peer(appId))!;
    assertEquals(await p.call(`ledger${c.id}`, "credit", 9), 9);
  } finally {
    a.release();
  }
});

Deno.test("peer(appId): an app with a port AND a socket is called on the port — the one that carries a token", async () => {
  const c = make();
  await using world = await testApps({ svc: { cells: [c.ledger] } });
  const appId = `peerboth${Deno.pid}x${c.id}`;
  const a = new AppLock(appId);
  try {
    assertEquals((await a.acquire(world.get("svc").port)).ok, true);
    a.update({
      status: "started",
      socketPath: `/tmp/aio-peer-no-such-${c.id}.sock`,
    });
    using p = (await peer(appId, { token: "unused-by-an-open-app" }))!;
    assertEquals(await p.call(`ledger${c.id}`, "credit", 3), 3);
  } finally {
    a.release();
  }
});
