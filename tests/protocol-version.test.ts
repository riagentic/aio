// A3 — WS wire-protocol version handshake.
// Unit: negotiateProtocol/parseProtoHello. Integration: server hello is the
// first frame, compatible clients proceed, incompatible clients are closed
// loudly with 4505, and legacy clients (no hello) still work.
import { assertEquals, assertExists } from "@std/assert";
import { join } from "@std/path";
import {
  negotiateProtocol,
  parseProtoHello,
  PROTOCOL_MISMATCH_CLOSE_CODE,
  PROTOCOL_VERSION,
  protoHello,
} from "../src/protocol/protocol-version.ts";
import { createServer } from "../src/server/server.ts";

const PORT = 8965;

// ── Unit: parse ──────────────────────────────────────────────────────

Deno.test("proto: parseProtoHello accepts valid hello", () => {
  assertEquals(parseProtoHello('{"v":2,"min":1}'), { v: 2, min: 1 });
});

Deno.test("proto: parseProtoHello rejects malformed payloads", () => {
  for (
    const bad of [
      "not json",
      "null",
      "{}",
      '{"v":0,"min":0}', // versions start at 1
      '{"v":1,"min":2}', // min > v is nonsense
      '{"v":1.5,"min":1}', // non-integer
      '{"v":"1","min":1}', // wrong type
    ]
  ) {
    assertEquals(parseProtoHello(bad), null, `should reject: ${bad}`);
  }
});

// ── Unit: negotiate ──────────────────────────────────────────────────

Deno.test("proto: same version negotiates to itself", () => {
  const r = negotiateProtocol({ v: 3, min: 2 }, { v: 3, min: 2 });
  assertEquals(r, { ok: true, effective: 3 });
});

Deno.test("proto: newer peer downgrades to our version", () => {
  const r = negotiateProtocol({ v: 2, min: 1 }, { v: 5, min: 2 });
  assertEquals(r, { ok: true, effective: 2 });
});

Deno.test("proto: peer below our minimum is rejected", () => {
  const r = negotiateProtocol({ v: 3, min: 3 }, { v: 2, min: 1 });
  assertEquals(r.ok, false);
});

Deno.test("proto: our version below peer minimum is rejected", () => {
  const r = negotiateProtocol({ v: 1, min: 1 }, { v: 5, min: 4 });
  assertEquals(r.ok, false);
});

Deno.test("proto: current build hello is self-compatible", () => {
  const r = negotiateProtocol(protoHello(), protoHello());
  assertEquals(r, { ok: true, effective: PROTOCOL_VERSION });
});

// ── Integration: WS handshake ────────────────────────────────────────

async function withServer(
  fn: (port: number) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  await Deno.mkdir(join(dir, "dist"), { recursive: true });
  await Deno.writeTextFile(
    join(dir, "dist", "app.js"),
    "export function mount(){}",
  );
  const server = createServer({
    port: PORT,
    title: "ProtoTest",
    getUIState: () => ({ ok: true }),
    dispatch: () => {},
    baseDir: dir,
    debug: () => {},
    prod: true,
    distDir: join(dir, "dist"),
  });
  await new Promise((r) => setTimeout(r, 50));
  try {
    await fn(PORT);
  } finally {
    await server.shutdown();
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("proto: server hello is the first WS frame", async () => {
  await withServer(async (port) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const frames: string[] = [];
    ws.addEventListener("message", (e) => frames.push(e.data as string));
    await new Promise<void>((r) => {
      const check = () => frames.length >= 2 ? r() : setTimeout(check, 10);
      check();
    });
    assertEquals(frames[0]!.startsWith("__proto:"), true);
    const hello = parseProtoHello(frames[0]!.slice(8));
    assertExists(hello);
    assertEquals(hello.v, PROTOCOL_VERSION);
    ws.close();
    await new Promise((r) => setTimeout(r, 20));
  });
});

Deno.test("proto: compatible client hello is accepted (connection stays open)", async () => {
  await withServer(async (port) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    let closed = false;
    ws.addEventListener("close", () => {
      closed = true;
    });
    await new Promise<void>((r) => {
      ws.onopen = () => r();
    });
    ws.send("__proto:" + JSON.stringify(protoHello()));
    await new Promise((r) => setTimeout(r, 100));
    assertEquals(closed, false);
    ws.close();
    await new Promise((r) => setTimeout(r, 20));
  });
});

Deno.test("proto: incompatible client is closed with 4505 and __proto-err", async () => {
  await withServer(async (port) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    let closeCode = 0;
    let protoErr = "";
    ws.addEventListener("message", (e) => {
      const d = e.data as string;
      if (d.startsWith("__proto-err:")) protoErr = d.slice(12);
    });
    const closedP = new Promise<void>((r) => {
      ws.addEventListener("close", (e) => {
        closeCode = e.code;
        r();
      });
    });
    await new Promise<void>((r) => {
      ws.onopen = () => r();
    });
    // A future client that requires a protocol this server can't speak.
    ws.send('__proto:{"v":99,"min":99}');
    await closedP;
    assertEquals(closeCode, PROTOCOL_MISMATCH_CLOSE_CODE);
    assertEquals(protoErr.length > 0, true);
  });
});

Deno.test("proto: legacy client (no hello) still receives state and dispatches", async () => {
  await withServer(async (port) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const stateFrames: string[] = [];
    ws.addEventListener("message", (e) => {
      const d = e.data as string;
      if (!d.startsWith("__")) stateFrames.push(d);
    });
    await new Promise<void>((r) => {
      const check = () => stateFrames.length >= 1 ? r() : setTimeout(check, 10);
      check();
    });
    assertEquals(JSON.parse(stateFrames[0]!).ok, true);
    ws.close();
    await new Promise((r) => setTimeout(r, 20));
  });
});
