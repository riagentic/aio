// A route key with "?" or "#" can never match: the matcher compares
// `url.pathname`, which carries neither. `"/api/x?y"` booted silently and every
// request for it fell through to the app shell — 200 text/html, read as
// success. It warns at boot now (a warning, not a refusal: 1.0.11 booted it).
import { assert, assertEquals } from "@std/assert";
import { cell } from "../src/state/cell-create.ts";
import { testServer } from "../src/testing/server-test.ts";

const c = cell("route-key-query-warns", { state: { n: 0 } });

Deno.test("routes: a key with ? or # warns at boot that it can never match", async () => {
  const warns: string[] = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  const push = (...a: unknown[]) => warns.push(a.map(String).join(" "));
  console.log = push;
  console.warn = push;
  console.error = push;
  try {
    for (const key of ["/api/x?y=1", "/api/x#top"]) {
      await using _srv = await testServer({
        cells: [c],
        routes: { [key]: () => new Response("R") },
      });
    }
    await using _ok = await testServer({
      cells: [c],
      routes: { "/api/x": () => new Response("R") },
    });
  } finally {
    console.log = orig.log;
    console.warn = orig.warn;
    console.error = orig.error;
  }
  const hits = warns.filter((w) => w.includes("can never match"));
  assertEquals(hits.length, 2, warns.join("\n"));
  assert(hits[0]!.includes('"/api/x?y=1"'), hits[0]);
  assert(hits[0]!.includes('Declare "/api/x"'), hits[0]);
  assert(hits[1]!.includes('"/api/x#top"'), hits[1]);
});
