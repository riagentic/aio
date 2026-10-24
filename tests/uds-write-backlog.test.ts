// A UDS peer that stops reading grows an unbounded queue, silently.
//
// The WS transport throttles a slow client and freezes it (`bpMultiplier`,
// `isFrozen`). The UDS transport — the one a desktop app uses for EVERY client,
// because it opens no TCP ports at all — had neither: `sendTo` chains each
// write onto a per-connection promise with no depth bound and no diagnostic.
// A window that stops draining its socket accumulates encoded frames in
// memory, indefinitely, while `/__aio/health` answers "healthy".
//
// Depth is OBSERVED rather than capped, deliberately. Dropping frames would be
// worse than the leak: the peer is the app's OWN window, and a silently skipped
// state frame is a frozen UI. So the memory still grows — and the app says so.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { createUDSListener } from "../src/server/aio.ts";
import { WRITE_STALL_MS } from "../src/server/write-backlog.ts";
import { diagSubscribe } from "../src/diagnostics/diagnostic-bus.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { _resetDegraded, degradedReport } from "../src/diagnostics/degraded.ts";
import {
  connectRW,
  localEndpoint,
  localIdle,
} from "./local-endpoint-helper.ts";

/** A real listener, and a real client that connects and never reads. */
async function wedgedPeer() {
  const dir = await Deno.makeTempDir({ prefix: "aio-backlog-" });
  const socketPath = localEndpoint(join(dir, "backlog.sock"));
  const uds = createUDSListener(
    socketPath,
    () => ({ big: "x".repeat(2000) }),
    () => {},
    () => {},
  );
  // Connect, then read NOTHING — the kernel buffer fills and every further
  // write parks in the queue this test is about.
  const conn = await connectRW(socketPath);
  // Let the accept-time frame land before measuring.
  await new Promise((r) => setTimeout(r, 50));
  return {
    uds,
    stop: async () => {
      try {
        conn.close();
      } catch { /* already gone */ }
      uds.shutdown();
      await localIdle();
      // The dir goes with it: `check:orphans` counts every temp home a test
      // leaves behind, and they are invisible one at a time and GBs together.
      Deno.removeSync(dir, { recursive: true });
    },
  };
}

const backlog = () =>
  degradedReport().filter((r) => r.name === "uds:write-backlog");

Deno.test({
  name: "uds: a peer that stops reading is REPORTED, never silently buffered",
  sanitizeResources: false, // aio-ok: the wedged conn is closed in stop(); Deno sees the parked write
  sanitizeOps: false, // aio-ok: the parked write op is the scenario under test
  async fn() {
    _resetDegraded();
    const { uds, stop } = await wedgedPeer();
    try {
      // Well past the warn threshold. Each round is a full state frame, and
      // the peer reads none of them.
      for (let i = 0; i < 200; i++) uds.broadcastState(true);
      await new Promise((r) => setTimeout(r, WRITE_STALL_MS * 2));
      // The ENTRY, not a count: `.length > 0` is true of any array and says
      // nothing about which tracker escalated or how far.
      const entry = backlog()[0];
      assert(
        entry,
        `a wedged peer must reach /__aio/health; got ${
          JSON.stringify(degradedReport())
        }`,
      );
      assertEquals(entry.name, "uds:write-backlog");
      assert(
        entry.failures >= 1,
        `…having actually failed, not merely registered: ${
          JSON.stringify(entry)
        }`,
      );
    } finally {
      await stop();
      _resetDegraded();
    }
  },
});

Deno.test({
  name: "uds: an ordinary burst stays quiet",
  sanitizeResources: false, // aio-ok: same shape as above
  sanitizeOps: false, // aio-ok: same shape as above
  async fn() {
    _resetDegraded();
    const dir = await Deno.makeTempDir({ prefix: "aio-quiet-" });
    const socketPath = localEndpoint(join(dir, "quiet.sock"));
    const uds = createUDSListener(
      socketPath,
      () => ({ n: 1 }),
      () => {},
      () => {},
    );
    const conn = await connectRW(socketPath);
    // A client that DOES read — the ordinary case.
    const reader = (async () => {
      const buf = new Uint8Array(65536);
      try {
        while (await conn.read(buf) !== null) { /* drain */ }
      } catch { /* closed */ }
    })();
    try {
      for (let i = 0; i < 8; i++) uds.broadcastState(true);
      await new Promise((r) => setTimeout(r, 100));
      assertEquals(
        backlog(),
        [],
        "a handful of queued frames is not a wedged peer — reporting it would " +
          "teach people to ignore the one that matters",
      );
    } finally {
      try {
        conn.close();
      } catch { /* already gone */ }
      uds.shutdown();
      await localIdle();
      await reader;
      await Deno.remove(dir, { recursive: true }).catch(() => {});
      _resetDegraded();
    }
  },
});

