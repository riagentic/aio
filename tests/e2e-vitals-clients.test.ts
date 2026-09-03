// Real-browser proof that client vitals are wired: a chromium tab on a plain
// app is a client row in `/__aio/vitals` AND keeps beating — the rAF render
// meter runs, the heartbeat pings, the server stamps it. (`clients: []` was the
// answer for every app from alpha48 to alpha69.)
//
// TWO things stop this test from being satisfied by an idle socket:
//
//  • The tab is found by ITS OWN client id (`/__aio/trojan/clients`), never by
//    being the only row. The freeze watchdog registers a client at CONNECT now
//    — a peer that upgrades and then says nothing is exactly the one it exists
//    for (see src/vitals/transport-probe.ts) — so a dev page's reload socket is
//    legitimately a row too, and "there is exactly one row" was never the
//    property this test cared about.
//  • Presence alone is therefore no longer evidence of a heartbeat, so the
//    assertion is that the row's `lastPing` ADVANCES: a second beat lands from
//    the same client. A tab whose vitals sender is dead registers at connect,
//    sits at one stamp, and fails here.
//
// `status === "healthy"` IS asserted, and that is only honest since the server
// stopped grading a heartbeat age through RTT tiers. It used to run
// `now - lastPing` through transport degraded 100ms / warning 500ms / frozen
// 2000ms — but that quantity is the age of the last beat of a 1s heartbeat,
// sampled by an independent 1s grading tick, so a perfectly live tab measured
// degraded 83% of the time and healthy 0.7% (580 samples, real chromium), and
// this assertion was a phase lottery between two timers. The watchdog now
// answers the one question a heartbeat age can answer — healthy / frozen /
// recovered, threshold unchanged — so for a tab that is beating every second,
// "healthy" and "not frozen" are the same statement, and the stricter spelling
// is the one worth writing. See src/vitals/transport-probe.ts.
import { assertEquals } from "@std/assert";
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
        type Row = { id: string; status: string; gap: number };
        type Peer = { index: number; id: string; type: string };

        // WHICH row is the tab: the WS client behind this tab's trojan index.
        const tabId = await waitFor("the tab's client id", async () => {
          const peers = await (await server.fetch("/__aio/trojan/clients"))
            .json() as Peer[];
          return peers.find((p) => p.index === tab.index)?.id ?? null;
        });
        /** The tab's own vitals row, plus when the server last heard from it
         *  (`gap` is `now - lastPing` on the server's clock, same machine). */
        const beat = async () => {
          const body = await (await server.fetch("/__aio/vitals")).json() as {
            clients?: Row[];
          };
          const row = body.clients?.find((c) => c.id === tabId);
          return row ? { ...row, lastPing: Date.now() - row.gap } : null;
        };

        const first = await waitFor("the tab's vitals row", beat, 20_000);
        assertEquals(first.status, "healthy", JSON.stringify(first));
        // It KEEPS pinging (heartbeat is 1s): a strictly later stamp from the
        // same client. Registration-at-connect cannot fake this.
        const second = await waitFor(
          "a second heartbeat from the tab",
          async () => {
            const b = await beat();
            return b && b.lastPing > first.lastPing + 50 ? b : null;
          },
          20_000,
        );
        assertEquals(second.status, "healthy", JSON.stringify(second));

        // A state change is a patch the meter records, and the server keeps
        // hearing the tab across it (the page painted it and kept beating).
        await tab.trigger("App:go", "click");
        await waitFor("state converged", async () => {
          return (await tab.text("n")) === "1" ? true : null;
        }, 15_000);
        const after = await waitFor(
          "a heartbeat after the state change",
          async () => {
            const b = await beat();
            return b && b.lastPing > second.lastPing + 50 ? b : null;
          },
          20_000,
        );
        assertEquals(after.status, "healthy", JSON.stringify(after));
      },
    );
  },
});
