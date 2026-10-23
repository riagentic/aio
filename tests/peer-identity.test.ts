// Peer identity: a local aio app proves WHICH app it is to another with
// `peer()`; the other admits it only through `resolvePeer` (opt-in). Proofs are
// bound to the callee, die with the caller's boot, and a wrong one is refused,
// never downgraded to anonymous. Real apps, real sockets, real control keys.
import { assert, assertEquals, assertRejects } from "@std/assert";
import { cell } from "../src/state/cell-create.ts";
import { testApps } from "../src/testing/apps-test.ts";
import { peer } from "../src/server/peer.ts";
import { AppLock } from "../src/server/single-instance-lock.ts";
import { mintControlKey, removeControlKey } from "../src/server/app-key.ts";
import { PEER_HEADER, signPeer, verifyPeer } from "../src/server/peer-proof.ts";

let n = 0;
const vaultCell = () =>
  cell(`pvault${n++}`, {
    state: { opened: 0 },
    access: "app", // only callers whose role is "app"
    methods: {
      open(s: { opened: number }) {
        s.opened++;
        return "opened";
      },
    },
  });

/** This process acts as aio app `id`: a live lock + its control credential. */
async function asApp(id: string) {
  const lock = new AppLock(id);
  assertEquals((await lock.acquire(1)).ok, true);
  lock.update({ status: "started" });
  const k = mintControlKey(id);
  assert(k.error === undefined, k.error);
  return {
    [Symbol.dispose]() {
      removeControlKey(id);
      lock.release();
    },
  };
}

/** Register the testApps server under `id` so `peer(id)` finds it. */
async function listedAs(id: string, port: number) {
  const lock = new AppLock(id);
  assertEquals((await lock.acquire(port)).ok, true);
  lock.update({ status: "started" });
  return { [Symbol.dispose]: () => lock.release() };
}

async function appIdOf(url: string): Promise<string> {
  const r = await fetch(`${url}/__aio/health`);
  return ((await r.json()) as { appId: string }).appId;
}

Deno.test("resolvePeer admits a PROVEN local app; the same call with no proof is anonymous and denied", async () => {
  const v = vaultCell();
  const left: string[] = [];
  await using world = await testApps({
    svc: {
      cells: [v],
      resolvePeer: (p) => ({ id: p.app, role: "app" }),
      onDisconnect: (u) => void left.push(String(u?.id)),
    },
  });
  const svc = world.get("svc");
  const svcId = await appIdOf(svc.url);
  const caller = `pcaller${Deno.pid}a${n}`;
  using _me = await asApp(caller);
  using _listed = await listedAs(svcId, svc.port);

  {
    using p = (await peer(svcId))!;
    assertEquals(await p.call(v.__aio.id, "open"), "opened");
    const d = await p.describe();
    assert(v.__aio.id in d.cells, "a proven caller sees what it may call");
  }
  // onDisconnect knows WHICH app left — the hook a lease cleanup needs.
  const end = Date.now() + 5_000;
  while (!left.includes(caller) && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assertEquals(left.includes(caller), true, `onDisconnect saw ${left}`);

  // A URL target carries no proof: anonymous, and the gate says no.
  using anon = (await peer(svc.url))!;
  await assertRejects(() => anon.call(v.__aio.id, "open"), Error, "denied");
  assert(!(v.__aio.id in (await anon.describe()).cells));
});

Deno.test("without resolvePeer a proof changes nothing — the caller is anonymous, as before", async () => {
  const v = vaultCell();
  await using world = await testApps({ svc: { cells: [v] } });
  const svc = world.get("svc");
  const svcId = await appIdOf(svc.url);
  using _me = await asApp(`pcaller${Deno.pid}b${n}`);
  using _listed = await listedAs(svcId, svc.port);
  using p = (await peer(svcId))!;
  await assertRejects(() => p.call(v.__aio.id, "open"), Error, "denied");
});

Deno.test("a forged or misaddressed proof is refused at the handshake — never served as anonymous", async () => {
  const v = vaultCell();
  await using world = await testApps({
    svc: {
      cells: [v],
      resolvePeer: (p) => ({ id: p.app, role: "app" }),
    },
  });
  const svc = world.get("svc");
  const svcId = await appIdOf(svc.url);
  const caller = `pcaller${Deno.pid}c${n}`;
  using _me = await asApp(caller);
  const forged = `v1 ${caller} ${Deno.pid} ${"0".repeat(64)}`;
  const toOther = await signPeer(
    caller,
    undefined,
    "some-other-app",
    Deno.pid,
  );
  assert("header" in toOther);
  for (const h of [forged, toOther.header, "garbage"]) {
    const r = await fetch(`${svc.url}/ws`, {
      headers: { [PEER_HEADER]: h, upgrade: "websocket" },
    });
    await r.body?.cancel();
    assertEquals(r.status, 401, `header "${h.slice(0, 30)}…"`);
  }
});

Deno.test("verifyPeer: binds caller, pid, callee AND the callee's boot; dies with the caller's credential", async () => {
  const caller = `pcaller${Deno.pid}d${n}`;
  const me = await asApp(caller);
  try {
    const s = await signPeer(caller, undefined, "callee-x", 4242);
    assert("header" in s);
    assertEquals(await verifyPeer(s.header, "callee-x", 4242), {
      ok: true,
      peer: { app: caller, pid: Deno.pid },
    });
    assertEquals((await verifyPeer(s.header, "callee-y", 4242)).ok, false);
    // Replayed to the callee's NEXT boot (a squatter caught it meanwhile).
    assertEquals((await verifyPeer(s.header, "callee-x", 4243)).ok, false);
    const otherPid = s.header.replace(` ${Deno.pid} `, ` ${Deno.pid + 1} `);
    assertEquals((await verifyPeer(otherPid, "callee-x", 4242)).ok, false);
    removeControlKey(caller);
    assertEquals((await verifyPeer(s.header, "callee-x", 4242)).ok, false);
  } finally {
    me[Symbol.dispose]();
  }
  for (
    const bad of ["", "v2 a 1 " + "0".repeat(64), "v1 a/b 1 x", "v1 a -1 x"]
  ) {
    assertEquals((await verifyPeer(bad, "callee-x")).ok, false, bad);
  }
});

Deno.test("peer { as }: refused loudly where an identity cannot travel — a URL target, with a token, an unknown app", async () => {
  const v = vaultCell();
  await using world = await testApps({ svc: { cells: [v] } });
  const svc = world.get("svc");
  const svcId = await appIdOf(svc.url);
  const caller = `pcaller${Deno.pid}e${n}`;
  using _me = await asApp(caller);
  using _listed = await listedAs(svcId, svc.port);
  await assertRejects(() => peer(svc.url, { as: caller }), Error, "URL");
  await assertRejects(
    () => peer(svcId, { as: caller, token: "t" }),
    Error,
    "token OR an identity",
  );
  await assertRejects(
    () => peer(svcId, { as: "nobody-here" }),
    Error,
    "no app",
  );
});
