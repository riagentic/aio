// A call the server refuses AT THE DOOR while it shuts down never ran — its ack
// carries `retryAfterMs`, the client's cue to re-send it after the restart. A
// DISPATCH_DRAINING raised INSIDE a running method (its inner call refused by
// the drain) follows writes that already landed: its ack carries NO
// `retryAfterMs`, so no client re-sends it and applies them twice.
import { assert, assertEquals } from "@std/assert";
import { dec, enc } from "../src/protocol/envelope.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

Deno.test("shutdown: a door refusal says re-send (retryAfterMs), a refusal inside a running method does not", async () => {
  const { aio, cell } = await import("../mod.ts");
  const dir = await tempDir("aio-door-retry-");
  let release!: () => void;
  const gate = new Promise<void>((r) => release = r);
  const other = cell("drOther", {
    state: { n: 0 },
    methods: {
      inc(s: Any) {
        s.n++;
      },
    },
  } as Any) as Any;
  const main = cell("drMain", {
    state: { n: 0 },
    methods: {
      async slow(s: Any) {
        await gate;
        s.n++;
        await other.inc();
      },
      inc(s: Any) {
        s.n++;
      },
    },
  } as Any) as Any;
  const port = freePort();
  const app = await aio.run({
    watch: false,
    cells: [main, other],
    appId: "door-retry",
    appDir: dir,
    client: "server-only",
    libraryMode: true,
    singleton: false,
    persist: false,
    port,
  } as Any);
  const acks = new Map<string, Record<string, unknown>>();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  let closing: Promise<unknown> | undefined;
  try {
    await new Promise((r, j) => {
      ws.onopen = r;
      ws.onerror = j;
    });
    ws.onmessage = (e) => {
      const f = dec(String(e.data));
      if (f?.t === "ack") {
        const d = f.d as Record<string, unknown>;
        acks.set(String(d.cid), d);
      }
    };
    const send = (type: string, cid: string) =>
      ws.send(enc("action", { type, payload: { args: [] }, cid }));
    const until = async (ok: () => boolean, what: string) => {
      const end = Date.now() + 10_000;
      while (!ok()) {
        assert(Date.now() < end, `timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 10));
      }
    };

    send("drMain:slow", "inside");
    await new Promise((r) => setTimeout(r, 100));
    closing = app.close();
    await new Promise((r) => setTimeout(r, 50));

    send("drMain:inc", "door");
    await until(() => acks.has("door"), "the door refusal");
    const door = acks.get("door")!;
    assertEquals(door.ok, false);
    assertEquals(door.code, "DISPATCH_DRAINING");
    assertEquals(typeof door.retryAfterMs, "number", JSON.stringify(door));

    release();
    await until(() => acks.has("inside"), "the in-method refusal");
    const inside = acks.get("inside")!;
    assertEquals(inside.ok, false, JSON.stringify(inside));
    assertEquals(
      inside.retryAfterMs,
      undefined,
      "a refusal raised inside a running method must not ask for a re-send",
    );
  } finally {
    release();
    try {
      ws.close();
    } catch { /* closed */ }
    await (closing ?? app.close());
    await dropTempDir(dir);
  }
});
