// tests/sync/server-write-push-bandwidth.test.ts — a server-side write to a
// sync cell costs what it changed, not the whole cell.
//
// The push that carries a server-origin write to live sync clients (see
// server-write-push.test.ts for why it exists) first shipped as the WHOLE
// cell, to every client, on every write: five writes of one number to a
// 2000-note cell with ten tabs open were 50 frames and 5.25 MB (105 KB a
// frame), where the plain state stream had sent a few hundred bytes. It now
// travels as a patch against the last push, with a digest the client checks
// before it installs the result.
import { assert, assertEquals } from "@std/assert";
import { createNet, type NetClient, type State } from "./_net.ts";

const CELL = "board";
const apply = (s: State, action: string, payload: unknown): State =>
  action === "add"
    ? { ...s, notes: [...(s.notes as string[]), payload as string] }
    : action === "price"
    ? { ...s, price: payload }
    : s;

const settle = () => new Promise((r) => setTimeout(r, 160));

/** Enough state that a one-field patch is well under half of it — below
 *  that the push is the whole cell by rule, whatever changed. */
const filler = () =>
  Array.from({ length: 100 }, (_, i) => `note-${i}-xxxxxxxxxx`);

/** Every push frame waiting in `clients`' inboxes, as sent. */
function pushFrames(clients: NetClient[]): string[] {
  return clients.flatMap((c) =>
    c.inbox.filter((m) => {
      const f = JSON.parse(m);
      return f.t === "sync-res" && f.d.push === true;
    })
  );
}

function assertConverged(
  net: ReturnType<typeof createNet>,
  clients: NetClient[],
): void {
  for (const c of clients) {
    assertEquals(c.confirmed(), net.live(), `${c.name} confirmed`);
    assertEquals(c.view(), net.live(), `${c.name} view`);
  }
}

Deno.test("a one-number server write to a 2000-note cell pushes the number, not the cell", async () => {
  const notes = Array.from(
    { length: 2000 },
    (_, i) => `note-${i}-${"x".repeat(40)}`,
  );
  const net = createNet({
    cell: CELL,
    initial: () => ({ notes, price: 0 }),
    apply,
  });
  try {
    const clients = Array.from(
      { length: 10 },
      (_, i) => net.addClient(`c${i}`),
    );
    for (const c of clients) await c.engine.requestSync();
    await net.pump();
    const wholeCell = JSON.stringify(net.live()).length;

    let bytes = 0;
    let frames = 0;
    for (let k = 1; k <= 5; k++) {
      net.serverWrite((s) => apply(s, "price", k));
      await settle();
      for (const m of pushFrames(clients)) {
        bytes += m.length;
        frames++;
      }
      await net.pump();
      assertConverged(net, clients);
    }

    assertEquals(frames, 50, "one push per write per client");
    // Measured 5,253,150 bytes when the push was the whole cell.
    assert(
      bytes < 50 * 1024,
      `5 one-number writes × 10 clients cost ${bytes} bytes (the cell is ` +
        `${wholeCell}) — a push must cost the change, not the cell`,
    );

    // And the pushed state is real confirmed state: the next own op of a tab
    // rebases onto it rather than wiping it.
    await clients[0]!.engine.handleLocalAction(CELL, "add", "from-tab");
    await net.pump();
    assertEquals(net.live().price, 5);
    assertConverged(net, clients);
  } finally {
    await net.close();
  }
});

Deno.test("a write that changes more than half the cell is pushed whole", async () => {
  const net = createNet({
    cell: CELL,
    initial: () => ({ notes: ["a", "b"], price: 0 }),
    apply,
  });
  try {
    const tab = net.addClient("tab");
    await tab.engine.requestSync();
    await net.pump();

    net.serverWrite((s) => ({
      ...s,
      notes: Array.from({ length: 50 }, (_, i) => `replaced-${i}`),
    }));
    await settle();
    const [frame] = pushFrames([tab]).map((m) => JSON.parse(m).d);
    assertEquals(frame?.mode, "snapshot", "the whole cell, as a snapshot");
    assertEquals(frame?.snapshot?.[CELL], net.live());
    await net.pump();
    assertConverged(net, [tab]);
  } finally {
    await net.close();
  }
});

