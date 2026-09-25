// A write past `requestTimeoutMs` is rejected — but the worker never stops
// the statement: it runs on and COMMITS. The timeout error said only "did
// not answer … raise requestTimeoutMs", so an app that retried on it wrote
// the row twice. The message must say the write may still land.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { within } from "./within.ts";
import { createDB } from "../src/server-entry.ts";

const N = 3_000_000;

Deno.test("db timeout: a timed-out write says it may still commit — and it does", async () => {
  const db = createDB(":memory:", { requestTimeoutMs: 20 });
  try {
    await db.execute("CREATE TABLE t (x INTEGER)");
    const msg = await db.execute(
      "INSERT INTO t WITH RECURSIVE c(x) AS " +
        `(SELECT 1 UNION ALL SELECT x+1 FROM c LIMIT ${N}) SELECT x FROM c`,
    ).then(() => null, (e: Error) => e.message);
    assert(msg, "the slow write must time out for this test to mean anything");
    assertStringIncludes(msg!, 'did not answer a "execute"');
    assertStringIncludes(msg!, "may still commit");
    // The claim, proven: the "failed" write landed.
    let count: number | undefined;
    for (let i = 0; i < 200 && count === undefined; i++) {
      count = await db.query<{ n: number }>("SELECT COUNT(*) AS n FROM t")
        .then((r) => Number(r.rows[0]!.n), () => undefined);
      if (count === undefined) await new Promise((r) => setTimeout(r, 50));
    }
    assertEquals(count, N);
  } finally {
    await within(db.close(), 8000, undefined);
  }
});
