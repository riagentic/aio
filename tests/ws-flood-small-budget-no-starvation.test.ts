// One abusive socket must never starve the well-behaved ones — at ANY
// configured `messagesPerSec`, not only the default.
//
// MEASURED before the fix (a raw socket firing ~4000 frames/sec beside a client
// sending 4 calls/sec): at `messagesPerSec: 10` the flooder was NEVER closed and
// the other client had 0 of 23 calls applied, every one refused "the server is
// over its total frame budget"; at 100 the flooder was closed and blocked and
// the other client got 23 of 23. The server-wide fuse (2x the per-client budget
// for two clients) ran BEFORE the per-client check and recorded no strike, so
// at a small budget it ate the flood first: the flooder collected ~10 strikes a
// window, its first in-budget frame of the next window reset them, the 50-in-a-
// row close never came — and the fuse, saturated by the flooder, refused the
// other client for as long as the flood lasted.
//
// A real server in a subprocess (its event loop is not the flooder's), the
// flooder a raw WebSocket that ignores every refusal, the victim the REAL
// `connectCli` — which paces to the hello's `rate` and so never exceeds its own
// budget. Nothing a paced client does may earn it a refusal because of a
// neighbour.
import { assert, assertEquals } from "@std/assert";
import { cell } from "../src/state/cell-create.ts";
import { connectCli } from "../src/server/cli-client.ts";
import type { CellDef } from "../src/state/cell-types.ts";
import { dec, enc } from "../src/protocol/envelope.ts";
import { protoHello } from "../src/protocol/protocol-version.ts";
import { getLogger, setLogger } from "../src/diagnostics/logger-api.ts";
import type { LogSink } from "../src/diagnostics/logger-types.ts";
import { freePort } from "../src/testing/server-test.ts";
import { childCoverageDir, tempDir } from "../src/testing/temp-dir.ts";
import { createWsManager } from "../src/server/server-ws.ts";
import {
  disposeClientLog,
  flushClientLog,
  initClientLog,
} from "../src/server/client-log.ts";
import { stopChild } from "./stop-child.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type N = { n: number };

