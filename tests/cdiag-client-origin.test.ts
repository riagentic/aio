// A `cdiag` frame is a CLIENT's claim, and the server treats it as one.
//
// `/__aio/health` reports client-side degradations (docs/debugging/errors.md)
// under `clientDegraded`, from whatever a connected socket sends. The r3 auth
// hunt sent one by hand — `{ name: "payments", failures: 999, lastError:
// "FORGED by bob" }` — and health turned "degraded" with that text, while the
// server's own log said nothing about where it came from. Two things are
// pinned here:
//  • the numbers are checked, not trusted: a failure count or a start time
//    no client can truthfully have (negative, fractional, infinite, in the
//    future) is not reported as fact;
//  • the report is ATTRIBUTED where the operator looks: the server log names
//    the client (and user) that made it, once per socket per name — health
//    saying "degraded" must be traceable to who said so.
import { assert, assertEquals } from "@std/assert";
import { cell } from "../mod.ts";
import { testServer } from "../src/testing/server-test.ts";

const c = cell("cdiagorigin", { state: { n: 0 }, methods: {} });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.test("cdiag: impossible numbers are not reported as fact, and the report is attributed to its client in the server log", async () => {
  const lines: string[] = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  const push = (...a: unknown[]) => lines.push(a.map(String).join(" "));
  console.log = push;
  console.warn = push;
  console.error = push;
  let ws: WebSocket | undefined;
  let closed: Promise<unknown> = Promise.resolve();
  try {
    await using srv = await testServer({ cells: [c] });
    ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`);
    closed = new Promise((r) => (ws!.onclose = r));
    await new Promise((r) => (ws!.onopen = r));
    const future = Date.now() + 365 * 86_400_000;
    // Raw text: `1e400` is a JSON number that parses to Infinity.
    ws.send(
      `{"v":2,"t":"cdiag","d":{"name":"payments","kind":"down",` +
        `"failures":1e400,"since":${future},"lastError":"FORGED"}}`,
    );
    ws.send(JSON.stringify({
      v: 2,
      t: "cdiag",
      d: { name: "ledger", kind: "down", failures: -7.5, since: -1 },
    }));
    ws.send(JSON.stringify({
      v: 2,
      t: "cdiag",
      d: { name: "payments", kind: "down", failures: 3, since: Date.now() },
    }));
    await sleep(200);
    const h = await (await fetch(`${srv.url}/__aio/health`)).json() as {
      status: string;
      clientDegraded?: { name: string; failures: unknown }[];
    };
    // The documented part stays: a client's report is visible, as a CLIENT's.
    assertEquals(h.status, "degraded");
    const rows = h.clientDegraded ?? [];
    assertEquals(rows.map((r) => r.name).sort(), ["ledger", "payments"]);
    for (const r of rows) {
      assert(
        typeof r.failures === "number" && Number.isInteger(r.failures) &&
          r.failures >= 0,
        `failures must be a count a client can have, got ${JSON.stringify(r)}`,
      );
    }
    const said = lines.filter((l) =>
      /cdiag|reports/.test(l) && /client #/.test(l)
    );
    assertEquals(
      said.filter((l) => /"payments"/.test(l)).length,
      1,
      `the report is attributed to its client, once per name:\n${
        lines.join("\n")
      }`,
    );
    assert(said.some((l) => /"ledger"/.test(l)));
    ws.close();
    await closed;
  } finally {
    console.log = orig.log;
    console.warn = orig.warn;
    console.error = orig.error;
    ws?.close();
    await closed;
  }
});