Deno.test("a patch that does not reproduce the server's state is not installed — the client re-syncs", async () => {
  // The diff is taken against the last push. A tab op that set `price` to 5
  // and a server write that set it back to 0 leave NO change in that diff,
  // while the tab holds 5: applied blindly, the patch would keep the tab at
  // 5 for good. The digest catches it and the tab asks for the cell.
  const net = createNet({
    cell: CELL,
    initial: () => ({ notes: filler(), price: 0 }),
    apply,
  });
  try {
    const tab = net.addClient("tab");
    const peer = net.addClient("peer");
    await tab.engine.requestSync();
    await peer.engine.requestSync();
    await net.pump();

    await tab.engine.handleLocalAction(CELL, "price", 5);
    await net.pump();
    assertEquals(peer.confirmed().price, 5);

    net.serverWrite((s) => apply(s, "price", 0));
    await settle();
    const [frame] = pushFrames([tab]).map((m) => JSON.parse(m).d);
    assertEquals(frame?.mode, "push");
    assertEquals(frame?.patch?.[CELL]?.set, [], "the diff saw no change");
    for (let i = 0; i < 5; i++) {
      await net.pump();
      await new Promise((r) => setTimeout(r, 5));
    }
    assertEquals(net.live().price, 0);
    assertConverged(net, [tab, peer]);
    assert(
      tab.sentLog.some((m) => JSON.parse(m).d?.resync?.includes(CELL)),
      "the tab asked the server for the cell",
    );
  } finally {
    await net.close();
  }
});

Deno.test("an op folded on a state without the write converges too", async () => {
  // `total` is computed from `rate`. A server write changes `rate`; before it
  // is pushed, a peer's op computes `total` — on the server with the new
  // rate, on each client with the old one. The diff carries `rate` and
  // `total` as the server has them, which is exactly what the clients lack.
  const applyRated = (s: State, action: string, payload: unknown): State =>
    action === "bill"
      ? { ...s, total: (payload as number) * (s.rate as number) }
      : s;
  const net = createNet({
    cell: CELL,
    initial: () => ({ notes: filler(), rate: 1, total: 0 }),
    apply: applyRated,
  });
  try {
    const a = net.addClient("a");
    const b = net.addClient("b");
    await a.engine.requestSync();
    await b.engine.requestSync();
    await net.pump();

    net.serverWrite((s) => ({ ...s, rate: 3 }));
    await a.engine.handleLocalAction(CELL, "bill", 10);
    await net.pump();
    assertEquals([net.live().rate, net.live().total], [3, 30]);
    await settle();
    for (let i = 0; i < 5; i++) {
      await net.pump();
      await new Promise((r) => setTimeout(r, 5));
    }
    assertConverged(net, [a, b]);
  } finally {
    await net.close();
  }
});

Deno.test("an engine that predates patch pushes is sent the whole cell, and only it", async () => {
  const net = createNet({
    cell: CELL,
    initial: () => ({ notes: filler() }),
    apply,
  });
  try {
    const modern = net.addClient("modern");
    const old = net.addClient("old");
    // What a client built before the field sends: no `pushPatch`.
    const push = old.outbox.push.bind(old.outbox);
    old.outbox.push = (...frames: string[]) =>
      push(...frames.map((m) => {
        const f = JSON.parse(m);
        if (f.t === "sync-req") delete f.d.pushPatch;
        return JSON.stringify(f);
      }));
    await modern.engine.requestSync();
    await old.engine.requestSync();
    await net.pump();

    net.serverWrite((s) => apply(s, "price", 7));
    await settle();
    const modes = (c: NetClient) =>
      pushFrames([c]).map((m) => JSON.parse(m).d.mode).sort();
    assertEquals(modes(modern), ["push"]);
    // A patch frame reaches every socket; the old one also gets the cell,
    // the one push shape it can fold.
    assertEquals(modes(old), ["push", "snapshot"]);
    await net.pump();
    assertConverged(net, [modern, old]);
  } finally {
    await net.close();
  }
});
