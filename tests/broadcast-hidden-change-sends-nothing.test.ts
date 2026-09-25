// A change to a `visible: "none"` cell is invisible to every client — so it
// must put nothing on the wire.
//
// The strategy filter reduces such a round to `[]` (every op skipped), and
// `[]` reached the broadcaster, whose "no patch payload" signal is a FORCE
// round: the whole visible state again, to every client, deduped only when the
// memo was fresh — and after any patch round it is not. Measured on a real
// server: a 20 KB visible cell beside a hidden ticker cost a 20 KB full state
// per tick.
import { assertEquals } from "@std/assert";
import { dec } from "../src/protocol/envelope.ts";
import { cell } from "../src/state/cell.ts";
import { testServer } from "../src/testing/server-test.ts";

const shown = cell("bhc-shown", {
  state: { pad: "x".repeat(20_000), v: 0 },
  methods: {
    bump(s) {
      s.v++;
    },
  },
});
const hidden = cell("bhc-hidden", {
  state: { t: 0 },
  visible: "none",
  methods: {
    tick(s) {
      s.t++;
    },
  },
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.test("broadcast: a change to a visible:none cell sends clients nothing", async () => {
  await using srv = await testServer({ cells: [shown, hidden] });
  const ws = new WebSocket(srv.url.replace(/^http/, "ws") + "/ws");
  const kinds: string[] = [];
  ws.onmessage = (e) => {
    const t = dec(String(e.data))?.t;
    if (t === "state" || t === "patches") kinds.push(t);
  };
  try {
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(new Error("ws failed to open"));
    });
    const deadline = Date.now() + 3000;
    while (kinds.length === 0 && Date.now() < deadline) await sleep(10);
    assertEquals(kinds, ["state"], "the connect frame");
    kinds.length = 0;
    for (let i = 0; i < 4; i++) {
      await shown.bump();
      await sleep(40);
      await hidden.tick();
      await sleep(40);
    }
    await sleep(100);
    assertEquals(
      (srv.state() as Record<string, { t: number }>)["bhc-hidden"]!.t,
      4,
      "the hidden cell did change, four times",
    );
    assertEquals(
      kinds,
      ["patches", "patches", "patches", "patches"],
      "one patch per visible change, nothing for the hidden ones",
    );
  } finally {
    ws.close();
  }
});
