// The 1 MB cell-state guardrail was WS-only, so a desktop app never saw it.
//
// Field report (quant, a 24/7 trading desk): a catalog page put 83,000 rows in
// cell state — "a 17 GB heap and 200 ms render stalls… it is a bug aio makes
// easy and gives no feedback about."
//
// The feedback existed. `warnBigFullState` names the offending cell and its
// size, and it lived INSIDE the WS broadcaster — so an Electron app, which
// opens no TCP ports and keeps every client on the socket, got no warning at
// any size. Fifth instance of the lens that hid `am cost`, `am status`, the
// broadcasts/sec alarm and `aio_clients_connected`.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { createUDSListener } from "../src/server/aio.ts";
import {
  _resetBigStateWarnings,
  BROADCAST_FULL_WARN_BYTES,
} from "../src/server/server-broadcast.ts";

/** Capture the framework logger's warnings for the duration of `fn`.
 *
 *  A `LogSink` receives `pub(level, category, message, data)` — the `log.warn`
 *  overloads normalise onto it. A mock shaped like the CALLER (`warn(...)`)
 *  intercepts nothing and reads as "the code never warned", which is how the
 *  first version of this test blamed the fix instead of itself. */
async function warningsDuring(fn: () => Promise<void>): Promise<string[]> {
  const { getLogger, setLogger } = await import(
    "../src/diagnostics/logger-api.ts"
  );
  const seen: string[] = [];
  const prev = getLogger();
  setLogger(
    {
      logDir: "",
      pub: (lvl: string, _cat: string, msg: string) => {
        if (lvl === "warn") seen.push(msg);
      },
      perf: () => {},
      flush: () => Promise.resolve(),
      // deno-lint-ignore no-explicit-any
    } as any,
  );
  try {
    await fn();
  } finally {
    setLogger(prev);
  }
  return seen;
}

Deno.test({
  name: "uds: an oversized cell is NAMED, on the desktop transport too",
  sanitizeResources: false, // aio-ok: the probe conn is closed below
  sanitizeOps: false, // aio-ok: as above
  async fn() {
    _resetBigStateWarnings();
    const dir = await Deno.makeTempDir({ prefix: "aio-bigstate-" });
    const socketPath = join(dir, "big.sock");
    // One cell well past the budget, one small — the message must pick the
    // right one, which is the half that makes it actionable.
    const rows = "x".repeat(BROADCAST_FULL_WARN_BYTES + 1024);
    const uds = createUDSListener(
      socketPath,
      () => ({ catalog: { rows }, nav: { tab: "desk" } }),
      () => {},
      () => {},
    );
    let conn: Deno.Conn | undefined;
    const warns = await warningsDuring(async () => {
      // Connecting is enough: the accept-time snapshot goes through the same
      // builder every broadcast uses.
      conn = await Deno.connect({ path: socketPath, transport: "unix" });
      await new Promise((r) => setTimeout(r, 80));
    });
    try {
      const hit = warns.find((w) => w.includes("full-state frame"));
      assert(
        hit,
        `the desktop transport must warn too; got ${JSON.stringify(warns)}`,
      );
      assert(hit.includes('"catalog"'), `name the offending cell: ${hit}`);
      assert(!hit.includes('"nav"'), `…and not the innocent one: ${hit}`);
      // The tier it belongs in, because "your state is big" is not a fix.
      assert(hit.includes("db: tables"), hit);
    } finally {
      try {
        conn?.close();
      } catch { /* already gone */ }
      uds.shutdown();
      // See check:orphans — a temp home a test does not remove is 4 GB in
      // aggregate and invisible one at a time.
      await Deno.remove(dir, { recursive: true }).catch(() => {});
      _resetBigStateWarnings();
    }
  },
});

Deno.test({
  name: "uds: ordinary state stays quiet",
  sanitizeResources: false, // aio-ok: as above
  sanitizeOps: false, // aio-ok: as above
  async fn() {
    _resetBigStateWarnings();
    const dir = await Deno.makeTempDir({ prefix: "aio-smallstate-" });
    const socketPath = join(dir, "small.sock");
    const uds = createUDSListener(
      socketPath,
      () => ({ nav: { tab: "desk" } }),
      () => {},
      () => {},
    );
    let conn: Deno.Conn | undefined;
    const warns = await warningsDuring(async () => {
      conn = await Deno.connect({ path: socketPath, transport: "unix" });
      await new Promise((r) => setTimeout(r, 80));
    });
    try {
      assertEquals(
        warns.filter((w) => w.includes("full-state frame")),
        [],
        "a normal app must never see this line, or it stops meaning anything",
      );
    } finally {
      try {
        conn?.close();
      } catch { /* already gone */ }
      uds.shutdown();
      await Deno.remove(dir, { recursive: true }).catch(() => {});
      _resetBigStateWarnings();
    }
  },
});
