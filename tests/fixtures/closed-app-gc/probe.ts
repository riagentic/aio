// Child of tests/closed-app-scope-gc.test.ts — run with --v8-flags=--expose-gc.
//
// Boots and closes N apps in ONE process, the way a host or a test file does,
// and reports how many of the closed apps' scopes the collector could take,
// and the post-gc() heap at two points so the per-cycle growth is measurable.
//
// Each app is a realistic one, not a bare reducer: a persisted cell (SQLite
// worker), a serverFns namespace, a method called over the trojan HTTP API,
// and a live WebSocket client connected while it runs. Half the cycles use
// FRESH cell defs (a factory, as `cell()` docs advise for many apps), half
// REUSE one module-level def (the test-file pattern).
import v8 from "node:v8";
import { aio, cell, serverFns } from "../../../mod.ts";
import { _diagScopeNow } from "../../../src/diagnostics/diagnostic-bus.ts";
import { freePort } from "../../../src/testing/server-test.ts";

const N = Number(Deno.args[0] ?? 24);
const root = Deno.args[1]!;
const gc = (globalThis as unknown as { gc: () => void }).gc;

let finalized = 0;
const fr = new FinalizationRegistry<number>(() => {
  finalized++;
});

const shared = cell("sharedc", {
  state: { n: 0 },
  methods: {
    inc(s: { n: number }) {
      s.n++;
    },
  },
});

// Module level, so no closure here captures a cycle's locals (its socket):
// what stays reachable is then only what aio itself keeps.
function onStart(i: number): void {
  fr.register(_diagScopeNow()!, i);
  // A namespace registered INSIDE the app — owned by it until it closes.
  serverFns(`ns${i}`, { read: () => 1 });
}

/** A fresh def per app — the factory `cell()`'s docs advise for many apps. */
const fresh = (i: number) =>
  cell(`fresh${i}`, {
    state: { n: 0 },
    methods: {
      inc(s: { n: number }) {
        s.n++;
      },
    },
  });

async function cycle(i: number): Promise<void> {
  const c = i % 2 === 0 ? shared : fresh(i);
  const port = freePort();
  const app = await aio.run({
    cells: [c],
    appId: `gcprobe-${i}`,
    appDir: `${root}/app${i}`,
    client: "server-only",
    libraryMode: true,
    singleton: false,
    persist: true,
    port,
    onStart: () => onStart(i),
  } as never) as unknown as { close(): Promise<void> };
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise((r) => (ws.onopen = r));
  const r = await fetch(`http://127.0.0.1:${port}/__aio/trojan/dispatch`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-aio": "1" },
    body: JSON.stringify({ type: `${c.__aio.id}:inc` }),
  });
  await r.text();
  const closed = new Promise((r) => ws.addEventListener("close", r));
  ws.close();
  await closed;
  await app.close();
}

const settle = async () => {
  for (let k = 0; k < 6; k++) {
    gc();
    await new Promise((r) => setTimeout(r, 30));
  }
};

/** Post-gc() heap WITHOUT the JIT's code and trusted spaces: optimized code
 *  and feedback keep growing for dozens of cycles as the process warms up,
 *  and would read as a leak that is not one. What is left is data. */
const dataHeap = () =>
  v8.getHeapSpaceStatistics()
    .filter((s) => !/code|trusted/.test(s.space_name))
    .reduce((n, s) => n + s.space_used_size, 0);

const heapAt: number[] = [];
const MARKS = [Math.floor(N / 3), N];
for (let i = 0; i < N; i++) {
  await cycle(i);
  if (MARKS.includes(i + 1)) {
    await settle();
    heapAt.push(dataHeap());
  }
}
await settle();
console.log(
  "RESULT " + JSON.stringify({
    n: N,
    finalized,
    perCycle: (heapAt[1]! - heapAt[0]!) / (MARKS[1]! - MARKS[0]!),
  }),
);
