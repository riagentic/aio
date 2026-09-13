// A `cdiag` frame over UDS is a CLIENT's claim too — the same rules as WS.
//
// tests/cdiag-client-origin.test.ts pins the WS half: impossible numbers are
// not stored as fact, and the report is attributed in the server log, once per
// socket per name. The UDS router (every Electron window speaks it) had its own
// copy of the frame handler with neither: `failures: 1e400` parsed to Infinity
// and landed on /__aio/health as such, nothing named the peer that said so —
// and a peer that disconnected left its report there forever, because nothing
// on this transport cleared it (health "degraded" for a window long gone). One
// definition now lives in `_recordClientDegraded`; this pins that UDS uses it.
import { assert, assertEquals } from "@std/assert";
import { createUDSListener } from "../src/server/aio.ts";
import {
  _resetDegraded,
  clientDegradedReport,
} from "../src/diagnostics/degraded.ts";
import { getLogger, setLogger } from "../src/diagnostics/logger-api.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { join } from "@std/path";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.test("uds cdiag: impossible numbers are not reported as fact, the report is attributed once per name, and a gone peer's report is cleared", async () => {
  _resetDegraded();
  const dir = await tempDir("uds-cdiag-origin-");
  const socketPath = join(dir, "t.sock");
  const uds = createUDSListener(socketPath, () => ({}), () => {}, () => {});
  const warns: string[] = [];
  const prevLogger = getLogger();
  setLogger({
    pub: (lvl: string, cat: string, msg: string) => {
      if (lvl === "warn") warns.push(`[${cat}] ${msg}`);
    },
    // deno-lint-ignore no-explicit-any
  } as any);
  const conn = await Deno.connect({ path: socketPath, transport: "unix" });
  let closed = false;
  // Drain server frames so the write queue keeps moving.
  const drained = (async () => {
    const buf = new Uint8Array(65536);
    try {
      while ((await conn.read(buf)) !== null) { /* discard */ }
    } catch { /* aio-ok: closed at teardown */ }
  })();
  try {
    const future = Date.now() + 365 * 86_400_000;
    const lines = [
      // Raw text: `1e400` is a JSON number that parses to Infinity.
      `{"v":2,"t":"cdiag","d":{"name":"payments","kind":"down",` +
      `"failures":1e400,"since":${future},"lastError":"FORGED"}}`,
      JSON.stringify({
        v: 2,
        t: "cdiag",
        d: { name: "ledger", kind: "down", failures: -7.5, since: -1 },
      }),
      JSON.stringify({
        v: 2,
        t: "cdiag",
        d: { name: "payments", kind: "down", failures: 3, since: Date.now() },
      }),
    ];
    await conn.write(new TextEncoder().encode(lines.join("\n") + "\n"));
    let rows = clientDegradedReport();
    for (let i = 0; i < 100 && rows.length < 2; i++) {
      await wait(20);
      rows = clientDegradedReport();
    }
    assertEquals(rows.map((r) => r.name).sort(), ["ledger", "payments"]);
    for (const r of rows) {
      assert(
        Number.isInteger(r.failures) && r.failures >= 0,
        `failures must be a count a client can have, got ${JSON.stringify(r)}`,
      );
    }
    const said = warns.filter((l) => /client #/.test(l));
    assertEquals(
      said.filter((l) => /"payments"/.test(l)).length,
      1,
      `the report is attributed to its peer, once per name:\n${
        warns.join("\n")
      }`,
    );
    assert(said.some((l) => /"ledger"/.test(l) && /uds/.test(l)));

    conn.close();
    closed = true;
    for (let i = 0; i < 100 && clientDegradedReport().length > 0; i++) {
      await wait(20);
    }
    assertEquals(
      clientDegradedReport(),
      [],
      "a disconnected UDS peer's report is no longer live signal",
    );
  } finally {
    if (!closed) {
      try {
        conn.close();
      } catch { /* aio-ok: already closed */ }
    }
    await drained;
    uds.shutdown();
    setLogger(prevLogger);
    await dropTempDir(dir);
    _resetDegraded();
  }
});
