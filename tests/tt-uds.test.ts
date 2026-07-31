// Time travel over UDS (Electron transport). The panel's Ctrl+. shortcut
// binds on the FIRST tt-state frame — and tt-state used to be broadcast to WS
// clients only, so an Electron window over UDS never received one: the
// shortcut was silently inert, and tt-cmd frames from the panel were rejected
// as "unsupported on UDS". Both directions now flow.
import { assert, assertEquals } from "@std/assert";
import { createUDSListener } from "../src/server/uds.ts";
import { dec, enc } from "../src/protocol/envelope.ts";
import { createBroadcaster } from "../src/server/server-broadcast.ts";

Deno.test({
  name: "UDS: tt-state greets on connect, tt-cmd routes to the handler",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const sock = `${await Deno.makeTempDir()}/tt.sock`;
    const commands: [string, number | undefined][] = [];
    const uds = createUDSListener(
      sock,
      () => ({}),
      () => {},
      () => {},
      undefined,
      null,
      undefined,
      {
        onCommand: (cmd, arg) => commands.push([cmd, arg]),
        getBroadcast: () => ({ entries: [{ id: 7, type: "seed" }], index: 0 }),
      },
    );
    const conn = await Deno.connect({ transport: "unix", path: sock });
    try {
      // Read greeting lines until tt-state arrives (proto, state, tt-state…).
      const buf = new Uint8Array(65536);
      let acc = "";
      const tt: { v: { entries: { id: number }[] } | null } = { v: null };
      for (let i = 0; i < 20 && !tt.v; i++) {
        const n = await conn.read(buf);
        if (n === null) break;
        acc += new TextDecoder().decode(buf.subarray(0, n));
        for (const line of acc.split("\n")) {
          const f = dec(line);
          if (f?.t === "tt-state") {
            tt.v = f.d as { entries: { id: number }[] };
          }
        }
      }
      assert(tt.v, "greeting carries tt-state — Ctrl+. binds immediately");
      assertEquals(tt.v.entries[0]!.id, 7);

      // C→S: a panel command routes to the server handler.
      await conn.write(
        new TextEncoder().encode(enc("tt-cmd", "goto:7") + "\n"),
      );
      for (let i = 0; i < 50 && commands.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 20));
      }
      assertEquals(commands, [["goto", 7]]);
    } finally {
      conn.close();
      uds.shutdown();
    }
  },
});

Deno.test("broadcaster: tt-state reaches UDS even with ZERO WS clients", async () => {
  const sent: string[] = [];
  const b = createBroadcaster({
    connections: new Map(),
    payloadStats: new Map(),
    getUIState: () => ({}),
    debug: () => {},
    syncIntervalMs: 10,
    getTTBroadcast: () => ({ entries: [], index: -1, paused: false }),
    udsBroadcastRef: { fn: (raw) => sent.push(raw) },
  });
  try {
    b.broadcastTT();
    for (let i = 0; i < 50 && sent.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert(
      sent.length > 0,
      "an electron-only app (0 WS clients) still gets TT",
    );
    const f = dec(sent[0]!);
    assertEquals(f?.t, "tt-state");
  } finally {
    b.shutdown();
  }
});
