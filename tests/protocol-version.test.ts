// A3 — wire-protocol version handshake (v2 envelopes since B4b).
// Unit: negotiateProtocol/parseProtoHello. Integration: server hello is the
// first frame, compatible clients proceed, incompatible clients are closed
// loudly with 4505 (the refusal reason stays v1-readable — the one shim),
// and hello-less receive-only clients still get state.
import { assertEquals, assertExists, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { dec, enc } from "../src/protocol/envelope.ts";
import {
  negotiateProtocol,
  parseProtoHello,
  PROTOCOL_CHANGES,
  PROTOCOL_MISMATCH_CLOSE_CODE,
  PROTOCOL_VERSION,
  protoHello,
} from "../src/protocol/protocol-version.ts";
import { createServer } from "../src/server/server.ts";
import { freePort } from "../src/testing/server-test.ts";

const PORT = freePort();

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

Deno.test("proto: a refusal names WHAT the older build cannot do (v3: append)", () => {
  // A stale bundle is told why it is stale, not just that it is. A v2 client
  // would hand `append` to Immer and resync on every streamed frame — the
  // reason has to name the op so the operator knows which artifact to rebuild
  // and what breaks if they do not.
  const r = negotiateProtocol(protoHello("1.0.0-alpha70"), { v: 2, min: 2 });
  assertEquals(r.ok, false);
  if (r.ok) return;
  assertStringIncludes(r.reason, "the PEER is the older build");
  assertStringIncludes(r.reason, 'v3 added the "append" patch op');
  // The other direction names it too.
  const r2 = negotiateProtocol({ v: 2, min: 2 }, protoHello());
  assertEquals(r2.ok, false);
  if (r2.ok) return;
  assertStringIncludes(r2.reason, 'v3 added the "append" patch op');
  // Every version this build speaks has a row — a bump without a reason is
  // a refusal that cannot explain itself.
  for (let v = 3; v <= PROTOCOL_VERSION; v++) {
    assertExists(PROTOCOL_CHANGES[v], `PROTOCOL_CHANGES has no row for v${v}`);
  }
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
    const f = dec(frames[0]!);
    assertEquals(f?.t, "proto");
    const hello = parseProtoHello(f!.d);
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
    ws.send(enc("proto", protoHello()));
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
    ws.send('{"v":2,"t":"proto","d":{"v":99,"min":99}}');
    await closedP;
    assertEquals(closeCode, PROTOCOL_MISMATCH_CLOSE_CODE);
    // Not "some string arrived" — the reason has to be the one a human can
    // act on, naming WHICH side is old. A non-empty constant passed before.
    assertStringIncludes(protoErr, "the peer requires ≥ v99");
    assertStringIncludes(protoErr, "older build");
  });
});

Deno.test("proto: hello-less client still receives state (server speaks first)", async () => {
  await withServer(async (port) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const stateFrames: unknown[] = [];
    ws.addEventListener("message", (e) => {
      const f = dec(e.data as string);
      if (f?.t === "state") stateFrames.push(f.d);
    });
    await new Promise<void>((r) => {
      const check = () => stateFrames.length >= 1 ? r() : setTimeout(check, 10);
      check();
    });
    assertEquals((stateFrames[0] as { ok: boolean }).ok, true);
    ws.close();
    await new Promise((r) => setTimeout(r, 20));
  });
});

Deno.test("proto: v1 hello is refused with a v1-readable reason + 4505", async () => {
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
    ws.send('__proto:{"v":1,"min":1}'); // a v1 client's string-form hello
    await closedP;
    assertEquals(closeCode, PROTOCOL_MISMATCH_CLOSE_CODE);
    assertEquals(protoErr.includes("v2"), true);
  });
});
