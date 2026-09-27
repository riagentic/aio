// Two writes start two live-query refreshes; with reader workers they can
// FINISH out of order, and the older result landing last left the rows at the
// state before the newer write. A result older than one applied is dropped.
import { assertEquals } from "@std/assert";
import { reactiveDB } from "../src/db/reactive.ts";
import type { DB } from "../src/db/types.ts";

Deno.test("live query: an older refresh finishing last does not overwrite a newer one", async () => {
  const pending: ((rows: unknown[]) => void)[] = [];
  let first = true;
  const db = {
    query(_sql: string) {
      if (first) {
        first = false;
        return Promise.resolve({ rows: [{ v: 0 }] });
      }
      return new Promise((resolve) => {
        pending.push((rows) => resolve({ rows }));
      });
    },
  } as unknown as DB;

  const q = await reactiveDB(db).select<{ v: number }>("SELECT v FROM t");
  assertEquals(q.rows, [{ v: 0 }]);
  const seen: number[][] = [];
  q.subscribe((r) => seen.push(r.map((x) => x.v)));

  const older = q.refresh();
  const newer = q.refresh();
  assertEquals(pending.length, 2);
  pending[1]!([{ v: 2 }]); // the newer query answers first…
  await newer;
  pending[0]!([{ v: 1 }]); // …the older one last
  await older;

  assertEquals(q.rows, [{ v: 2 }], "rows show the newest result");
  assertEquals(seen, [[2]], "subscribers were not handed the stale rows");
});
