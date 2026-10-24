// A new connection's first state is the WHOLE view — a cell missing from it
// is one this connection may not see, and the client must stop showing it.
//
// `_applyFullState` keeps a cell's signal when the cell is absent from a full
// frame, and it has to for a later frame: a subscription-filtered state omits
// every cell the client is not subscribed to, and those are merely
// unsubscribed. But the FIRST frame of a connection is never filtered — the
// server's subscription set starts null on both transports and the frame goes
// out before any `subs` is read — so there an absent cell is one the server
// withheld: `visible.forUser` failed closed (docs/state/cell-visibility.md:
// "the cell is omitted from that client's state entirely… your UI sees the
// cell as absent"). The client kept the previous connection's slice instead.
//
// The shape: alice (admin) signs out, bob signs in in the same tab
// (`authClient` + the transport's SIGNED_IN resume — no reload), and the admin
// cell, omitted from bob's view because its filter throws for him, kept
// answering alice's data on bob's screen. Reproduced below with a real
// server's first frames fed to the client's own message handler.
import { assert, assertEquals } from "@std/assert";
import { aio, cell } from "../mod.ts";
import { dec } from "../src/protocol/envelope.ts";
import { handleMessage } from "../src/state/state-message.ts";
import { setTransport } from "../src/state-core.ts";
import { getCellSignal } from "../src/state/state-signals.ts";
import { _resetAioRuntime } from "../src/state/runtime-reset.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const ALICE = "tok-alice-0123456789abcdefghij";
const BOB = "tok-bob-0123456789abcdefghijkl";

/** What the browser transport does on every (re)connect: a new transport,
 *  so the next frame is treated as that connection's first state. */
function connect(): void {
  setTransport(
    { send: () => {}, close: () => {} } as unknown as Parameters<
      typeof setTransport
    >[0],
  );
}

Deno.test({
  name:
    "reconnect: a cell omitted from the new user's first state stops showing the old one's",
  sanitizeOps: false, // aio-ok: a live server + sockets, closed below
  sanitizeResources: false, // aio-ok: same
  fn: async () => {
    const vault = cell("rwVault", {
      state: { note: "" },
      visible: {
        // Bob has no record the filter can read — it throws, so the cell is
        // omitted for him (fail closed).
        forUser: (s, u) => {
          if (u?.role !== "admin") throw new TypeError("no admin record");
          return s;
        },
      },
      access: (u) => u?.role === "admin",
      methods: {
        write(s, v: string) {
          s.note = v;
        },
      },
    });
    const pub = cell("rwPub", {
      state: { n: 0 },
      visible: "all",
      methods: {},
    });
    const dir = await tempDir("aio-rw-omit");
    const port = freePort();
    const app = await aio.run({
      cells: [vault, pub],
      appId: `rw-omit-${crypto.randomUUID().slice(0, 8)}`,
      client: "server-only",
      persist: false,
      libraryMode: true,
      baseDir: dir,
      port,
      users: {
        [ALICE]: { id: "alice", role: "admin" },
        [BOB]: { id: "bob", role: "user" },
      },
    });
    await vault.write("alice-only-secret");
    const firstState = (tok: string) =>
      new Promise<Record<string, unknown>>((res, rej) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${tok}`);
        ws.onmessage = (e) => {
          const f = dec(String(e.data));
          if (f?.t !== "state") return;
          ws.close();
          res(f.d as Record<string, unknown>);
        };
        ws.onerror = () => rej(new Error("ws error"));
      });
    const aliceView = await firstState(ALICE);
    const bobView = await firstState(BOB);
    try {
      // The wire is right: the server omits the cell for bob.
      assertEquals(
        (aliceView.rwVault as { note: string }).note,
        "alice-only-secret",
      );
      assert(!("rwVault" in bobView), "the server sent bob the vault");

      _resetAioRuntime();
      // A client-scoped slice lives only here — never in a server frame.
      getCellSignal("rwLocal").set({ draft: "mine" });

      connect();
      handleMessage(aliceView);
      assertEquals(getCellSignal("rwVault").peek()?.note, "alice-only-secret");

      // alice signs out, bob signs in: a new connection.
      connect();
      handleMessage(bobView);
      assertEquals(
        getCellSignal("rwVault").peek(),
        undefined,
        "bob's screen still holds alice's admin cell",
      );
      assertEquals(getCellSignal("rwPub").peek(), { n: 0 });
      // Never delivered by a server frame, so never withdrawn by one.
      assertEquals(getCellSignal("rwLocal").peek(), { draft: "mine" });

      // A LATER full frame of the same connection may be subscription-
      // filtered: an absent cell there is unsubscribed, and is kept.
      connect();
      handleMessage(aliceView);
      handleMessage({ rwPub: { n: 0 } });
      assertEquals(getCellSignal("rwVault").peek()?.note, "alice-only-secret");
    } finally {
      _resetAioRuntime();
      await app.close();
      await dropTempDir(dir);
    }
  },
});