function serverChild(
  port: number,
  dir: string,
  rate: number | undefined,
): Deno.ChildProcess {
  const mod = new URL("../mod.ts", import.meta.url).href;
  const cellSrc = (name: string) =>
    `cell(${
      JSON.stringify(name)
    }, { state: { n: 0 }, methods: { inc(s) { s.n++; } } })`;
  const code = `
    import { aio, cell } from ${JSON.stringify(mod)};
    await aio.run({
      cells: [${cellSrc("victim")}, ${cellSrc("flood")}],
      appId: "wsstarve-${Deno.pid}-${port}",${
    rate === undefined ? "" : `\n      wsLimits: { messagesPerSec: ${rate} },`
  }
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
    stdout: "piped",
    stderr: "piped",
  }).spawn();
}

/** Everything the child writes, collected until it exits — the server's own
 *  account of what it closed and why. */
function drain(
  proc: Deno.ChildProcess,
): { text: () => string; done: Promise<void> } {
  let out = "";
  const read = async (s: ReadableStream<Uint8Array>) => {
    const td = new TextDecoder();
    for await (const chunk of s) out += td.decode(chunk, { stream: true });
  };
  return {
    text: () => out,
    done: Promise.all([read(proc.stdout), read(proc.stderr)]).then(() => {}),
  };
}

async function waitUp(base: string): Promise<void> {
  for (let i = 0; i < 300; i++) {
    const up = await fetch(`${base}/__aio/health`).then(
      (r) => r.body?.cancel().then(() => true),
      () => false,
    );
    if (up) return;
    await sleep(50);
  }
  throw new Error("server did not come up");
}

async function connectedClients(base: string): Promise<number> {
  const body = await (await fetch(`${base}/__aio/vitals`)).json() as {
    clients?: unknown[];
  };
  return body.clients?.length ?? 0;
}

const victimCell = cell("victim", {
  state: { n: 0 },
  methods: {
    inc(s: N) {
      s.n++;
    },
  },
});

for (const rate of [10, undefined]) {
  const label = rate === undefined ? "the default budget" : `${rate} msg/sec`;
  Deno.test({
    name:
      `ws flood at ${label}: the flooder is closed and blocked, a paced client beside it is never refused`,
    async fn() {
      const port = freePort();
      const base = `http://127.0.0.1:${port}`;
      const dir = await tempDir("aio-wsstarve-");
      const proc = serverChild(port, dir, rate);
      const output = drain(proc);
      // Every re-send the victim is asked for is a refusal it did nothing to
      // earn — the count must stay zero, not merely recover by retrying.
      const refusals: string[] = [];
      const prev = getLogger();
      setLogger({
        logDir: "",
        pub: (lvl: string, _cat: string, msg: string) => {
          if (lvl === "warn" && msg.includes("asked for a re-send")) {
            refusals.push(msg);
          }
        },
        perf: () => {},
        flush: () => Promise.resolve(),
      } as unknown as LogSink);
      let flooder: WebSocket | undefined;
      let floodTimer: ReturnType<typeof setInterval> | undefined;
      let guard: ReturnType<typeof setTimeout> | undefined;
      await waitUp(base);
      // Connected BEFORE the flood: the block is keyed by address, and both
      // sockets come from 127.0.0.1.
      const cli = connectCli<Record<string, N>>(base, {
        readyTimeoutMs: 30_000,
      });
      try {
        await cli.ready;
        cli.bind(victimCell as unknown as CellDef);
        for (let i = 0; i < 100 && !(await connectedClients(base)); i++) {
          await sleep(30);
        }

        // ── the flooder: 20 frames every 5 ms, deaf to every refusal ──
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
        flooder = ws;
        const closed = new Promise<void>((res) => {
          ws.onclose = () => res();
        });
        let floodAcks = 0;
        ws.onmessage = (e) => {
          if (dec(String(e.data))?.t === "ack") floodAcks++;
        };
        await new Promise<void>((res, rej) => {
          ws.onopen = () => res();
          ws.onerror = () => rej(new Error("flooder failed to open"));
        });
        ws.send(enc("proto", protoHello()));
        let fi = 0;
        floodTimer = setInterval(() => {
          for (let k = 0; k < 20 && ws.readyState === WebSocket.OPEN; k++) {
            ws.send(
              enc("action", {
                type: "flood:inc",
                payload: {},
                cid: `f${fi++}`,
              }),
            );
          }
        }, 5);

        // ── the victim: calls made while the flood is running ──
        const CALLS = 8;
        const c = victimCell as unknown as { inc(): Promise<unknown> };
        const calls = Promise.allSettled(
          Array.from({ length: CALLS }, () => c.inc()),
        );

        const floodClosed = await Promise.race([
          closed.then(() => true),
          new Promise<false>((r) => {
            guard = setTimeout(() => r(false), 10_000);
          }),
        ]).finally(() => clearTimeout(guard));
        clearInterval(floodTimer);
        floodTimer = undefined;
        assert(
          floodClosed,
          `a flood of ${fi} frames was never closed (${floodAcks} refusals ` +
            `answered) — the per-connection strikes never reached the close`,
        );
        // By the SERVER's account, not the close code this side sees: the
        // peer is still mid-write when the 1008 goes out, so the close arrives
        // here unclean and without it.
        for (let k = 0; k < 100 && !/flagged —/.test(output.text()); k++) {
          await sleep(20);
        }
        assert(
          /flagged — \d+ consecutive drops .*; closed and \S+ blocked for/.test(
            output.text(),
          ),
          `the server closed the flooder for its strikes and blocked it:\n${
            output.text().slice(-1500)
          }`,
        );

        const r = await fetch(`${base}/ws`, {
          headers: { upgrade: "websocket", connection: "upgrade" },
        });
        const body = await r.text();
        assertEquals(
          r.status,
          429,
          `the flooder's address is blocked: ${body}`,
        );

        const settled = await calls;
        const rejected = settled.filter((s) => s.status === "rejected");
        assertEquals(
          rejected.length,
          0,
          `${rejected.length} of ${CALLS} victim calls rejected — first: ${
            String((rejected[0] as PromiseRejectedResult | undefined)?.reason)
          }`,
        );
        for (let k = 0; k < 100 && cli.state?.victim?.n !== CALLS; k++) {
          await sleep(30);
        }
        assertEquals(cli.state?.victim?.n, CALLS, "every call applied, once");
        assertEquals(
          refusals,
          [],
          "a paced client was refused because of its neighbour's flood",
        );
        assert(cli.connected, "the victim's socket is still up");
      } finally {
        if (floodTimer) clearInterval(floodTimer);
        clearTimeout(guard);
        try {
          flooder?.close();
        } catch { /* already closed */ }
        setLogger(prev);
        cli.close();
        await stopChild(proc, { label: "wsstarve server", quiet: true });
        await output.done.catch(() => {});
        await Deno.remove(dir, { recursive: true }).catch(() => {});
      }
    },
  });
}

// ── the server-wide fuse, driven frame by frame ──────────────────────────────
//
// Per-client windows do not line up with the fuse's window, so a socket that
// never exceeds its OWN budget can still put two windows' worth into one of the
// fuse's: at 10 msg/sec, 9 frames at the end of its window and 10 at the start
// of the next are 19 in the fuse's one second — and with two clients the fuse
// is 20, so without a share rule the straddler alone starves its neighbour.

type Peer = { ws: WebSocket; diags: string[]; acks: Map<string, unknown> };

async function peer(port: number): Promise<Peer> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const p: Peer = { ws, diags: [], acks: new Map() };
  ws.onmessage = (e) => {
    const f = dec(String(e.data));
    const d = f?.d as
      | { type?: string; cid?: string; retryAfterMs?: number }
      | undefined;
    if (f?.t === "diag" && typeof d?.type === "string") p.diags.push(d.type);
    if (f?.t === "ack" && typeof d?.cid === "string") p.acks.set(d.cid, d);
  };
  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error("peer failed to open"));
  });
  return p;
}

