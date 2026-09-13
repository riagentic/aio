// The boot-time kick of the builtin cells is armed PER APP.
//
// `startFeedback`/`startUpdates` arm a call (feedback's `refresh()`, updates'
// `ready()` + boot check) that `beginFeedback`/`beginUpdates` fire once the
// app's cells are bound. The armed call was ONE module-level slot, so two apps
// booting at once overwrote each other's: the first app's `begin*()` fired the
// SECOND app's cell (possibly before that app had bound it) and the second's
// fired nothing — one app's `feedback.enabled` / `updates.enabled` stayed false
// for its whole life. Whether two real boots interleave that way is timing, so
// the ordering is pinned here directly: arm A, arm B, begin A, begin B.
import { assertEquals } from "@std/assert";
import { beginFeedback, startFeedback } from "../src/server/feedback-boot.ts";
import { beginUpdates, startUpdates } from "../src/server/updates-boot.ts";
import type { FeedbackSlot } from "../src/state/feedback-cell.ts";
import type { UpdatesSlot } from "../src/state/updates-cell.ts";
import type { Log } from "../src/diagnostics/logger-api.ts";

const quiet = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Log;

Deno.test("beginFeedback(slot) fires THAT app's armed refresh, in any interleaving", () => {
  const fired: string[] = [];
  const slot = (id: string) =>
    ({
      runtime: null,
      cell: { refresh: () => (fired.push(id), Promise.resolve()) },
    }) as unknown as FeedbackSlot;
  const [a, b] = [slot("A"), slot("B")];
  const start = (s: FeedbackSlot) =>
    startFeedback({
      feedback: { auto: false },
      log: quiet,
      slot: s,
      sources: { dataDir: "/nonexistent" } as never,
    });
  const sa = start(a);
  const sb = start(b); // B arms before A's cells are bound
  try {
    beginFeedback(a);
    assertEquals(fired, ["A"], "A's begin refreshes A's cell — only");
    beginFeedback(b);
    assertEquals(fired, ["A", "B"], "B's own refresh is still armed");
    beginFeedback(a);
    assertEquals(fired, ["A", "B"], "fired once");
  } finally {
    sa.stop();
    sb.stop();
  }
});

Deno.test("beginUpdates(slot) publishes THAT app's config, in any interleaving", async () => {
  const fired: string[] = [];
  const slot = (id: string) =>
    ({
      runtime: null,
      cell: { ready: () => fired.push(id) },
    }) as unknown as UpdatesSlot;
  const [a, b] = [slot("A"), slot("B")];
  const data = await Deno.makeTempDir({ prefix: "aio-begin-slot-" });
  const start = (s: UpdatesSlot) =>
    startUpdates({
      updates: { source: "https://example.invalid/rel", check: false },
      dataDir: data,
      appName: "demo",
      appVersion: "1.0.0",
      local: { schema: 1, cells: {} },
      exposed: false,
      log: quiet,
      argv: [],
      slot: s,
    });
  const ua = start(a);
  const ub = start(b);
  try {
    beginUpdates(a);
    assertEquals(fired, ["A"], "A's begin readies A's cell — only");
    beginUpdates(b);
    assertEquals(fired, ["A", "B"], "B's own begin is still armed");
  } finally {
    ua.stop();
    ub.stop();
    await Deno.remove(data, { recursive: true });
  }
});
