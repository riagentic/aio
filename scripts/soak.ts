// Soak test (roadmap B4): run a real aio app under sustained load and fail
// on memory growth. Detects scheduler/subscription/listener leaks that only
// show up over time.
//
//   deno task soak            # 10 minutes (CI-friendly quick soak)
//   deno task soak -- --minutes=4320   # the full 72h run
//
// Load profile per second: ~20 WS dispatches across 4 clients + a
// schedule.every tick + one client churn (disconnect/reconnect) every 5s.
// Leak check: least-squares slope of heapUsed after a warmup third; fails if
// sustained growth exceeds GROWTH_LIMIT_MB_PER_MIN.
import { aio } from "../mod.ts";
import { cell } from "../src/state/cell.ts";
import { enc } from "../src/protocol/envelope.ts";

const minutes = Number(
  Deno.args.find((a) => a.startsWith("--minutes="))?.slice(10) ?? 10,
);
const GROWTH_LIMIT_MB_PER_MIN = 0.5;

const counter = cell("soak", {
  state: { count: 0, notes: [] as string[] },
  persist: "none",
  methods: {
    inc(s: { count: number }, by = 1) {
      s.count += by;
    },
    note(s: { notes: string[] }, msg = "x") {
      s.notes.push(msg);
      if (s.notes.length > 100) s.notes.shift(); // bounded by design
    },
  },
});

const app = await aio.run({
  appId: "aio-soak",
  cells: [counter],
  client: "server-only",
  transport: "ws",
  persist: false,
  baseDir: await Deno.makeTempDir({ prefix: "aio-soak-" }),
  schedules: [{ id: "soak-tick", every: 1000, action: counter.inc.action() }],
});

const port = app.port;
if (!port) {
  console.error("soak: could not determine app port");
  Deno.exit(2);
}

function client(): WebSocket {
  const ws = new WebSocket(`ws://localhost:${port}/ws`);
  ws.onmessage = () => {};
  return ws;
}

const clients: WebSocket[] = Array.from({ length: 4 }, client);
await new Promise((r) => setTimeout(r, 1500));

const samples: { t: number; heap: number }[] = [];
const t0 = Date.now();
let sent = 0;

const load = setInterval(() => {
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      for (let i = 0; i < 5; i++) {
        // A v2 envelope, like every other client. This used to send the bare
        // pre-alpha52 action frame, which `dec()` refuses and the server drops
        // with `ws: undecodable frame` — so the soak gate drove ZERO
        // dispatches through a cell for five alphas while reporting the frames
        // it wrote as "N dispatches". A load generator whose load never lands
        // is worse than no soak at all: it reports health for an idle server.
        ws.send(
          enc("action", {
            type: "soak:note",
            payload: { args: [`m${sent++}`] },
          }),
        );
      }
    }
  }
}, 1000);

const churn = setInterval(() => {
  const idx = Math.floor((Date.now() / 5000) % clients.length);
  clients[idx]?.close();
  clients[idx] = client();
}, 5000);

const sampler = setInterval(() => {
  const heap = Deno.memoryUsage().heapUsed / (1024 * 1024);
  samples.push({ t: (Date.now() - t0) / 60_000, heap });
  const last = samples[samples.length - 1]!;
  console.log(
    `[soak] ${last.t.toFixed(1)}min heap=${heap.toFixed(1)}MB sent=${sent}`,
  );
}, 10_000);

await new Promise((r) => setTimeout(r, minutes * 60_000));
clearInterval(load);
clearInterval(churn);
clearInterval(sampler);
for (const ws of clients) ws.close();

// least-squares slope over the post-warmup window (skip first third)
const window = samples.slice(Math.floor(samples.length / 3));
const n = window.length;
const mt = window.reduce((a, s) => a + s.t, 0) / n;
const mh = window.reduce((a, s) => a + s.heap, 0) / n;
const slope = window.reduce((a, s) => a + (s.t - mt) * (s.heap - mh), 0) /
  window.reduce((a, s) => a + (s.t - mt) ** 2, 0);

// Did the load actually LAND? `sent` counts frames written to a socket, which
// is not the same claim — for five alphas every one of them was refused at the
// server's decoder and this banner still reported them as dispatches. The cell
// is the only witness that a dispatch happened, so ask it before reporting
// anything, and refuse to pass on a soak that soaked nothing.
const soakState = counter as unknown as { count: number; notes: string[] };
const landed = soakState.notes.length;
console.log(
  `\n[soak] ${minutes}min done — ${sent} frames sent, ${soakState.count} ticks, ` +
    `heap slope ${slope.toFixed(3)} MB/min (limit ${GROWTH_LIMIT_MB_PER_MIN})`,
);

await app.close();

if (sent > 0 && landed === 0) {
  console.error(
    `[soak] FAILED — ${sent} frames were sent and NOTHING reached the cell. ` +
      `The load generator is not exercising the server (check the wire ` +
      `envelope version); a green heap slope over an idle server is not a ` +
      `soak result.`,
  );
  Deno.exit(1);
}

if (!Number.isFinite(slope) || n < 6) {
  console.error("[soak] not enough samples for a verdict — run longer");
  Deno.exit(2);
}
if (slope > GROWTH_LIMIT_MB_PER_MIN) {
  console.error("[soak] FAIL: sustained heap growth — likely leak");
  Deno.exit(1);
}
console.log("[soak] PASS: no sustained heap growth");
Deno.exit(0);
