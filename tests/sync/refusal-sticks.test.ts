// tests/sync/refusal-sticks.test.ts — a refusal the server DECIDED (a method
// that threw on the server's state, a `validate` hook) sticks to the op id.
//
// Found by the r3 sync hunt (2026-09-19). The clock-drift refusal was already
// sticky (seed 724); the dispatch refusal was forgotten with the op row it
// deleted. So the same op, still in flight — its `op` frame plus a `sync-req`
// that carries it as pending, or a duplicated frame — was dispatched again,
// and when the state had moved in between it was ACCEPTED: applied on the
// server and on every peer, while its author had been told "refused", rolled
// its view back, dropped the op, and kept a confirmed state without it for
// good. The author and the server never converged again.
import { assertEquals } from "@std/assert";
import { createNet, type NetClient, type State } from "./_net.ts";
import { REDUCER_FAILED } from "../../src/sync/rebase.ts";

/** `take` needs the item: the server refuses it when it is gone. */
const apply = (s: State, action: string, p: unknown): State => {
  const { id } = p as { id: string };
  const items = (s.items as string[]) ?? [];
  if (action === "add") return { ...s, items: [...items, id] };
  if (action === "take") {
    if (!items.includes(id)) throw new Error(`no ${id}`);
    return {
      ...s,
      items: items.filter((i) => i !== id),
      taken: [...((s.taken as string[]) ?? []), id],
    };
  }
  return s;
};

function world() {
  const rejected: string[] = [];
  const net = createNet({
    cell: "c",
    initial: () => ({ items: ["y"], taken: [] }),
    apply,
    reducer: (s, a, p) => {
      try {
        return apply(s, a, p);
      } catch {
        return REDUCER_FAILED;
      }
    },
    sync: { onRejected: (i) => void rejected.push(i.opId) },
  });
  return { net, rejected };
}

/** a and b both take "y"; b's lands first, so a's is refused. Returns a's
 *  op frame, which the test then re-delivers the way an in-flight copy lands. */
async function raceForY(
  net: ReturnType<typeof world>["net"],
  a: NetClient,
  b: NetClient,
) {
  await a.engine.requestSync();
  await b.engine.requestSync();
  await net.pump();
  await b.engine.handleLocalAction("c", "take", { id: "y" });
  await a.engine.handleLocalAction("c", "take", { id: "y" });
  const aFrame = a.outbox[0]!;
  for (const m of b.outbox.splice(0)) {
    await net.handler.handleOp(JSON.parse(m).d, { id: "b" }, b.socket);
  }
  await net.pump(); // a's op arrives now and is refused: y is gone
  // The state moves: "y" is back, so a's take WOULD apply now.
  await b.engine.handleLocalAction("c", "add", { id: "y" });
  await net.pump();
  return JSON.parse(aFrame).d;
}

function assertConverged(
  net: ReturnType<typeof world>["net"],
  rejected: string[],
  aOpId: string,
  a: NetClient,
  b: NetClient,
) {
  // Told at least once (the re-refusal of the late copy says it again).
  assertEquals([...new Set(rejected)], [aOpId], "a was told it was refused");
  assertEquals(
    net.live(),
    { items: ["y"], taken: ["y"] },
    "a refused op must never be applied afterwards — only b's take counts",
  );
  assertEquals(a.confirmed(), net.live(), "author converged with the server");
  assertEquals(a.view(), net.live());
  assertEquals(b.view(), net.live(), "peer converged with the server");
}

Deno.test("sync refusal sticks: a refused op frame delivered again stays refused", async () => {
  const { net, rejected } = world();
  try {
    const a = net.addClient("a");
    const b = net.addClient("b");
    const op = await raceForY(net, a, b);
    // The duplicate that was still on the wire lands.
    await net.handler.handleOp(op, { id: "a" }, a.socket);
    await net.pump();
    assertConverged(net, rejected, op.id, a, b);
  } finally {
    await net.close();
  }
});

Deno.test("sync refusal sticks: a refused op re-sent as a pending op stays refused", async () => {
  const { net, rejected } = world();
  try {
    const a = net.addClient("a");
    const b = net.addClient("b");
    const op = await raceForY(net, a, b);
    // A catch-up that was already on the wire, carrying the op as pending.
    net.handler.handleSync(
      {
        clientId: "a",
        cells: { c: { lastHlc: null } },
        pendingOps: [op],
      },
      { id: "a" },
      a.socket,
    );
    await net.pump();
    assertEquals([...new Set(rejected)], [op.id]);
    assertEquals(
      net.live(),
      { items: ["y"], taken: ["y"] },
      "the refused op must not be applied through the pending path",
    );
    assertEquals(b.view(), net.live());
  } finally {
    await net.close();
  }
});
