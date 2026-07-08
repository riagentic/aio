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
  appVersion: "0.0.0",
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
        ws.send(
          JSON.stringify({
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

console.log(
  `\n[soak] ${minutes}min done — ${sent} dispatches, heap slope ${
    slope.toFixed(3)
  } MB/min (limit ${GROWTH_LIMIT_MB_PER_MIN})`,
);

await app.close();

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
