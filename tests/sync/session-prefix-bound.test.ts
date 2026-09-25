// tests/sync/session-prefix-bound.test.ts — a writer must not be able to
// submit ops under ANOTHER client's session prefix.
//
// An op id is `<clientId>-<session>-<counter>.<random>`, and the prefix is on
// every broadcast. Two filters trust it to mean "this client's own op": the
// client drops a broadcast carrying its own prefix as its own echo
// (`isOwnSessionOp`), and the server leaves ops with the requester's prefix
// out of its catch-up. So an op a malicious writer submitted under a victim's
// prefix was applied on the server and every other screen, and never on the
// victim's — silently, until a compaction snapshot happened to cover it.
//
// The server now binds each session prefix to the connection that announced
// it (its `sync-req`, with a per-session key only that engine holds); an op
// under it from any other connection is served in the owner's catch-up, and
// the engine drops as its echo only an id it actually issued. The forged op
// then lands on every screen alike — what its writer could do anyway.
import { assert, assertEquals } from "@std/assert";
import { createNet, type NetClient, type State } from "./_net.ts";
import type { SyncOp } from "../../src/sync/types.ts";

const apply = (s: State, _a: string, p: unknown): State => ({
  items: [...((s.items as string[]) ?? []), p as string],
});

async function victimAndMallory() {
  const net = createNet({ cell: "c", initial: () => ({ items: [] }), apply });
  const victim = net.addClient("victim");
  const mallory = net.addClient("mallory");
  for (const c of [victim, mallory]) await c.engine.requestSync();
  await net.pump();
  await victim.engine.handleLocalAction("c", "add", "mine");
  // A peer's op gives the victim a server cursor: a cursorless client is
  // served everything (it is rebuilding), a live one is not.
  await mallory.engine.handleLocalAction("c", "add", "theirs");
  await net.pump();
  await victim.engine.requestSync();
  await net.pump();
  // The prefix, read off the victim's op exactly as any peer reads it off the
  // broadcast.
  const ops = victim.sentLog.map((m) => JSON.parse(m)).filter((f) =>
    f.t === "op"
  );
  assertEquals(ops.length, 1);
  const id = ops[0].d.id as string;
  const prefix = id.slice(0, id.lastIndexOf("-") + 1);
  const forged: Omit<SyncOp, "confirmed"> = {
    id: `${prefix}zz.f0f0f0f0f0f0`,
    cell: "c",
    action: "add",
    payload: "forged",
    hlc: [Date.now(), 0, "victim"],
  };
  return { net, victim, mallory, forged };
}

function frame(t: string, d: unknown): string {
  return JSON.stringify({ v: 2, t, d });
}

/** Give a client a fresh connection, as a browser reconnect does — the old
 *  socket object stays as it was (a half-open one is still OPEN to the
 *  server until its heartbeat notices). */
function reconnect(c: NetClient): void {
  c.socket = {
    readyState: 1,
    send: (m: string) => void c.inbox.push(m),
  } as unknown as WebSocket;
  c.online = true;
  c.engine.setOnline(true);
}

Deno.test("an op frame under a connected client's session prefix reaches that client's screen", async () => {
  const { net, victim, mallory, forged } = await victimAndMallory();
  try {
    mallory.outbox.push(frame("op", forged));
    await net.pump();
    assertEquals(net.live(), { items: ["mine", "theirs", "forged"] });
    assertEquals(victim.confirmed(), net.live(), "victim in step with server");
    assertEquals(victim.view(), net.live());
  } finally {
    await net.close();
  }
});

Deno.test("an op under a disconnected client's session prefix reaches that client's catch-up", async () => {
  const { net, victim, mallory, forged } = await victimAndMallory();
  try {
    victim.online = false;
    victim.engine.setOnline(false);
    // The door a twin tab flushing the shared queue uses — announcing the
    // victim's own session (it is public), with a key it cannot know.
    const session = forged.id.slice("victim-".length).split("-")[0];
    mallory.outbox.push(frame("sync-req", {
      clientId: "victim",
      session,
      sessionKey: "guessed",
      cells: { c: { lastHlc: null } },
      pendingOps: [forged],
    }));
    await net.pump();
    assert(
      net.serverLog.some((l) => l.includes(`"victim-${session}-"`)),
      `the second claim is logged: ${net.serverLog.join(" | ")}`,
    );
    reconnect(victim);
    await net.pump();
    assertEquals(net.live(), { items: ["mine", "theirs", "forged"] });
    assertEquals(victim.confirmed(), net.live(), "victim in step with server");
  } finally {
    await net.close();
  }
});

Deno.test("an op frame under a disconnected client's session prefix reaches that client's catch-up", async () => {
  const { net, victim, mallory, forged } = await victimAndMallory();
  try {
    victim.online = false;
    victim.engine.setOnline(false);
    mallory.outbox.push(frame("op", forged));
    await net.pump();
    reconnect(victim);
    await net.pump();
    assertEquals(net.live(), { items: ["mine", "theirs", "forged"] });
    assertEquals(victim.confirmed(), net.live(), "victim in step with server");
  } finally {
    await net.close();
  }
});

Deno.test("a client reconnecting over a new connection keeps writing under its own session", async () => {
  const { net, victim } = await victimAndMallory();
  try {
    // Offline edit, then a new socket while the old one still reads OPEN.
    victim.online = false;
    victim.engine.setOnline(false);
    await victim.engine.handleLocalAction("c", "add", "offline");
    reconnect(victim);
    await net.pump();
    await victim.engine.handleLocalAction("c", "add", "after");
    await net.pump();
    assertEquals(net.live(), { items: ["mine", "theirs", "offline", "after"] });
    assertEquals(victim.confirmed(), net.live());
    assert(
      !net.serverLog.some((l) => l.includes("session")),
      `nothing refused: ${net.serverLog.join(" | ")}`,
    );
  } finally {
    await net.close();
  }
});
