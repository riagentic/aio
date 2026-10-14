// `wire: { refuseShortCalls: true }` — the trojan door's rule on every door.
//
// A frame that states NO argument list (`{type}`, `payload: {}`, a named
// payload) for a method that declares arguments is acked `ok: true` on the
// WebSocket and local-socket doors and commits `undefined`
// (tests/short-call-ack-parity.test.ts pins that default, with its `short`
// note). The trojan door has always refused the same frame. With the option
// on, `dispatchNetwork` — the one place every door passes — refuses it with
// ACTION_REFUSED before anything runs; an `args` array, however short, is
// still the caller stating their arguments.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { enc } from "../src/protocol/envelope.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { createUDSListener } from "../src/server/aio.ts";
import { noArgsRefusal } from "../src/server/action-ack.ts";
import { createAioError } from "../src/diagnostics/error.ts";
import {
  VALID_FEATURES_CONFIG_KEYS,
  validateConfig,
} from "../src/server/config.ts";
import { join } from "@std/path";
import { localEndpoint, localIdle } from "./local-endpoint-helper.ts";
import { connectLocal } from "../src/server/local-listen.ts";

type Ack = {
  cid: string;
  ok: boolean;
  short?: string;
  error?: string;
  code?: string;
};

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
  const conn = await connectLocal(socketPath);
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

Deno.test("wire.refuseShortCalls: a frame with no argument list is refused on WS and UDS, and nothing runs", async () => {
  const { aio, cell } = await import("../mod.ts");
  const { _resetAioRuntime } = await import("../src/state/runtime-reset.ts");
  _resetAioRuntime();
  const c = cell("xrefuse", {
    state: { v: 1 as unknown, calls: 0 },
    methods: {
      setScalar(s: { v: unknown; calls: number }, v: unknown) {
        s.v = v;
        s.calls++;
      },
      bump(s: { calls: number }) {
        s.calls++;
      },
    },
  });
  const dir = await tempDir("short-refuse-");
  const port = freePort();
  const app = await aio.run({
    cells: [c],
    appId: `short-refuse-${Deno.pid}`,
    client: "server-only",
    persist: false,
    libraryMode: true,
    singleton: false,
    port,
    baseDir: dir,
    dbPath: ":memory:",
    wire: { refuseShortCalls: true },
  });
  const handle = app as unknown as { port: number; close: () => Promise<void> };
  try {
    const type = "xrefuse:setScalar";
    const refused = [
      await wsAck(handle.port, { type, payload: {}, cid: "w1" }),
      await wsAck(handle.port, { type, cid: "w2" }),
      await wsAck(handle.port, { type, payload: { v: 5 }, cid: "w3" }),
    ];
    for (const a of refused) {
      assertEquals(a.ok, false, JSON.stringify(a));
      assertEquals(a.code, "ACTION_REFUSED");
      assertEquals(a.error, noArgsRefusal(type, 1));
    }
    assertStringIncludes(refused[0]!.error!, "passes none");
    assertEquals(c.calls, 0, "a refused call ran");
    assertEquals(c.v, 1);
    // An `args` array is the caller STATING their arguments: taken at its
    // word (and still noted), exactly as on the trojan door.
    const stated = await wsAck(handle.port, {
      type,
      payload: { args: [] },
      cid: "w4",
    });
    assertEquals(stated.ok, true);
    assert(stated.short, "the short note stays");
    const full = await wsAck(handle.port, {
      type,
      payload: { args: [7] },
      cid: "w5",
    });
    assertEquals([full.ok, full.short, c.v], [true, undefined, 7]);
    // A method that declares no arguments needs no list.
    const none = await wsAck(handle.port, { type: "xrefuse:bump", cid: "w6" });
    assertEquals(none.ok, true, JSON.stringify(none));
    assertEquals(c.calls, 3);

    // UDS: the door acks what `dispatchNetwork` answers (a UDS transport
    // needs an Electron client to boot, so the door is driven with the seam:
    // the rejection dispatchNetwork returns above — proven on WS).
    const sock = localEndpoint(join(dir, "refuse.sock"));
    const uds = createUDSListener(
      sock,
      () => ({ ok: true }),
      () =>
        Promise.reject(
          createAioError("ACTION_REFUSED", noArgsRefusal(type, 1), {
            cellName: "xrefuse",
            actionType: type,
          }),
        ),
      () => {},
    );
    await new Promise((r) => setTimeout(r, 30));
    try {
      const u = await udsAck(sock, { type, payload: {}, cid: "u1" });
      assertEquals(
        [u.ok, u.code, u.error],
        [false, "ACTION_REFUSED", refused[0]!.error],
        "UDS and WS must agree",
      );
    } finally {
      uds.shutdown();
      await localIdle();
    }
  } finally {
    await handle.close();
    await dropTempDir(dir);
  }
});

Deno.test("wire: a misspelled sub-key refuses the boot instead of leaving the door open", () => {
  const exits = (wire: Record<string, unknown>) => {
    let code = 0;
    try {
      validateConfig({ wire }, VALID_FEATURES_CONFIG_KEYS, "option", (c) => {
        code = c;
        throw new Error("exit");
      });
    } catch (e) {
      if ((e as Error).message !== "exit") throw e;
    }
    return code;
  };
  assertEquals(
    exits({ refuseShortCalls: true, omitTrailingUndefined: true }),
    0,
  );
  assertEquals(exits({ refuseShortCals: true }), 1);
});
