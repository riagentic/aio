// An app-supplied delay that is NOT a delay — NaN (a `Number(env)` left
// unset), 0, a negative — handed to setTimeout/setInterval is read as ~0: a
// ~1 ms sampling loop, every call rejected at once. The class is closed in
// `capDelay` (state/timer-ceiling): NaN, or a value under the site's floor,
// falls back to that key's default and is said.
import { assert, assertEquals } from "@std/assert";
import {
  capDelay,
  MAX_TIMER_DELAY,
  MIN_INTERVAL_MS,
} from "../src/state/timer-ceiling.ts";
import {
  createMemoryMonitor,
  MEMORY_INTERVAL_MS,
} from "../src/diagnostics/memory-monitor.ts";
import { startVitalsCheck } from "../src/server/aio-run-helpers.ts";
import { DEFAULT_HEARTBEAT_INTERVAL } from "../src/vitals/types.ts";
import { AioLogger } from "../src/diagnostics/logger-core.ts";
import { createDB, DB_REQUEST_TIMEOUT_MS } from "../src/db/async-db.ts";
import { clampTimerDelays } from "../src/server/config.ts";
import { connectCli } from "../src/server/cli-client.ts";
import { cell } from "../src/state/cell-create.ts";
import type { CellDef } from "../src/state/cell-types.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { captureConsoleAsync } from "./console-capture.ts";
import { until } from "../src/state/async-helpers.ts";

/** Run `fn` recording every delay handed to setTimeout/setInterval. */
async function armedDelays(
  fn: () => Promise<void> | void,
  ids: number[] = [],
): Promise<number[]> {
  const seen: number[] = [];
  const st = globalThis.setTimeout, si = globalThis.setInterval;
  // deno-lint-ignore no-explicit-any
  const wrap = (orig: any) => (cb: any, ms?: number, ...a: any[]) => {
    seen.push(ms as number);
    const id = orig(cb, ms, ...a);
    ids.push(id);
    return id;
  };
  globalThis.setTimeout = wrap(st) as typeof setTimeout;
  globalThis.setInterval = wrap(si) as typeof setInterval;
  try {
    await fn();
  } finally {
    globalThis.setTimeout = st;
    globalThis.setInterval = si;
  }
  return seen;
}

Deno.test("capDelay: exact edge values", () => {
  const said: string[] = [];
  const w = (m: string) => said.push(m);
  // No floor (a ceiling, where 0 / a negative means "none"): only NaN is
  // replaced, and the ceiling still caps.
  assertEquals(capDelay("k", NaN, w, 7), 7);
  assertEquals(capDelay("k", 0, w, 7), 0);
  assertEquals(capDelay("k", -5, w, 7), -5);
  assertEquals(capDelay("k", -Infinity, w, 7), -Infinity);
  assertEquals(capDelay("k", 1, w, 7), 1);
  assertEquals(capDelay("k", MAX_TIMER_DELAY, w, 7), MAX_TIMER_DELAY);
  assertEquals(capDelay("k", MAX_TIMER_DELAY + 1, w, 7), MAX_TIMER_DELAY);
  assertEquals(capDelay("k", Infinity, w, 7), MAX_TIMER_DELAY);
  assertEquals(capDelay("k", Number.MAX_VALUE, w, 7), MAX_TIMER_DELAY);
  assertEquals(said.length, 4, said.join("\n")); // NaN, MAX+1, Infinity, MAX_VALUE
  assert(said[0]!.includes("k: NaN") && said[0]!.includes("using 7ms"));
  // With a floor (an interval): everything under it is replaced.
  said.length = 0;
  for (const bad of [NaN, 0, -1, -Infinity, MIN_INTERVAL_MS - 1, 0.5]) {
    assertEquals(capDelay("i", bad, w, 99, MIN_INTERVAL_MS), 99, String(bad));
  }
  assertEquals(said.length, 6);
  assertEquals(
    capDelay("i", MIN_INTERVAL_MS, w, 99, MIN_INTERVAL_MS),
    MIN_INTERVAL_MS,
  );
  assertEquals(
    capDelay("i", Infinity, w, 99, MIN_INTERVAL_MS),
    MAX_TIMER_DELAY,
  );
});

const monitor = (interval: number) =>
  createMemoryMonitor({
    enabled: true,
    interval,
    warnThreshold: 0.7,
    criticalThreshold: 0.9,
    onReport: () => {},
    getMemoryUsage: () => ({ heapUsed: 0, heapTotal: 1, rss: 0, external: 0 }),
    getHeapLimit: () => 1,
    getCellStates: () => [],
  });

for (const bad of [NaN, 0, -5, 1, MIN_INTERVAL_MS - 1]) {
  Deno.test(`memory.interval: ${bad} is not a ~1 ms sampling loop, and it is said`, async () => {
    let m: { stop: () => void } | undefined;
    const lines = await captureConsoleAsync(async () => {
      const d = await armedDelays(() => {
        m = monitor(bad);
      });
      m?.stop();
      assertEquals(d, [MEMORY_INTERVAL_MS]);
    });
    assert(lines.join("\n").includes("memory.interval"), lines.join("\n"));
  });
}

Deno.test("memory.interval: the floor itself is honoured", async () => {
  let m: { stop: () => void } | undefined;
  const d = await armedDelays(() => {
    m = monitor(MIN_INTERVAL_MS);
  });
  m?.stop();
  assertEquals(d, [MIN_INTERVAL_MS]);
});