const frame = (cid: string) =>
  enc("action", { type: "x:inc", payload: {}, cid });
const burst = (p: Peer, tag: string, n: number) => {
  for (let i = 0; i < n; i++) p.ws.send(frame(`${tag}${i}`));
};

async function fuseHarness(rate: number) {
  // A tripped fuse writes the client log; point it at a temp dir, not the repo.
  const logDir = await tempDir("aio-wsfuse-log-");
  initClientLog(logDir);
  const mgr = createWsManager({
    dispatch: () => {},
    getUIState: () => ({ x: { n: 0 } }),
    debug: () => {},
    prod: false,
    clientCounter: { value: 0 },
    bootId: "b",
    wsLimits: { messagesPerSec: rate },
  });
  const port = freePort();
  const server = Deno.serve(
    { port, hostname: "127.0.0.1", onListen: () => {} },
    (req) => mgr.handleWs(req),
  );
  const close = async (peers: Peer[]) => {
    for (const p of peers) p.ws.close();
    mgr.shutdown();
    await server.shutdown();
    await flushClientLog();
    disposeClientLog();
    await Deno.remove(logDir, { recursive: true }).catch(() => {});
  };
  return { mgr, port, close };
}

Deno.test("ws fuse: a client inside its own budget is not refused because a neighbour straddles two windows into the fuse", async () => {
  const { mgr, port, close } = await fuseHarness(10);
  const peers: Peer[] = [];
  try {
    const a = await peer(port);
    const b = await peer(port);
    peers.push(a, b);
    for (let i = 0; i < 100 && mgr.connections.size < 2; i++) await sleep(10);
    assertEquals(mgr.connections.size, 2);
    await sleep(1_100); // both windows long closed
    const t0 = Date.now();
    const at = async (ms: number) =>
      await sleep(Math.max(0, t0 + ms - Date.now()));
    b.ws.send(frame("b0")); //       fuse window [0, 1000]
    await at(500);
    a.ws.send(frame("a0")); //       a's window [500, 1500]
    await at(1_050);
    b.ws.send(frame("b1")); //       fuse window [1050, 2050]
    await at(1_250);
    burst(a, "a1-", 9); //           a: 10 of 10 in its first window
    await at(1_750);
    burst(a, "a2-", 10); //          a: 10 of 10 in its second — 19 in the fuse's
    await at(1_850);
    b.ws.send(frame("b2")); //       the fuse's 21st frame; b's 3rd
    await sleep(150);

    assertEquals(
      a.diags.filter((t) => t === "ws-rate"),
      [],
      "precondition: the straddler never exceeded its own budget (else the " +
        "timeline slipped and this proves nothing)",
    );
    assertEquals(
      b.diags.filter((t) => t === "ws-global-rate"),
      [],
      "b sent 3 frames in a second against a fuse of 20 — refusing it is the " +
        "neighbour's flood charged to the wrong client",
    );
  } finally {
    await close(peers);
  }
});

Deno.test("ws fuse: honest clients filling the fuse between them are told retryAfterMs, never closed", async () => {
  // Past 50 clients the fuse stops growing (10 x 50 = 500 here), so 60
  // clients each 9 frames inside a budget of 10 are 540 — over it, with no one
  // over their own budget.
  const { mgr, port, close } = await fuseHarness(10);
  const peers: Peer[] = [];
  let closes = 0;
  try {
    for (let i = 0; i < 60; i++) {
      const p = await peer(port);
      p.ws.addEventListener("close", () => closes++);
      peers.push(p);
    }
    for (let i = 0; i < 100 && mgr.connections.size < 60; i++) await sleep(10);
    assertEquals(mgr.connections.size, 60);
    await sleep(1_100);
    peers.forEach((p, i) => burst(p, `p${i}-`, 9));
    await sleep(300);

    const refused = peers.flatMap((p) =>
      [...p.acks.values()].filter((d) =>
        (d as { ok?: boolean }).ok === false
      ) as { retryAfterMs?: number }[]
    );
    assert(
      peers.some((p) => p.diags.includes("ws-global-rate")),
      "precondition: the fuse tripped (else this proves nothing)",
    );
    assert(refused.length > 0, "the refused frames are answered");
    assert(
      refused.every((d) =>
        typeof d.retryAfterMs === "number" && d.retryAfterMs > 0
      ),
      "…each with when the window reopens",
    );
    assertEquals(
      peers.flatMap((p) => p.diags.filter((t) => t === "ws-rate")),
      [],
      "no client went over its own budget",
    );
    assertEquals(closes, 0, "no honest client is closed for a full fuse");
    assertEquals(mgr.connections.size, 60);
  } finally {
    await close(peers);
  }
});
