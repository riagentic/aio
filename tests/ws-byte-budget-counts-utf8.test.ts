// The per-second byte budget (`wsLimits.bytesPerSec`) is in BYTES, but was
// charged `e.data.length` — UTF-16 units — so a stream of non-ASCII frames cost
// a third of its size and a connection could send ~3x its budget. The rolling
// budget is charged the frame's UTF-8 size, capped at the whole budget.
//
// The PERMANENT refusal ("over the whole budget, no re-send can pass") stays in
// UTF-16 units, like `maxMessageBytes`: 1.0.12 took a non-ASCII frame of up to
// `bytesPerSec` units, and judging it in UTF-8 refused such a frame forever in
// an app with `{ maxMessageBytes: N, bytesPerSec: N }`.
import { assert, assertEquals } from "@std/assert";
import { aio, cell } from "../mod.ts";
import { dec, enc } from "../src/protocol/envelope.ts";
import { protoHello } from "../src/protocol/protocol-version.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withApp(
  name: string,
  wsLimits: { maxMessageBytes: number; bytesPerSec: number },
  fn: (
    send: (cid: string, arg: string) => Promise<Record<string, unknown>>,
  ) => Promise<void>,
): Promise<void> {
  const c = cell(name, {
    state: { n: 0 },
    methods: {
      put(s: { n: number }, _data: string) {
        s.n++;
      },
    },
  });
  const port = freePort();
  const dir = await tempDir(`aio-${name}-`);
  const app = await aio.run({
    cells: [c],
    appId: `${name}-${Deno.pid}`,
    client: "server-only",
    persist: false,
    libraryMode: true,
    singleton: false,
    port,
    baseDir: dir,
    dbPath: ":memory:",
    wsLimits,
    // deno-lint-ignore no-explicit-any
  } as any);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const acks = new Map<string, Record<string, unknown>>();
  ws.onmessage = (e) => {
    const f = dec(String(e.data));
    if (f?.t !== "ack") return;
    const d = f.d as Record<string, unknown>;
    if (typeof d.cid === "string") acks.set(d.cid, d);
  };
  try {
    await new Promise<void>((res, rej) => {
      ws.onopen = () => res();
      ws.onerror = () => rej(new Error("socket failed to open"));
    });
    ws.send(enc("proto", protoHello()));
    // Let the hello's rate window close, so the next frame opens a fresh one.
    await sleep(1_200);
    await fn(async (cid, arg) => {
      ws.send(enc("action", {
        type: `${name}:put`,
        payload: { args: [arg] },
        cid,
      }));
      for (let i = 0; i < 150 && !acks.has(cid); i++) await sleep(20);
      const a = acks.get(cid);
      assert(a, `no ack for ${cid}`);
      return a;
    });
  } finally {
    ws.close();
    await app.close();
    await dropTempDir(dir);
  }
}

Deno.test("ws byte budget: a non-ASCII frame is charged its UTF-8 size", async () => {
  await withApp(
    "byteutf8",
    { maxMessageBytes: 8_000_000, bytesPerSec: 1_000_000 },
    async (send) => {
      // 500 000 × "漢" = 500 000 UTF-16 units, 1 500 000 UTF-8 bytes: admitted
      // on a fresh window, and it spends the WHOLE budget…
      const big = await send("cjk", "漢".repeat(500_000));
      assertEquals(big.ok, true, `the CJK frame: ${JSON.stringify(big)}`);
      // …so a small frame right behind it is over the budget. Charged in
      // UTF-16 units (500 000), it would have passed.
      const small = await send("small", "x".repeat(100));
      assertEquals(
        small.ok,
        false,
        "a 1.5 MB (UTF-8) frame left budget behind it — charged in UTF-16 units",
      );
      assert(
        /byte/.test(String(small.error)),
        `names the byte budget: ${small.error}`,
      );
    },
  );
});

Deno.test("ws byte budget: sustained oversized CJK frames never exceed bytesPerSec in UTF-8, and each is eventually taken", async () => {
  // 290 000 × "漢" is under N = 300 000 UTF-16 units (so never refused for
  // good) but ~870 KB of UTF-8 — ~2.9 budgets. Capping the charge at one
  // budget let one such frame through EVERY window (~2.9x the budget); the
  // excess is now debt, and the refusal's retryAfterMs says when it clears.
  const N = 300_000;
  const frame = "漢".repeat(290_000);
  const frameBytes = new TextEncoder().encode(frame).byteLength;
  await withApp(
    "bytedebt",
    { maxMessageBytes: 8_000_000, bytesPerSec: N },
    async (send) => {
      const t0 = Date.now();
      let accepted = 0;
      let refusals = 0;
      let retrying = false;
      for (let i = 0; Date.now() - t0 < 3_200; i++) {
        const a = await send(`f${i}`, frame);
        if (a.ok === true) {
          accepted++;
          retrying = false;
          continue;
        }
        assert(
          !retrying,
          `a re-send at the refusal's retryAfterMs was refused again: ${
            JSON.stringify(a)
          }`,
        );
        refusals++;
        retrying = true;
        const ms = a.retryAfterMs;
        assert(
          typeof ms === "number" && ms > 0,
          `a byte-rate refusal says when to retry: ${JSON.stringify(a)}`,
        );
        // Honour it exactly: the re-send must then be ACCEPTED.
        await sleep(ms);
      }
      const windows = Math.ceil((Date.now() - t0) / 1_000);
      assert(accepted >= 2, `frames are eventually taken (${accepted})`);
      assert(refusals >= 1, "the debt refused something");
      // Every admitted byte is charged and the charge drains N per window, so
      // admitted <= N × windows + the most the charge can hold: the room a
      // frame is admitted into (N − its units) plus the frame itself.
      assert(
        accepted * frameBytes <= N * windows + (N - 290_000) + frameBytes,
        `${accepted} × ${frameBytes} B in ${windows} windows exceeds ` +
          `${N} B/s (+1 frame)`,
      );
    },
  );
});

Deno.test("ws byte budget: a small unpaced frame just before an oversized one does not starve it", async () => {
  // 200 000 × "漢" = 200 000 units (fits the 300 000 budget, as in 1.0.12)
  // but 600 000 UTF-8 bytes. Admitted only at a charge of exactly zero, any
  // frame landing first in the window (a vitals ping, the sync engine)
  // refused it again, every retry, until the call failed.
  const N = 300_000;
  await withApp(
    "bytestarve",
    { maxMessageBytes: 8_000_000, bytesPerSec: N },
    async (send) => {
      const small = await send("ping", "x".repeat(100));
      assertEquals(small.ok, true);
      const big = await send("big", "漢".repeat(200_000));
      assertEquals(
        big.ok,
        true,
        `the oversized frame behind a small one: ${JSON.stringify(big)}`,
      );
    },
  );
});

Deno.test("ws byte budget: with maxMessageBytes = bytesPerSec = N, a non-ASCII frame of N/2 chars is accepted", async () => {
  const N = 300_000;
  await withApp(
    "bytenn",
    { maxMessageBytes: N, bytesPerSec: N },
    async (send) => {
      // 150 000 × "漢" = N/2 UTF-16 units (1.0.12 took it), 1.5 N UTF-8 bytes.
      const a = await send("half", "漢".repeat(N / 2));
      assertEquals(
        a.ok,
        true,
        `a frame 1.0.12 accepted is refused for good: ${JSON.stringify(a)}`,
      );
    },
  );
});