for (const bad of [NaN, -1, 0]) {
  Deno.test(`vitals.heartbeatInterval: ${bad} is not a hot loop`, async () => {
    let t: ReturnType<typeof setInterval> | undefined;
    await captureConsoleAsync(async () => {
      const d = await armedDelays(() => {
        t = startVitalsCheck({
          // deno-lint-ignore no-explicit-any
          vitalsSystem: {} as any,
          heartbeatInterval: bad,
          dispatch: { getQueueDepth: () => 0, getEffectBacklog: () => 0 },
          getState: () => ({}),
        });
      });
      clearInterval(t);
      assertEquals(d, [DEFAULT_HEARTBEAT_INTERVAL]);
    });
  });
}

Deno.test("logging.heartbeat: NaN is said, not silently off", async () => {
  const dir = await tempDir("aio-hb-nan-");
  const l = new AioLogger({ dir, heartbeat: NaN, console: false });
  try {
    const d = await armedDelays(() => l.init());
    assert(d.includes(3_600_000), `armed: ${d}`);
    await l.flush();
    const log = await Deno.readTextFile(`${dir}/app.log`);
    assert(log.includes("logging.heartbeat: NaN"), `not said: ${log}`);
  } finally {
    l.onStop();
    await l.flush();
    await dropTempDir(dir);
  }
});

Deno.test("logging.heartbeat: 0 and a negative still turn it off", async () => {
  for (const off of [0, -1]) {
    const dir = await tempDir("aio-hb-off-");
    const l = new AioLogger({ dir, heartbeat: off, console: false });
    try {
      const d = await armedDelays(() => l.init());
      assert(!d.includes(3_600_000), `armed: ${d}`);
    } finally {
      l.onStop();
      await l.flush();
      await dropTempDir(dir);
    }
  }
});

Deno.test("db requestTimeoutMs: NaN keeps the default ceiling, said", async () => {
  const lines = await captureConsoleAsync(async () => {
    const db = createDB(":memory:", { requestTimeoutMs: NaN });
    try {
      const d = await armedDelays(async () => {
        await db.query("SELECT 1 AS x");
      });
      assert(d.includes(DB_REQUEST_TIMEOUT_MS), `armed: ${d}`);
      assert(!d.some(Number.isNaN), `armed: ${d}`);
    } finally {
      await db.close();
    }
  });
  assert(lines.join("\n").includes("requestTimeoutMs"), lines.join("\n"));
});

Deno.test("perfBudget.methods[m].timeout: NaN falls back to the default ceiling", async () => {
  await captureConsoleAsync(async () => {
    const out = clampTimerDelays({
      perfBudget: {
        methods: { "c:m": { timeout: NaN }, "c:w": { timeout: 5 } },
      },
    });
    assertEquals(out.perfBudget?.methods?.["c:m"]?.timeout, undefined);
    assertEquals(out.perfBudget?.methods?.["c:w"]?.timeout, 5);
  });
});

Deno.test("connectCli ackTimeoutMs: NaN does not reject every call after ~1 ms", async () => {
  // A server that sends state and never acks: the call must stay pending
  // (under the default ceiling), not be failed on the next tick.
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen: () => {} },
    (req) => {
      // The client probes over plain HTTP first; only the socket matters.
      if (req.headers.get("upgrade") !== "websocket") {
        return new Response(null, { status: 404 });
      }
      const { socket, response } = Deno.upgradeWebSocket(req);
      socket.onopen = () =>
        socket.send(
          JSON.stringify({ v: 2, t: "state", d: { nanack: { n: 0 } } }),
        );
      return response;
    },
  );
  const c = cell("nanack", {
    state: { n: 0 },
    methods: {
      inc(s) {
        s.n++;
      },
    },
  });
  // deno-lint-ignore no-explicit-any
  let app: any;
  await captureConsoleAsync(async () => {
    app = connectCli(`ws://127.0.0.1:${server.addr.port}/ws`, {
      ackTimeoutMs: NaN,
      readyTimeoutMs: NaN,
    });
    try {
      await app.ready;
      app.bind(c as unknown as CellDef);
      const outcome = await Promise.race([
        (c as unknown as { inc: () => Promise<unknown> }).inc().then(
          () => "resolved",
          (e: Error) => `rejected: ${e.message}`,
        ),
        new Promise((r) => setTimeout(() => r("pending"), 200)),
      ]);
      assertEquals(outcome, "pending");
    } finally {
      app.close();
      await server.shutdown();
    }
  });
});

// `null` (a JS caller, a JSON config) meant "the default" while these read
// `??`; the NaN guard coerced it to 0 — fastest polling, instant timeout.
Deno.test("until: a NaN, negative or null intervalMs polls at the default; 0 and 5 stay as given", async () => {
  for (
    const [given, armed] of [[NaN, 25], [0, 0], [-1, 25], [5, 5], [null, 25]]
  ) {
    const ids: number[] = [];
    const d = await armedDelays(() => {
      void until(() => false, {
        intervalMs: given as number,
        timeoutMs: 60_000,
      });
    }, ids);
    ids.forEach(clearInterval);
    assertEquals(d, [armed], `intervalMs: ${given}`);
  }
});

Deno.test("until: a NaN or null timeoutMs still times out (at the default), never hangs", async () => {
  for (const given of [NaN, null]) {
    const realNow = Date.now;
    const t0 = realNow();
    // Time jumps a day on the first poll: any finite ceiling has passed.
    let polls = 0, hung: ReturnType<typeof setTimeout> | undefined;
    Date.now = () => polls++ === 0 ? t0 : t0 + 86_400_000;
    try {
      const outcome = await Promise.race([
        until(() => false, { timeoutMs: given as number, intervalMs: 5 })
          .then(
            () => "resolved",
            (e: Error) => e.message,
          ),
        new Promise((r) => hung = setTimeout(() => r("hung"), 300)),
      ]);
      assert(
        String(outcome).includes("within 30000ms"),
        `${given}: ${outcome}`,
      );
    } finally {
      Date.now = realNow;
      clearTimeout(hung);
    }
  }
});
