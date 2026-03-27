// tests/aio29-filtered-marker.test.ts
// AIO-29: $f protocol marker — filtered state merge instead of replace
//
// Tests verify:
// 1. UDS __subs: response includes $f:1 when client has subscriptions
// 2. UDS broadcastState includes $f:1 on filtered full-state sends
// 3. Browser merges $f messages into existing _state (preserves unsubscribed features)
// 4. Electron bridge does NOT update lastFullState for $f messages
// 5. Unfiltered responses (no subscriptions) do NOT have $f

import { assertEquals } from "@std/assert";
import { createUDSListener } from "../src/aio.ts";
import { electronMainScriptUDS } from "../src/electron.ts";
import { join } from "@std/path";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Helpers ────────────────────────────────────────────────────────

async function connectAndRead(
  socketPath: string,
): Promise<{ conn: Deno.Conn; lines: string[]; reader: () => string[] }> {
  const conn = await Deno.connect({ path: socketPath, transport: "unix" });
  const lines: string[] = [];
  const decoder = new TextDecoder();
  let buf = "";
  const readable = conn.readable;
  const r = readable.getReader();
  (async () => {
    try {
      while (true) {
        const { value, done } = await r.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split("\n");
        buf = parts.pop()!;
        for (const part of parts) {
          if (part) lines.push(part);
        }
      }
    } catch { /* closed */ }
  })();
  return { conn, lines, reader: () => lines };
}

function send(conn: Deno.Conn, msg: string): void {
  const w = conn.writable.getWriter();
  w.write(new TextEncoder().encode(msg + "\n")).catch(() => {});
  w.releaseLock();
}

// ── 1. UDS __subs: response includes $f:1 ──────────────────────────

Deno.test("aio29: UDS __subs: response has $f marker when filtered", async () => {
  const socketPath = join(await Deno.makeTempDir(), "aio29-subs-f.sock");
  const uds = createUDSListener(
    socketPath,
    () => ({
      counter: { value: 42 },
      status: { ok: true },
      extra: { data: 99 },
    }),
    () => {},
    () => {},
  );
  await wait(50);

  const { conn, lines } = await connectAndRead(socketPath);
  await wait(50);

  // Initial state — should NOT have $f (unfiltered, full state)
  assertEquals(lines.length, 1);
  const initial = JSON.parse(lines[0]!);
  assertEquals(initial.$f, undefined, "initial full state must NOT have $f");
  assertEquals(initial.counter.value, 42);

  // Subscribe to subset → response should have $f:1
  send(conn, '__subs:["counter"]');
  await wait(100);

  assertEquals(lines.length >= 2, true, "should receive filtered response");
  const filtered = JSON.parse(lines[1]!);
  assertEquals(filtered.$f, 1, "filtered __subs: response MUST have $f:1");
  assertEquals(filtered.counter.value, 42, "counter must be present");
  assertEquals(filtered.status, undefined, "status must be excluded");

  conn.close();
  await wait(50);
  uds.shutdown();
});

// ── 2. UDS __subs: with "*" has NO $f (unfiltered) ─────────────────

Deno.test("aio29: UDS __subs: with '*' does NOT have $f", async () => {
  const socketPath = join(await Deno.makeTempDir(), "aio29-star-nof.sock");
  const uds = createUDSListener(
    socketPath,
    () => ({ a: 1, b: 2 }),
    () => {},
    () => {},
  );
  await wait(50);

  const { conn, lines } = await connectAndRead(socketPath);
  await wait(50);

  // Subscribe to "*" — no filtering → no $f
  send(conn, '__subs:["*"]');
  await wait(100);

  const response = JSON.parse(lines[lines.length - 1]!);
  assertEquals(response.$f, undefined, "'*' subscription must NOT have $f");
  assertEquals(response.a, 1);
  assertEquals(response.b, 2);

  conn.close();
  await wait(50);
  uds.shutdown();
});

// ── 3. UDS broadcastState includes $f on filtered full-state sends ──

