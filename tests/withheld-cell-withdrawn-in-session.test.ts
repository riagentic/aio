// A cell the server WITHHOLDS from a later full frame of the SAME connection
// (its `visible.forUser` starts failing closed for this user) is withdrawn on
// the client — it used to keep its last copy until a reconnect, because an
// absent cell in a full frame can also be one the client stopped subscribing
// to. Full frames now say which cells they COVER (`s`: the subscription they
// were filtered by, `null` = the whole view); a covered cell that is absent
// was withheld. Real server frames, replayed into the real browser transport.
import { assert, assertEquals } from "@std/assert";
import { aio, cell } from "../mod.ts";
import { dec } from "../src/protocol/envelope.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { _teardownNow } from "../src/browser/protocol-subscription.ts";

const BOB = "tok-bob-0123456789abcdefghijkl";

class FakeWS {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSED = 3;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  static last: FakeWS | null = null;
  constructor(public url: string) {
    FakeWS.last = this;
  }
  send(_d: string) {}
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
}

Deno.test({
  name:
    "a cell withheld by a later full frame is withdrawn, an unsubscribed one kept",
  sanitizeOps: false, // aio-ok: a live server + sockets, closed below
  sanitizeResources: false, // aio-ok: same
  fn: async () => {
    let refuse = false;
    const vault = cell("whVault", {
      state: { note: "kept" },
      visible: {
        forUser: (s) => {
          if (refuse) throw new TypeError("record gone");
          return s;
        },
      },
      methods: {
        write(s, v: string) {
          s.note = v;
        },
      },
    });
    const pub = cell("whPub", { state: { n: 0 }, methods: {} });
    const dir = await tempDir("aio-withheld-");
    const port = freePort();
    const app = await aio.run({
      cells: [vault, pub],
      appId: `wh-${crypto.randomUUID().slice(0, 8)}`,
      client: "server-only",
      persist: false,
      libraryMode: true,
      baseDir: dir,
      port,
      users: { [BOB]: { id: "bob", role: "user" } },
    });
    const g = globalThis as Record<string, unknown>;
    const prevWS = g.WebSocket;
    const frames: string[] = [];
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${BOB}`);
      ws.onmessage = (e) => void frames.push(String(e.data));
      const states = () => frames.filter((f) => dec(f)?.t === "state");
      const until = async (p: () => boolean) => {
        for (let i = 0; i < 300 && !p(); i++) {
          await new Promise((r) => setTimeout(r, 10));
        }
      };
      await until(() => states().length === 1);
      // Subscribe to both cells, then make the vault's filter fail closed.
      ws.send(
        JSON.stringify({ v: 2, t: "subs", d: { subs: ["whVault", "whPub"] } }),
      );
      await new Promise((r) => setTimeout(r, 200));
      refuse = true;
      await vault.write("changed");
      const lacks = () =>
        states().find((f) => !("whVault" in (dec(f)!.d as object)));
      await until(() => lacks() !== undefined);
      ws.close();
      const withheldRaw = lacks()!;
      const first = JSON.parse(states()[0]!) as {
        d: Record<string, unknown>;
        s?: unknown;
      };
      const withheld = JSON.parse(withheldRaw) as {
        d: Record<string, unknown>;
        s?: unknown;
      };
      assert("whVault" in first.d);
      assertEquals(
        first.s,
        null,
        "a connection's first frame is its whole view",
      );
      assert(!("whVault" in withheld.d), "the server sent the withheld cell");
      assertEquals(
        (withheld.s as string[]).toSorted(),
        ["whPub", "whVault"],
        "the frame names the cells it covers",
      );

      // The client: replay what the server sent, then the withheld frame.
      g.WebSocket = FakeWS;
      g.location ??= {
        protocol: "http:",
        host: "localhost:1234",
        search: "",
        origin: "http://localhost:1234",
      };
      await import("../src/browser/browser-air-transport.ts");
      const { ensureConnected } = await import(
        "../src/browser/browser-protocol.ts"
      );
      const { getCellSignal } = await import(
        "../src/state/state-signals.ts"
      );
      ensureConnected();
      FakeWS.last!.open();
      const feed = (raw: string) => FakeWS.last!.onmessage!({ data: raw });
      const upTo = frames.indexOf(withheldRaw);
      for (const raw of frames.slice(0, upTo)) feed(raw);
      assertEquals(getCellSignal("whVault").peek()?.note, "kept");

      // An absent cell the frame does NOT cover (unsubscribed) is kept.
      feed(
        JSON.stringify({
          v: 2,
          t: "state",
          d: { whPub: { n: 0 } },
          s: ["whPub"],
        }),
      );
      assertEquals(getCellSignal("whVault").peek()?.note, "kept");
      // …and one an older server's frame (no `s`) leaves alone, as before.
      feed(JSON.stringify({ v: 2, t: "state", d: { whPub: { n: 0 } } }));
      assertEquals(getCellSignal("whVault").peek()?.note, "kept");

      feed(withheldRaw);
      assertEquals(
        getCellSignal("whVault").peek(),
        undefined,
        "the client kept the withheld cell's last copy",
      );
      assertEquals(getCellSignal("whPub").peek(), { n: 0 });
      FakeWS.last!.onclose?.();
      _teardownNow();
    } finally {
      g.WebSocket = prevWS;
      await app.close();
      await dropTempDir(dir);
    }
  },
});
