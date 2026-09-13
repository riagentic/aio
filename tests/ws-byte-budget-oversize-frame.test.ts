// A frame bigger than the WHOLE per-second byte budget can never be taken, so
// it must be refused at once and for good — never "retry after N ms".
//
// MEASURED before the fix (`wsLimits: { maxMessageBytes: 8_000_000,
// bytesPerSec: 1_000_000 }`, a `connectCli` client calling `put(1.5 MB)` and,
// 50 ms later, `inc()`): the server answered the put with `retryAfterMs`, the
// client held its WHOLE pacer and re-sent the put 8 times — `put REJECTED
// @8844ms`, and `inc ok @9950ms`, an unrelated call stalled ten seconds behind
// it, with 17 error lines on the server. The refused 1.5 MB was also counted
// into the window's byte total, so every small frame behind it in that window
// was refused as well. And the client's warning blamed the "message budget".
import { assert, assertEquals } from "@std/assert";
import { aio, cell } from "../mod.ts";
import { dec, enc } from "../src/protocol/envelope.ts";
import {
  parseProtoHello,
  protoHello,
} from "../src/protocol/protocol-version.ts";
import { connectCli } from "../src/server/cli-client.ts";
import { createWsManager } from "../src/server/server-ws.ts";
import type { CellDef } from "../src/state/cell-types.ts";
import { getLogger, setLogger } from "../src/diagnostics/logger-api.ts";
import type { LogSink } from "../src/diagnostics/logger-types.ts";
import { freePort } from "../src/testing/server-test.ts";
import { childCoverageDir, tempDir } from "../src/testing/temp-dir.ts";
import { stopChild } from "./stop-child.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const LIMITS = { maxMessageBytes: 8_000_000, bytesPerSec: 1_000_000 };

