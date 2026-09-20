// A `wsLimits.maxMessageBytes` above the runtime's own ceiling is a limit
// nobody can keep.
//
// Deno's WebSocket server fails any message over 64 MiB itself ("Frame too
// large") and closes the socket before aio sees the frame. A configured limit
// above that was accepted, ADVERTISED to every client in the hello, and named
// as the way out of each refusal — and a frame between the two was never
// refused: the connection died, the caller was told "connection lost", and
// the server logged `Frame too large` with no limit and no way out. Measured:
// maxMessageBytes 200 MB, a 63 MiB frame applied, a 65 MiB one closed the
// socket.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { aio, cell } from "../mod.ts";
import { dec, enc } from "../src/protocol/envelope.ts";
import { protoHello } from "../src/protocol/protocol-version.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import {
  effectiveMaxMessage,
  isFrameTooLarge,
  WS_RUNTIME_MAX_MESSAGE,
} from "../src/server/server-ws.ts";

Deno.test("ws limits: a frame limit above the runtime ceiling is clamped, and says so", () => {
  assertEquals(effectiveMaxMessage(1_000_000), { limit: 1_000_000 });
  assertEquals(effectiveMaxMessage(WS_RUNTIME_MAX_MESSAGE), {
    limit: WS_RUNTIME_MAX_MESSAGE,
  });
  const over = effectiveMaxMessage(WS_RUNTIME_MAX_MESSAGE + 1);
  assertEquals(over.limit, WS_RUNTIME_MAX_MESSAGE);
  assertStringIncludes(over.warning ?? "", "64 MiB");
  assertStringIncludes(over.warning ?? "", "maxMessageBytes");
  // The runtime's refusal is recognised, and an ordinary disconnect is not.
  assert(isFrameTooLarge("Frame too large"));
  assert(!isFrameTooLarge("Unexpected EOF"));
});

Deno.test("ws limits: the hello advertises the limit the server can keep", async () => {
  const c = cell("wsceil", {
    state: { n: 0 },
    methods: {
      bump(s: { n: number }) {
        s.n++;
      },
    },
  });
  const port = freePort();
  const dir = await tempDir("aio-wsceil-");
  const app = await aio.run({
    cells: [c],
    appId: `wsceil-${Deno.pid}`,
    client: "server-only",
    persist: false,
    libraryMode: true,
    singleton: false,
    port,
    baseDir: dir,
    dbPath: ":memory:",
    wsLimits: { maxMessageBytes: 200_000_000, bytesPerSec: 400_000_000 },
    // deno-lint-ignore no-explicit-any
  } as any);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  try {
    const hello = await new Promise<Record<string, unknown>>((res, rej) => {
      const t = setTimeout(() => rej(new Error("no hello")), 5000);
      ws.onmessage = (e) => {
        const f = dec(String(e.data)) as { t?: string; d?: unknown } | null;
        if (f?.t === "proto") {
          clearTimeout(t);
          res(f.d as Record<string, unknown>);
        }
      };
      ws.onopen = () => ws.send(enc("proto", protoHello()));
    });
    assertEquals(
      hello.maxMessageBytes,
      WS_RUNTIME_MAX_MESSAGE,
      "a client must never be promised a frame size the runtime refuses",
    );
  } finally {
    ws.close();
    await new Promise((r) => setTimeout(r, 50));
    await app.close();
    await dropTempDir(dir);
  }
});
