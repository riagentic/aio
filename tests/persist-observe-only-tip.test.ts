// An observe-only persist report must not say the write failed.
//
// Three reports ride `PERSIST_ERROR` while the write still happens: a value
// JSON changes on the way (a Date, a Map, NaN), a cell over the hard size
// guardrail, and a version stamp skipped because the stored map could not be
// read. Each already keeps the durability verdict clean (`lastCycleError()`
// null). But the tip every one of them carried — in the console box, in the
// log line, and on `err.tip` in `onError` — was "State persist failed —
// changes are in memory but will be lost on restart", about a row that was
// on disk. A durability message that is false on the harmless days is the one
// nobody believes on the day it is true.
import { assert, assertEquals, assertMatch } from "@std/assert";
import { createPersistenceManager } from "../src/server/persistence.ts";
import type { AioError } from "../src/diagnostics/error.ts";
import { formatErrorCompact } from "../src/diagnostics/error.ts";
import { createMemoryKv } from "./_persist-tip-kv.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

const quiet = { debug() {}, info() {}, warn() {}, error() {} } as Any;

function manager(state: Record<string, unknown>, kv = createMemoryKv()) {
  const reported: AioError[] = [];
  const p = createPersistenceManager({
    kvDb: kv,
    asyncDb: null,
    dbSchema: undefined,
    appId: "tip-probe",
    persistKey: "tip-probe",
    persistMode: "single",
    persistMs: 999999,
    getState: () => state,
    getDBState: (s) => s,
    log: quiet,
    getReportOpts: () => ({ onError: (e: AioError) => reported.push(e) }),
  });
  return { p, reported, kv };
}

Deno.test("persist: a value JSON changes on the way is written — and its tip says so, not 'persist failed'", async () => {
  const { p, reported, kv } = manager({ a: { when: new Date(0) } });
  await p.flushPersist();
  assertEquals(p.lastCycleError(), null, "precondition: the write landed");
  assert(await kv.get("tip-probe"), "precondition: the row is on disk");
  assertEquals(reported.length, 1, "still reaches onError");
  const tip = reported[0]!.tip ?? "";
  assert(
    !/persist failed|lost on restart/i.test(tip),
    `an observe-only report must not claim the write failed: ${tip}`,
  );
  assertMatch(tip, /still happened/i);
  assert(!/lost on restart/.test(formatErrorCompact(reported[0]!)));
});

Deno.test("persist: a write that really failed keeps the 'persist failed' tip", async () => {
  const kv = createMemoryKv();
  kv.set = () => Promise.reject(new Error("disk I/O error"));
  const { p, reported } = manager({ a: { n: 1 } }, kv);
  await p.flushPersist();
  assert(p.lastCycleError(), "precondition: the verdict is refused");
  assert(reported.length >= 1);
  assertMatch(reported.at(-1)!.tip ?? "", /persist failed/i);
});