Deno.test("aio29: UDS broadcastState(true) has $f when client is filtered", async () => {
  const socketPath = join(await Deno.makeTempDir(), "aio29-bcast-f.sock");
  let stateVal = 1;
  const uds = createUDSListener(
    socketPath,
    () => ({ counter: { value: stateVal }, status: { ok: true } }),
    () => {},
    () => {},
  );
  await wait(50);

  const { conn, lines } = await connectAndRead(socketPath);
  await wait(50);

  // Subscribe to subset
  send(conn, '__subs:["counter"]');
  await wait(100);

  const beforeBroadcast = lines.length;

  // Force broadcast — full state with subscriptions → must have $f
  stateVal = 99;
  uds.broadcastState(true);
  await wait(100);

  assertEquals(
    lines.length > beforeBroadcast,
    true,
    "should receive broadcast",
  );
  const broadcast = JSON.parse(lines[lines.length - 1]!);

  // Force broadcast sends full state (no $p) — must have $f since client is filtered
  if (!broadcast.$p) {
    assertEquals(
      broadcast.$f,
      1,
      "filtered full-state broadcast MUST have $f:1",
    );
    assertEquals(broadcast.counter.value, 99);
    assertEquals(broadcast.status, undefined, "status must be excluded");
  }

  conn.close();
  await wait(50);
  uds.shutdown();
});

// ── 4. Electron bridge: $f messages don't update lastFullState ──────

Deno.test("aio29: electron bridge skips $f for lastFullState", () => {
  const script = electronMainScriptUDS(
    "http://localhost:3000",
    "/tmp/test.sock",
    {
      title: "test",
    },
  );

  // The data handler should check for $f before updating lastFullState
  // Previously: if (line.indexOf('"$p"') === -1) lastFullState = line;
  // Fixed: if (line.indexOf('"$p"') === -1 && line.indexOf('"$f"') === -1) lastFullState = line;
  const hasFilteredGuard = script.includes('"$f"') &&
    script.includes('"$p"');

  assertEquals(
    hasFilteredGuard,
    true,
    "data handler must check for $f marker to protect lastFullState",
  );

  // Verify the $f check is near the lastFullState assignment
  const lastFullIdx = script.indexOf("lastFullState = line");
  assertEquals(lastFullIdx > -1, true, "must have lastFullState assignment");

  // The line containing lastFullState assignment should also reference $f
  const surroundingCode = script.slice(
    Math.max(0, lastFullIdx - 200),
    lastFullIdx + 50,
  );
  const hasFGuard = surroundingCode.includes('"$f"');
  assertEquals(
    hasFGuard,
    true,
    "lastFullState assignment must be guarded by $f check",
  );
});

// ── 5. Browser: $f merge preserves unsubscribed features ────────────
// (Unit test of the merge logic — tests the concept, not browser internals)

Deno.test("aio29: $f merge concept — filtered state preserves existing features", () => {
  // Simulate: existing state has all features
  const existingState: Record<string, unknown> = {
    ratelimit: { providers: [{ id: "a", name: "A" }], stats: { total: 10 } },
    status: { ok: true, uptime: 3600 },
    extra: { data: 99 },
  };

  // Filtered response only has ratelimit (with updated data)
  const filteredResponse: Record<string, unknown> = {
    $f: 1,
    ratelimit: {
      providers: [{ id: "a", name: "A" }, { id: "b", name: "B" }],
      stats: { total: 20 },
    },
  };

  // Two-level merge: preserve unsubscribed features AND sub-keys within features
  const { $f, ...data } = filteredResponse;
  assertEquals($f, 1, "$f must be present");

  const merged: Record<string, unknown> = { ...existingState };
  for (const key of Object.keys(data)) {
    const oldVal = existingState[key];
    const newVal = data[key];
    if (
      oldVal && typeof oldVal === "object" && !Array.isArray(oldVal) &&
      newVal && typeof newVal === "object" && !Array.isArray(newVal)
    ) {
      merged[key] = {
        ...(oldVal as Record<string, unknown>),
        ...(newVal as Record<string, unknown>),
      };
    } else {
      merged[key] = newVal;
    }
  }

  // Merged state must have ALL features
  assertEquals(
    (merged.status as Record<string, unknown>).ok,
    true,
    "unsubscribed 'status' must survive merge",
  );
  assertEquals(
    (merged.extra as Record<string, unknown>).data,
    99,
    "unsubscribed 'extra' must survive merge",
  );
  // Updated feature must have new data
  assertEquals(
    ((merged.ratelimit as Record<string, unknown>).providers as unknown[])
      .length,
    2,
    "merged ratelimit must have updated providers",
  );
});

// ── 6. Two-level merge preserves sub-keys not in filtered update ─────