Deno.test({
  // A peer that READS, hit with a burst far past the depth threshold: depth
  // alone says "stopped reading" while every write is completing. The verdict
  // must be about progress (no write finished for a stall window), not depth.
  name: "uds: a 200-frame burst to a peer that reads is not a wedged peer",
  sanitizeResources: false, // aio-ok: same shape as above
  sanitizeOps: false, // aio-ok: same shape as above
  async fn() {
    _resetDegraded();
    const dir = await tempDir("aio-burst-");
    const socketPath = localEndpoint(join(dir, "burst.sock"));
    let n = 0;
    const uds = createUDSListener(
      socketPath,
      () => ({ n: n++, big: "x".repeat(4000) }),
      () => {},
      () => {},
    );
    const conn = await connectRW(socketPath);
    const reader = (async () => {
      const buf = new Uint8Array(65536);
      try {
        while (await conn.read(buf) !== null) { /* drain */ }
      } catch { /* closed */ }
    })();
    // The END state is not enough: the false alarm escalated and recovered
    // within milliseconds, so the report was empty again by the time anyone
    // looked. Watch every escalation instead.
    const fired: string[] = [];
    const off = diagSubscribe((e) => {
      if (e.type === "degraded:uds:write-backlog") fired.push(e.message);
    }, { prodErrors: true });
    try {
      await new Promise((r) => setTimeout(r, 50));
      for (let i = 0; i < 200; i++) uds.broadcastState(true);
      await new Promise((r) => setTimeout(r, WRITE_STALL_MS * 2));
      assertEquals(
        fired,
        [],
        "a burst that drains is not a peer that stopped reading",
      );
      assertEquals(backlog(), []);
    } finally {
      off();
      try {
        conn.close();
      } catch { /* already gone */ }
      uds.shutdown();
      await localIdle();
      await reader;
      await dropTempDir(dir);
      _resetDegraded();
    }
  },
});

Deno.test({
  // Two windows, one wedged: the healthy one draining to empty used to call
  // `ok()` for the whole transport, so /__aio/health went green while the
  // wedged window's queue kept growing. Recovery is "no connection stalled".
  name: "uds: a healthy window draining does not clear a wedged one",
  sanitizeResources: false, // aio-ok: same shape as above
  sanitizeOps: false, // aio-ok: same shape as above
  async fn() {
    _resetDegraded();
    const dir = await tempDir("aio-two-");
    const socketPath = localEndpoint(join(dir, "two.sock"));
    const uds = createUDSListener(
      socketPath,
      () => ({ big: "x".repeat(2000) }),
      () => {},
      () => {},
    );
    const wedged = await connectRW(socketPath);
    const healthy = await connectRW(socketPath);
    const reader = (async () => {
      const buf = new Uint8Array(65536);
      try {
        while (await healthy.read(buf) !== null) { /* drain */ }
      } catch { /* closed */ }
    })();
    try {
      await new Promise((r) => setTimeout(r, 50));
      for (let i = 0; i < 200; i++) uds.broadcastState(true);
      await new Promise((r) => setTimeout(r, WRITE_STALL_MS * 2));
      uds.broadcastState(true); // the healthy window drains to empty again
      await new Promise((r) => setTimeout(r, 50));
      assertEquals(backlog().map((r) => r.name), ["uds:write-backlog"]);
    } finally {
      for (const c of [wedged, healthy]) {
        try {
          c.close();
        } catch { /* already gone */ }
      }
      uds.shutdown();
      await localIdle();
      await reader;
      await dropTempDir(dir);
      _resetDegraded();
    }
  },
});