Deno.test("ws wire: a frame over the whole byte budget is refused without retryAfterMs, and does not use up the window", async () => {
  const c = cell("bytewire", {
    state: { n: 0 },
    methods: {
      put(s: { n: number }, _data: string) {
        s.n++;
      },
    },
  });
  const port = freePort();
  const dir = await tempDir("aio-bytewire-");
  const app = await aio.run({
    cells: [c],
    appId: `bytewire-${Deno.pid}`,
    client: "server-only",
    persist: false,
    libraryMode: true,
    singleton: false,
    port,
    baseDir: dir,
    dbPath: ":memory:",
    wsLimits: LIMITS,
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
  const put = (cid: string, bytes: number) =>
    ws.send(enc("action", {
      type: "bytewire:put",
      payload: { args: ["x".repeat(bytes)] },
      cid,
    }));
  const ack = async (cid: string) => {
    for (let i = 0; i < 150 && !acks.has(cid); i++) await sleep(20);
    const a = acks.get(cid);
    assert(a, `no ack for ${cid}`);
    return a;
  };
  try {
    await new Promise<void>((res, rej) => {
      ws.onopen = () => res();
      ws.onerror = () => rej(new Error("socket failed to open"));
    });
    ws.send(enc("proto", protoHello()));

    put("huge", 1_500_000);
    put("small", 100);
    const huge = await ack("huge");
    assertEquals(huge.ok, false);
    assertEquals(
      huge.retryAfterMs,
      undefined,
      `a re-send of a frame bigger than the whole budget can never pass: ${
        String(huge.error)
      }`,
    );
    assert(
      /byte/.test(String(huge.error)),
      `the refusal names the byte budget: ${huge.error}`,
    );
    const small = await ack("small");
    assertEquals(
      small.ok,
      true,
      `the refused frame was charged to the window, so a 100-byte frame ` +
        `behind it was refused too: ${String(small.error)}`,
    );

    // A frame that fits the budget but not what is LEFT of this window is
    // still a retry — the window reopens.
    await sleep(1_100);
    put("a", 450_000);
    put("b", 450_000);
    put("c", 450_000);
    put("d", 100);
    const third = await ack("c");
    assertEquals(third.ok, false);
    assert(
      typeof third.retryAfterMs === "number" && third.retryAfterMs > 0,
      `a frame that fits an empty window is told when: ${
        JSON.stringify(third)
      }`,
    );
    assertEquals((await ack("a")).ok, true);
    assertEquals((await ack("b")).ok, true);
    assertEquals(
      (await ack("d")).ok,
      true,
      "the refused third part is not charged, so 100 bytes still fit",
    );
  } finally {
    ws.close();
    await app.close();
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

function serverChild(port: number, dir: string): Deno.ChildProcess {
  const mod = new URL("../mod.ts", import.meta.url).href;
  const code = `
    import { aio, cell } from ${JSON.stringify(mod)};
    await aio.run({
      cells: [cell("bytecli", { state: { n: 0, size: 0 }, methods: {
        put(s, data) { s.size = data.length; },
        inc(s) { s.n++; },
      } })],
      appId: "bytecli-${Deno.pid}-${port}",
      wsLimits: ${JSON.stringify(LIMITS)},
      client: "server-only",
      persist: false,
      singleton: false,
      port: ${port},
      baseDir: ${JSON.stringify(dir)},
      dbPath: ":memory:",
    });`;
  return new Deno.Command(Deno.execPath(), {
    args: ["eval", "--ext=ts", code],
    cwd: new URL("..", import.meta.url).pathname,
    env: { DENO_COVERAGE_DIR: childCoverageDir() },
    stdin: "null",
    stdout: "null",
    stderr: "null",
  }).spawn();
}

Deno.test({
  name:
    "connectCli: an oversize call rejects at once and holds nothing behind it; a byte-window re-send says 'byte'",
  async fn() {
    const port = freePort();
    const base = `http://127.0.0.1:${port}`;
    const dir = await tempDir("aio-bytecli-");
    const proc = serverChild(port, dir);
    type S = { n: number; size: number };
    const def = cell("bytecli", {
      state: { n: 0, size: 0 },
      methods: {
        put(s: S, data: string) {
          s.size = data.length;
        },
        inc(s: S) {
          s.n++;
        },
      },
    });
    const warns: string[] = [];
    const prev = getLogger();
    setLogger({
      logDir: "",
      pub: (lvl: string, _cat: string, msg: string) => {
        if (lvl === "warn") warns.push(msg);
      },
      perf: () => {},
      flush: () => Promise.resolve(),
    } as unknown as LogSink);
    for (let i = 0; i < 300; i++) {
      const up = await fetch(`${base}/__aio/health`).then(
        (r) => r.body?.cancel().then(() => true),
        () => false,
      );
      if (up) break;
      await sleep(50);
    }
    const cli = connectCli<Record<string, S>>(base, { readyTimeoutMs: 30_000 });
    try {
      await cli.ready;
      cli.bind(def as unknown as CellDef);
      const m = def as unknown as {
        put(d: string): Promise<unknown>;
        inc(): Promise<unknown>;
      };
      const t0 = Date.now();
      const put = m.put("x".repeat(1_500_000)).then(
        () => ({ ok: true, at: Date.now() - t0, err: "" }),
        (e) => ({ ok: false, at: Date.now() - t0, err: String(e) }),
      );
      await sleep(50);
      const inc = m.inc().then(() => Date.now() - t0);
      const [p, incAt] = await Promise.all([put, inc]);
      assertEquals(p.ok, false, "a frame over the whole budget cannot apply");
      assert(
        p.at < 2_000,
        `rejected at ${p.at} ms — re-sent a frame that can never pass: ${p.err}`,
      );
      assert(
        incAt < 2_000,
        `an unrelated call waited ${incAt} ms behind the oversize one`,
      );
      assertEquals(
        warns.filter((w) => w.includes("re-send")),
        [],
        "nothing was re-sent",
      );

      // Three frames that each fit, not together: the third is a real retry,
      // and the note must not send the reader to `messagesPerSec`.
      await sleep(1_100);
      const parts = await Promise.allSettled(
        [0, 1, 2].map(() => m.put("y".repeat(450_000))),
      );
      assertEquals(
        parts.filter((r) => r.status === "rejected").length,
        0,
        "each part fits an empty window, so each lands after its re-send",
      );
      const note = warns.find((w) => w.includes("re-send"));
      assert(note, `the byte-window drop happened (else this proves nothing)`);
      assert(
        /byte/.test(note) && /bytesPerSec/.test(note),
        `a byte refusal is explained as one: ${note}`,
      );
    } finally {
      setLogger(prev);
      cli.close();
      await stopChild(proc, { label: "bytecli server", quiet: true });
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

// `messagesPerSec` accepts any integer ≥ 1, but a client's `parseProtoHello`
// discards a hello `rate` above 1,000,000 as hostile (tests/sync/
// op-send-pacing.test.ts pins that). A server configured at 2,000,000 used to
// advertise exactly that, so its clients read "no rate" and paced at the
// 100/sec fallback — 60 frames a second against a budget of two million. The
// server now advertises at most what a client accepts.
Deno.test("proto hello: a server budget above what a client accepts is advertised clamped, not discarded", async () => {
  const mgr = createWsManager({
    dispatch: () => {},
    getUIState: () => ({}),
    debug: () => {},
    prod: false,
    clientCounter: { value: 0 },
    bootId: "b",
    wsLimits: { messagesPerSec: 2_000_000 },
  });
  const port = freePort();
  const server = Deno.serve(
    { port, hostname: "127.0.0.1", onListen: () => {} },
    (req) => mgr.handleWs(req),
  );
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  try {
    const hello = await new Promise<unknown>((res, rej) => {
      ws.onmessage = (e) => {
        const f = dec(String(e.data));
        if (f?.t === "proto") res(f.d);
      };
      ws.onerror = () => rej(new Error("socket failed"));
      ws.onopen = () => ws.send(enc("proto", protoHello()));
    });
    assertEquals(
      parseProtoHello(hello)?.rate,
      1_000_000,
      `the client read no rate from ${JSON.stringify(hello)}, so it paces at ` +
        `the 100/sec fallback`,
    );
  } finally {
    ws.close();
    mgr.shutdown();
    await server.shutdown();
  }
});

Deno.test("ws limits: maxMessageBytes above bytesPerSec is said once, at startup", () => {
  const warns: string[] = [];
  const prev = getLogger();
  setLogger({
    logDir: "",
    pub: (lvl: string, _cat: string, msg: string) => {
      if (lvl === "warn") warns.push(msg);
    },
    perf: () => {},
    flush: () => Promise.resolve(),
  } as unknown as LogSink);
  const make = (wsLimits: Record<string, number>) =>
    createWsManager({
      dispatch: () => {},
      getUIState: () => ({}),
      debug: () => {},
      prod: false,
      clientCounter: { value: 0 },
      bootId: "b",
      wsLimits,
    });
  try {
    make(LIMITS).shutdown();
    assertEquals(
      warns.filter((w) => /maxMessageBytes .* bytesPerSec/.test(w)).length,
      1,
      `a frame between the two limits is refused every time: ${warns}`,
    );
    warns.length = 0;
    make({ maxMessageBytes: 1_000_000, bytesPerSec: 5_000_000 }).shutdown();
    make({}).shutdown();
    assertEquals(warns, [], "consistent limits (and the defaults) say nothing");
  } finally {
    setLogger(prev);
  }
});