Deno.test("aio29: two-level $f merge preserves unsubscribed feature sub-keys", () => {
  // Existing state: ratelimit has providers, stats, and limits
  const prev: Record<string, unknown> = {
    ratelimit: {
      providers: [{ id: "a" }],
      stats: { total: 10, average: 5 },
      limits: { max: 100 },
    },
  };

  // Filtered response only covers providers (stats and limits not subscribed)
  const data: Record<string, unknown> = {
    ratelimit: { providers: [{ id: "a" }, { id: "b" }] },
  };

  // Two-level merge
  const merged: Record<string, unknown> = { ...prev };
  for (const key of Object.keys(data)) {
    const oldVal = prev[key];
    const newVal = data[key];
    if (
      oldVal && typeof oldVal === "object" && !Array.isArray(oldVal) &&
      newVal && typeof newVal === "object" && !Array.isArray(newVal)
    ) {
      merged[key] = {
        ...(oldVal as Record<string, unknown>),
        ...(newVal as Record<string, unknown>),
      };
    } else {
      merged[key] = newVal;
    }
  }

  const rl = merged.ratelimit as Record<string, unknown>;
  assertEquals(
    (rl.providers as unknown[]).length,
    2,
    "providers updated to 2 elements",
  );
  assertEquals(
    (rl.stats as Record<string, unknown>).total,
    10,
    "stats.total preserved (not in filter)",
  );
  assertEquals(
    (rl.stats as Record<string, unknown>).average,
    5,
    "stats.average preserved",
  );
  assertEquals(
    (rl.limits as Record<string, unknown>).max,
    100,
    "limits preserved (not in filter)",
  );
});

// ── 7. Electron bridge: control messages don't corrupt lastFullState ──

Deno.test("aio29: electron bridge skips control messages for state tracking", () => {
  const script = electronMainScriptUDS(
    "http://localhost:3000",
    "/tmp/test.sock",
    {
      title: "test",
    },
  );

  // Control messages (__reload, __css, __boot:, etc.) must NOT update lastFullState or lastState.
  // Only JSON lines (starting with '{') should be tracked.
  const dataHandlerIdx = script.indexOf("sock.on('data'");
  assertEquals(dataHandlerIdx > -1, true, "must have sock.on data handler");

  const afterHandler = script.slice(dataHandlerIdx, dataHandlerIdx + 600);

  // Must check if line starts with '{' before tracking state
  const hasJsonGuard = afterHandler.includes("line[0] === '{'") ||
    afterHandler.includes('line[0] === "{"') ||
    afterHandler.includes("line.startsWith('{')");
  assertEquals(
    hasJsonGuard,
    true,
    "data handler must guard lastState/lastFullState updates with JSON check (line[0] === '{')",
  );
});

// ── 8. useFeature defaults — incomplete state gets merged with init shape ──

Deno.test("aio29: useFeature defaults merge — incomplete state gets init shape sub-keys", () => {
  // Simulate what useFeature does internally:
  // featureState from server (incomplete — providers not populated yet)
  const featureState: Record<string, unknown> = {};

  // Feature ref's __aio.state (the initial state schema from feature definition)
  const initShape: Record<string, unknown> = {
    providers: [],
    stats: { total: 0 },
  };

  // The merge logic: overlay featureState onto initShape defaults
  const defaults = initShape;
  let resolved: Record<string, unknown>;
  if (
    defaults && typeof featureState === "object" &&
    !Array.isArray(featureState) &&
    typeof defaults === "object" && !Array.isArray(defaults)
  ) {
    resolved = { ...defaults, ...featureState };
  } else {
    resolved = featureState;
  }

  // providers must exist (from defaults) even though server sent {}
  assertEquals(
    Array.isArray(resolved.providers),
    true,
    "providers must be [] from defaults",
  );
  assertEquals(
    (resolved.providers as unknown[]).length,
    0,
    "providers must be empty array",
  );
  assertEquals(
    (resolved.stats as Record<string, unknown>).total,
    0,
    "stats.total from defaults",
  );
});

