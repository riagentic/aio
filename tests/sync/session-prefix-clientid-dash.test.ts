// The session-prefix binding (session-prefix-bound.test.ts) is
// bypassed by a client id that CONTAINS the victim's prefix. `clientId` is
// taken verbatim from the sync-req, the owner test is a bare `startsWith`
// (server-handler.ts `isRequestersOwnOp`), and `sessionPrefix` parses an op id
// greedily — so a writer announcing clientId "victim-<session>" binds its OWN
// prefix "victim-<session>-m-", its ops are never "foreign", and every one of
// them still `startsWith` the victim's "victim-<session>-". The victim's
// catch-up then leaves them out: applied on the server and every other screen,
// never on the victim's — the exact bug the binding exists to close.
import { assertEquals } from "@std/assert";
import { createNet, type NetClient, type State } from "./_net.ts";
import type { SyncOp } from "../../src/sync/types.ts";

const apply = (s: State, _a: string, p: unknown): State => ({
  items: [...((s.items as string[]) ?? []), p as string],
});

function frame(t: string, d: unknown): string {
  return JSON.stringify({ v: 2, t, d });
}

function reconnect(c: NetClient): void {
  c.socket = {
    readyState: 1,
    send: (m: string) => void c.inbox.push(m),
  } as unknown as WebSocket;
  c.online = true;
  c.engine.setOnline(true);
}

Deno.test("a client id that extends the victim's session prefix cannot hide ops from the victim's catch-up", async () => {
  const net = createNet({ cell: "c", initial: () => ({ items: [] }), apply });
  const victim = net.addClient("victim");
  const mallory = net.addClient("mallory");
  try {
    for (const c of [victim, mallory]) await c.engine.requestSync();
    await net.pump();
    await victim.engine.handleLocalAction("c", "add", "mine");
    await mallory.engine.handleLocalAction("c", "add", "theirs");
    await net.pump();
    await victim.engine.requestSync();
    await net.pump();
    const ops = victim.sentLog.map((m) => JSON.parse(m)).filter((f) =>
      f.t === "op"
    );
    const id = ops[0].d.id as string;
    const prefix = id.slice(0, id.lastIndexOf("-") + 1); // "victim-<session>-"

    victim.online = false;
    victim.engine.setOnline(false);
    // Mallory announces HER OWN session, with her own key — under a client id
    // that is the victim's prefix minus its trailing dash.
    const forged: Omit<SyncOp, "confirmed"> = {
      id: `${prefix}m-1.f0f0f0f0f0f0`,
      cell: "c",
      action: "add",
      payload: "forged",
      hlc: [Date.now(), 0, prefix.slice(0, -1)],
    };
    mallory.outbox.push(frame("sync-req", {
      clientId: prefix.slice(0, -1),
      session: "m",
      sessionKey: "mallorys-own-key",
      cells: { c: { lastHlc: null } },
      pendingOps: [forged],
    }));
    await net.pump();
    reconnect(victim);
    await net.pump();
    assertEquals(net.live(), { items: ["mine", "theirs", "forged"] });
    assertEquals(victim.confirmed(), net.live(), "victim in step with server");
  } finally {
    await net.close();
  }
});
