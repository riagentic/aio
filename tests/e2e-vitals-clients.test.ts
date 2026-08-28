// Real-browser proof that client vitals are wired: a chromium tab on a plain
// app makes `/__aio/vitals` report a client — the rAF render meter runs, the
// heartbeat pings, the server rows it. (`clients: []` was the answer for
// every app from alpha48 to alpha69.)
import { assert, assertEquals } from "@std/assert";
import { BROWSER, waitFor, withE2E } from "./e2e-harness.ts";

const ignore = BROWSER === null;

const CELLS = `import { cell } from "aio";
export const counter = cell("counter", {
  state: { n: 0 },
  methods: { inc(s) { s.n += 1; } },
});`;

const APP = `import { counter } from "./cells.ts";
export default function App() {
  return (
    <div>
      <span t="n">{String(counter.n)}</span>
      <button t="go" onClick={() => counter.inc()}>go</button>
    </div>
  );
}`;

Deno.test({
  name: "e2e vitals: a real browser tab is a client row in /__aio/vitals",
  ignore,
  async fn() {
    await withE2E(
      { cells: CELLS, app: APP, run: `renderBudget: { staleness: 300 }` },
      async ({ server, tab }) => {
        await waitFor("mount", () => tab.text("n"));
        type Row = { id: string; status: string };
        const rows = await waitFor("a vitals client row", async () => {
          const body = await (await server.fetch("/__aio/vitals")).json() as {
            clients?: Row[];
          };
          return body.clients && body.clients.length > 0 ? body.clients : null;
        }, 20_000);
        assertEquals(rows.length, 1, JSON.stringify(rows));
        assertEquals(rows[0]!.status, "healthy");
        // The client keeps pinging: a state change is a patch the meter
        // records, and the row stays healthy (the page painted it).
        await tab.trigger("App:go", "click");
        await waitFor("state converged", async () => {
          return (await tab.text("n")) === "1" ? true : null;
        }, 15_000);
        const again = await (await server.fetch("/__aio/vitals")).json() as {
          clients: Row[];
        };
        assert(again.clients.length === 1, JSON.stringify(again.clients));
        assertEquals(again.clients[0]!.status, "healthy");
      },
    );
  },
});