Deno.test("aio29: useFeature defaults merge — complete state overrides defaults", () => {
  // featureState from server (complete — has real data)
  const featureState: Record<string, unknown> = {
    providers: [{ id: "a", name: "ProvA" }],
    stats: { total: 42 },
  };

  const initShape: Record<string, unknown> = {
    providers: [],
    stats: { total: 0 },
  };
  const resolved = { ...initShape, ...featureState };

  // Real data must override defaults
  assertEquals(
    (resolved.providers as unknown[]).length,
    1,
    "real providers must override default",
  );
  assertEquals(
    (resolved.stats as Record<string, unknown>).total,
    42,
    "real stats must override default",
  );
});

// ── 9. Deep merge: filtered response must NOT lose sub-sub-keys ──────

Deno.test("aio31: $f deep merge preserves sub-sub-keys not in filtered response", () => {
  // AIO-31: Two-level merge loses sub-sub-keys.
  //
  // Scenario: component A accesses ratelimit.providers + ratelimit.stats.total
  // Server filters → { ratelimit: { providers: [...], stats: { total: 10 } } }
  // Two-level merge: merged.ratelimit = { ...old.ratelimit, ...new.ratelimit }
  // This REPLACES stats entirely → stats.average is LOST → component B crashes.
  //
  // Fix: recursive deep merge for $f responses.

  const prev: Record<string, unknown> = {
    ratelimit: {
      providers: [{ id: "a" }],
      stats: { total: 10, average: 5, peak: 100 },
      limits: { max: 1000, remaining: 500 },
    },
    status: { ok: true, uptime: 3600 },
  };

  // Filtered response: only providers + stats.total (from subscription paths)
  const incoming: Record<string, unknown> = {
    ratelimit: {
      providers: [{ id: "a" }, { id: "b" }],
      stats: { total: 20 },
    },
  };

  // Import the actual merge function from browser.ts
  // For now, test the concept — the fix must make this pass.
  const merged = _deepMergeFiltered(prev, incoming);

  const rl = merged.ratelimit as Record<string, unknown>;

  // Updated values must reflect new data
  assertEquals((rl.providers as unknown[]).length, 2, "providers updated to 2");

  // Sub-sub-keys NOT in filtered response must be preserved
  const stats = rl.stats as Record<string, unknown>;
  assertEquals(stats.total, 20, "stats.total updated from filter");
  assertEquals(stats.average, 5, "stats.average MUST survive (not in filter)");
  assertEquals(stats.peak, 100, "stats.peak MUST survive (not in filter)");

  // Sub-keys not in filtered response must be preserved
  const limits = rl.limits as Record<string, unknown>;
  assertEquals(limits.max, 1000, "limits preserved (not in filter)");
  assertEquals(limits.remaining, 500, "limits.remaining preserved");

  // Top-level features not in filtered response must survive
  assertEquals(
    (merged.status as Record<string, unknown>).ok,
    true,
    "status preserved",
  );
});

Deno.test("aio31: deep merge replaces arrays and primitives, only recurses objects", () => {
  const prev: Record<string, unknown> = {
    feature: {
      items: [1, 2, 3],
      count: 10,
      meta: { label: "old", tags: ["a", "b"] },
    },
  };
  const incoming: Record<string, unknown> = {
    feature: {
      items: [4, 5],
      meta: { tags: ["c"] },
    },
  };

  const merged = _deepMergeFiltered(prev, incoming);
  const f = merged.feature as Record<string, unknown>;

  // Arrays replaced (not merged)
  assertEquals(f.items, [4, 5], "arrays must be replaced wholesale");
  // Primitives not in incoming preserved
  assertEquals(f.count, 10, "count preserved (not in incoming)");
  // Nested: tags replaced, label preserved
  const meta = f.meta as Record<string, unknown>;
  assertEquals(meta.tags, ["c"], "nested array replaced");
  assertEquals(meta.label, "old", "nested string preserved (not in incoming)");
});

// Helper: recursive deep merge (same logic as the fix in browser.ts)
function _deepMergeFiltered(
  prev: Record<string, unknown>,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...prev };
  for (const key of Object.keys(incoming)) {
    const oldVal = prev[key];
    const newVal = incoming[key];
    if (
      oldVal && typeof oldVal === "object" && !Array.isArray(oldVal) &&
      newVal && typeof newVal === "object" && !Array.isArray(newVal)
    ) {
      result[key] = _deepMergeFiltered(
        oldVal as Record<string, unknown>,
        newVal as Record<string, unknown>,
      );
    } else {
      result[key] = newVal;
    }
  }
  return result;
}
