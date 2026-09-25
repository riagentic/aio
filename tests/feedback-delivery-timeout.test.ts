// A report is on disk before delivery is attempted — and delivery is a POST to
// the configured `feedback.url` with no deadline. A collector that accepts the
// connection and never answers (a wedged ingest, a proxy holding the socket)
// kept `capture()` pending forever: `feedback.report()` sat in "capturing"
// for the life of the process, the "saved → …" line was never logged, and the
// user was never told the report they filed was safe. Delivery now has a
// deadline; missing it is a failed delivery, said, with the report kept.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  _feedbackDelivery,
  startFeedback,
} from "../src/server/feedback-boot.ts";
import type { FeedbackSlot } from "../src/state/feedback-cell.ts";
import type { Log } from "../src/diagnostics/logger.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

Deno.test("feedback: a collector that never answers fails delivery, it does not hang capture", async () => {
  const dir = await tempDir("aio-feedback-timeout-");
  const port = await freePort();
  const hung: (() => void)[] = [];
  const server = Deno.serve(
    { hostname: "127.0.0.1", port, onListen: () => {} },
    () => new Promise<Response>((r) => hung.push(() => r(new Response("")))),
  );
  const warns: string[] = [];
  const log = {
    info: () => {},
    warn: (_c: string, m: string) => void warns.push(m),
    error: () => {},
    debug: () => {},
  } as unknown as Log;
  const slot: FeedbackSlot = { runtime: null, cell: null };
  const was = _feedbackDelivery.timeoutMs;
  _feedbackDelivery.timeoutMs = 300;
  const started = startFeedback({
    feedback: { auto: false, url: `http://127.0.0.1:${port}/ingest` },
    log,
    slot,
    sources: {
      appId: "app",
      appVersion: "1.0.0",
      aioVersion: "x",
      dataDir: dir,
      logsDir: dir,
      exposed: false,
      persist: false,
      cells: [],
    },
  });
  try {
    let guard: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      slot.runtime!.capture({ kind: "user", title: "it broke" }),
      new Promise<"hung">((r) => guard = setTimeout(() => r("hung"), 5_000)),
    ]).finally(() => clearTimeout(guard));
    assert(outcome !== "hung", "capture() never returned");
    assertEquals(outcome.delivered, false);
    assertEquals(warns.length, 1, JSON.stringify(warns));
    assertStringIncludes(warns[0]!, "could not be delivered");
    // The report itself is safe on disk.
    assert((await Deno.stat(outcome.path)).isFile);
  } finally {
    _feedbackDelivery.timeoutMs = was;
    started.stop();
    for (const h of hung) h();
    await server.shutdown();
    await dropTempDir(dir);
  }
});
