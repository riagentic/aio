// A SHORT call — `{type:"x:setScalar", payload:{}}`, no payload, or a NAMED
// payload on a 1-argument method — over WS and UDS used to ack `{ok:true}` and
// commit `undefined`, while the trojan door refused the very same frame with
// 400 and, for `args:[]`, answered `short: "… declares 1 argument and this
// call passed 0 …"`. Three doors, two answers (h4 doors.ts).
//
// Compat forbids refusing on WS/UDS — working raw clients send that today. So
// the ack now CARRIES the trojan's `short` sentence, computed once in
// `dispatchNetwork` (the one place every door passes), and this test pins
// that the three doors say the identical sentence.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { enc } from "../src/protocol/envelope.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { _resetInstanceVerify, trojanPost } from "../src/am/am-http.ts";
import { createUDSListener } from "../src/server/aio.ts";
import { _noteShortCall, shortCallSentence } from "../src/server/action-ack.ts";
import { join } from "@std/path";

type Ack = { cid: string; ok: boolean; value?: unknown; short?: string };

async function wsAck(port: number, d: Record<string, unknown>): Promise<Ack> {
  const ws = new WebSocket(`ws://localhost:${port}/ws`);
  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error("ws never opened"));
  });
  const ack = new Promise<Ack>((res) => {
    ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data));
      if (m.t === "ack") res(m.d as Ack);
    };
  });
  ws.send(enc("action", d));
  const got = await ack;
  ws.close();
  await new Promise((r) => setTimeout(r, 20));
  return got;
}

async function udsAck(
  socketPath: string,
  d: Record<string, unknown>,
): Promise<Ack> {
  const conn = await Deno.connect({ path: socketPath, transport: "unix" });
  const w = conn.writable.getWriter();
  await w.write(new TextEncoder().encode(enc("action", d) + "\n"));
  const r = conn.readable.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let ack: Ack | undefined;
  const deadline = Date.now() + 3000;
  while (!ack && Date.now() < deadline) {
    const { value, done } = await r.read();
    if (done) break;
    buf += dec.decode(value);
    for (const line of buf.split("\n")) {
      if (!line.trim()) continue;
      try {
        const m = JSON.parse(line);
        if (m.t === "ack") ack = m.d as Ack;
      } catch { /* partial line */ }
    }
  }
  r.releaseLock();
  w.releaseLock();
  conn.close();
  assert(ack, `no UDS ack within 3s (got: ${buf.slice(0, 200)})`);
  return ack;
}

Deno.test("short call: WS, UDS and the trojan carry the SAME `short` sentence", async () => {
  const { aio, cell } = await import("../mod.ts");
  const { _resetAioRuntime } = await import("../src/state/runtime-reset.ts");
  _resetAioRuntime();
  _resetInstanceVerify();
  const c = cell("xshort", {
    state: { v: 1 as unknown, calls: 0 },
    methods: {
      setScalar(s: { v: unknown; calls: number }, v: unknown) {
        s.v = v;
        s.calls++;
      },
    },
  });
  const dir = await tempDir("short-ack-");
  const port = freePort();
  const appId = `short-ack-${Deno.pid}`;
  const app = await aio.run({
    cells: [c],
    appId,
    client: "server-only",
    persist: false,
    libraryMode: true,
    singleton: false,
    port,
    baseDir: dir,
    dbPath: ":memory:",
  } as never);
  const handle = app as unknown as { port: number; close: () => Promise<void> };
  try {
    const type = "xshort:setScalar";
    // WS: three short shapes — empty payload, no payload, named payload.
    const w1 = await wsAck(handle.port, { type, payload: {}, cid: "w1" });
    const w2 = await wsAck(handle.port, { type, cid: "w2" });
    const w3 = await wsAck(handle.port, {
      type,
      payload: { v: 5 },
      cid: "w3",
    });
    const w4 = await wsAck(handle.port, {
      type,
      payload: { args: [] },
      cid: "w4",
    });
    for (const a of [w1, w2, w3, w4]) {
      assertEquals(a.ok, true, "compat: WS still commits a short call");
      assert(
        typeof a.short === "string" && a.short.length > 0,
        `WS ack of a short call must carry \`short\` — got ${
          JSON.stringify(a)
        }`,
      );
    }
    assertStringIncludes(w1.short!, `${type} declares 1 argument`);
    assertStringIncludes(w1.short!, "passed 0");
    assertEquals(w2.short, w1.short);
    assertEquals(w3.short, w1.short);
    assertEquals(w4.short, w1.short);
    // A FULL call carries no `short`.
    const full = await wsAck(handle.port, {
      type,
      payload: { args: [7] },
      cid: "w5",
    });
    assertEquals(full.ok, true);
    assertEquals(full.short, undefined, "a full call is not short");

    // UDS: the door reads the SAME note dispatchNetwork stamps (a UDS
    // transport needs an Electron client to boot, so the door is driven with
    // the seam itself: `_noteShortCall` on the action, as dispatchNetwork does
    // above — proven on WS against the real app).
    const sock = join(dir, "short.sock");
    const uds = createUDSListener(
      sock,
      () => ({ ok: true }),
      (action) => {
        const a = action as { type: string; payload?: { args?: unknown } };
        const argv = a.payload?.args;
        _noteShortCall(
          action,
          shortCallSentence(a.type, 1, Array.isArray(argv) ? argv.length : 0),
        );
        return Promise.resolve(undefined);
      },
      () => {},
    );
    await new Promise((r) => setTimeout(r, 30));
    try {
      const u = await udsAck(sock, { type, payload: {}, cid: "u1" });
      assertEquals(u.ok, true);
      assertEquals(u.short, w1.short, "UDS and WS must agree");
    } finally {
      uds.shutdown();
    }

    // Trojan: `args:[]` is the one short shape it does not refuse.
    const t = await trojanPost(
      handle.port,
      "dispatch",
      { type, payload: { args: [] } },
      appId,
    );
    assert(t.ok, `trojan: ${JSON.stringify(t)}`);
    assertEquals(
      (t.data as { short?: string }).short,
      w1.short,
      "the trojan and WS must agree",
    );
  } finally {
    await handle.close();
    await dropTempDir(dir);
  }
});
