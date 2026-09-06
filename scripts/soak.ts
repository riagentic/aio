// Soak test (roadmap B4): run a real aio app under sustained load and fail
// on memory growth. Detects scheduler/subscription/listener leaks that only
// show up over time.
//
//   deno task soak                     # 10 minutes (CI-friendly quick soak)
//   deno task soak:72h                 # the full 72h run
//   deno task soak --minutes=4320      # any duration; the LAST --minutes wins
//
// `--minutes` is declared to `aio.run` via `appFlags`. Without that, aio's CLI
// parser refuses it as an unknown flag before the soak starts — which is what
// both deno.json tasks did, so `deno task soak` and `deno task soak:72h` each
// failed in under a second. A 72-hour run is a named beta gate; it could not
// be started at all.
//
// Load profile per second: ~20 WS dispatches across 4 clients + a
// schedule.every tick + one client churn (disconnect/reconnect) every 5s.
// Leak check: least-squares slope of heapUsed after a warmup third; fails if
// sustained growth exceeds GROWTH_LIMIT_MB_PER_MIN.
import { aio } from "../mod.ts";
import { cell } from "../src/state/cell.ts";
import { enc } from "../src/protocol/envelope.ts";

// LAST wins: `deno task soak --minutes=4320` appends to the task's own
// `--minutes=10`, and `find` would have taken the task's value and silently
// ignored the one the operator typed.
const minutes = Number(
  Deno.args.filter((a) => a.startsWith("--minutes=")).at(-1)?.slice(10) ?? 10,
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
  // Trailing `=` because it takes a VALUE (the spelling `appFlags` documents:
  // "--sync" is a switch, "--user=" takes one). Without it aio refuses
  // `--minutes=10` as unknown, before any soaking happens.
  appFlags: ["--minutes="],
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

/** A leak is a RETAINED set that grows. `heapUsed` is not that: V8's old space
 *  climbs between major GCs and drops when one runs, so the raw signal is a
 *  sawtooth and a least-squares line through it measures where the window
 *  happened to start and end in that cycle.
 *
 *  MEASURED on this very app, with no leak: 1.521 MB/min over 10 minutes
 *  (FAIL — and 10 minutes is `deno task soak`, the duration this file offers
 *  as the CI-friendly one), 0.491 MB/min over 27 minutes (pass, barely). The
 *  post-GC FLOOR over the same 27 minutes went 21, 41, 54, 30, 40, 28, 44, 30,
 *  30 MB — up and down, never a trend. A gate that fails a healthy app is
 *  worse than no gate: the first red is investigated, the second is ignored,
 *  and the leak it was written for arrives to an audience that has stopped
 *  believing it.
 *
 *  So: force a collection before sampling when the runtime allows it, and the
 *  number IS the retained set. `deno task soak` passes
 *  `--v8-flags=--expose-gc` for exactly this. Without it, fall back to the
 *  floor of each window, which is the same quantity read off the sawtooth. */
const gc = (globalThis as { gc?: () => void }).gc;
/** Filled in at the verdict, once the fallback's bucket width is known — a
 *  banner that names a window size the run did not use is the same defect as
 *  any other message that describes something it is not doing. */
let MEASURE = gc ? "post-GC heap" : "the floor of each window";

const sampler = setInterval(() => {
  gc?.();
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
const postWarmup = samples.slice(Math.floor(samples.length / 3));
/** The retained set per window. With a forced GC every sample already IS it;
 *  without one, the MINIMUM of each 3-minute window is the floor of the
 *  sawtooth, which is the closest thing to a post-collection reading that a
 *  process without `--expose-gc` can observe. */
const series: { t: number; heap: number }[] = gc ? postWarmup : (() => {
  // Bucket width scales with the run: ~8 points whatever the duration, so a
  // 10-minute soak still gets a verdict (a fixed 3-minute bucket left it with
  // two points and "not enough samples", which is a different way to be
  // useless).
  const span = (postWarmup.at(-1)?.t ?? 0) - (postWarmup[0]?.t ?? 0);
  const width = Math.max(1, span / 8);
  MEASURE = `the floor of each ${width.toFixed(1)}-minute window`;
  const floors = new Map<number, { t: number; heap: number }>();
  for (const s of postWarmup) {
    const b = Math.floor(s.t / width) * width;
    const cur = floors.get(b);
    if (!cur || s.heap < cur.heap) floors.set(b, { t: b, heap: s.heap });
  }
  return [...floors.values()].sort((a, b) => a.t - b.t);
})();
const n = series.length;
const mt = series.reduce((a, s) => a + s.t, 0) / n;
const mh = series.reduce((a, s) => a + s.heap, 0) / n;
const slope = series.reduce((a, s) => a + (s.t - mt) * (s.heap - mh), 0) /
  series.reduce((a, s) => a + (s.t - mt) ** 2, 0);

// Did the load actually LAND? `sent` counts frames written to a socket, which
// is not the same claim — for five alphas every one of them was refused at the
// server's decoder and this banner still reported them as dispatches. The cell
// is the only witness that a dispatch happened, so ask it before reporting
// anything, and refuse to pass on a soak that soaked nothing.
const soakState = counter as unknown as { count: number; notes: string[] };
const landed = soakState.notes.length;
console.log(
  `\n[soak] ${minutes}min done — ${sent} frames sent, ${soakState.count} ticks, ` +
    `heap slope ${
      slope.toFixed(3)
    } MB/min (limit ${GROWTH_LIMIT_MB_PER_MIN}, ` +
    `measured on ${MEASURE} over ${n} points)`,
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
  console.error(
    `[soak] FAIL: sustained growth of the RETAINED set (${
      slope.toFixed(3)
    } MB/min, measured on ${MEASURE}) — likely leak`,
  );
  Deno.exit(1);
}
console.log("[soak] PASS: no sustained heap growth");
// The 72-hour soak is a named beta gate, and until now nothing recorded that
// it had ever run. A PASS writes its own row — but only a run long enough to
// BE that claim: a green 10-minute soak is a useful smoke test and is not
// evidence of 72 hours, and a ledger that blurs the two is worse than none.
if (minutes >= 4320) {
  const { recordProof } = await import("./proof.ts");
  await recordProof(
    "soak",
    "72h",
    `${minutes}min, slope ${slope.toFixed(3)} MB/min`,
  );
}
Deno.exit(0);
