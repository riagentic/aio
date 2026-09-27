// The trojan `sql` route caps its answer at TROJAN_SQL_MAX_RESULT_BYTES
// (10 000 000 — "result exceeds N bytes") but measured it with
// `serialized.length`, i.e. UTF-16 code units. For CJK text that is a third of
// the bytes: a 12 MB answer passed a 10 MB cap. src/protocol/utf8-size.ts
// exists for exactly this bug class ("a limit written as 1MB and checked
// against `length` passed 3 MB of Japanese text").
import { assertEquals } from "@std/assert";
import { handleTrojan, type TrojanDeps } from "../src/server/server-trojan.ts";

Deno.test("trojan sql: the byte cap is measured in bytes", async () => {
  // ~4 M code units of CJK → ~12 MB of UTF-8, one row (under the row cap).
  const big = "日".repeat(4_000_000);
  const deps = {
    prod: false,
    debug: () => {},
    port: 0,
    title: "t",
    getUIState: () => ({}),
    dispatch: () => {},
    trojan: {
      getState: () => ({}),
      getSchedules: () => [],
      sqlQuery: () => Promise.resolve([{ t: big }]),
    },
  } as unknown as TrojanDeps;
  const req = new Request("http://127.0.0.1/__aio/trojan/sql", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-AIO": "1" },
    body: JSON.stringify({ query: "SELECT t FROM x" }),
  });
  const res = await handleTrojan("/__aio/trojan/sql", req, deps)!;
  const body = new Uint8Array(await res.arrayBuffer());
  assertEquals(
    { status: res.status, over: body.byteLength > 10_000_000 },
    { status: 413, over: false },
    `a ${body.byteLength}-byte answer against a 10 000 000-byte cap`,
  );
});
