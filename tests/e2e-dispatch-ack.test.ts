// Transport-faithful coverage of the per-action ACK round-trip — the contract
// behind `await cell.method()` in a browser. A real component awaits a cell
// method; the promise only settles when the server sends an ack frame back
// over the socket. This exercises the whole wire path that the in-process
// harness can't see: cid minting (cell-reactive), the pending-ack registry
// (browser-ack), the send pipeline (browser-air-transport), the server's
// cid→ack emit (server-ws), and the client's __ack router (browser-air-commands).
import { assert } from "@std/assert";
import { BROWSER, waitFor, withE2E } from "./e2e-harness.ts";

const ignore = BROWSER === null;

const COUNTER = `import { cell } from "aio";
export const counter = cell("counter", {
  state: { n: 0 },
  methods: { inc(s) { s.n += 1; } },
});`;

// The button AWAITS the method and only bumps a client-local ack tally once the
// promise resolves — so `acks` climbing proves the server ACK actually came
// back, not merely that the click fired. A functional set() keeps the tally
// correct even with several awaits in flight at once.
const APP = `import { useLocal } from "aio/air";
import { counter } from "./cells.ts";
export default function App() {
  const { local: acks, set } = useLocal(0);
  return (
    <div>
      <span t="n">{String(counter.n)}</span>
      <span t="acks">{String(acks)}</span>
      <button t="go" onClick={async () => { await counter.inc(); set((a) => a + 1); }}>go</button>
    </div>
  );
}`;

Deno.test({
  name:
    "e2e ack: an awaited browser method resolves on server ack + state converges",
  ignore,
  async fn() {
    await withE2E({ cells: COUNTER, app: APP }, async ({ server, tab }) => {
      await waitFor("mount", () => tab.text("acks"));
      // One awaited click: the promise must settle (acks 0→1) AND the mutation
      // must land on the server and echo back into the DOM.
      await tab.trigger("App:go", "click");
      await waitFor("ack settled", async () => {
        return (await tab.text("acks")) === "1" ? true : null;
      }, 15_000);
      await waitFor("state converged", async () => {
        return (await tab.text("n")) === "1" ? true : null;
      }, 15_000);
      const st = await server.state() as { counter?: { n?: number } };
      assert(
        st.counter?.n === 1,
        `server must reflect the mutation, got ${JSON.stringify(st.counter)}`,
      );
    });
  },
});

Deno.test({
  name:
    "e2e ack: a burst of awaited methods each resolve independently (no cid crossing)",
  ignore,
  async fn() {
    await withE2E({ cells: COUNTER, app: APP }, async ({ server, tab }) => {
      await waitFor("mount", () => tab.text("acks"));
      // Fire five awaited clicks in flight together. Each mints its own cid; if
      // any ack were dropped or a cid crossed, `acks` would stall below 5 (or a
      // promise would hang). All five must settle.
      const N = 5;
      for (let i = 0; i < N; i++) await tab.trigger("App:go", "click");
      await waitFor("all acks settled", async () => {
        return (await tab.text("acks")) === String(N) ? true : null;
      }, 20_000);
      await waitFor("count converged", async () => {
        return (await tab.text("n")) === String(N) ? true : null;
      }, 20_000);
      const st = await server.state() as { counter?: { n?: number } };
      assert(
        st.counter?.n === N,
        `every awaited dispatch must apply, server got ${
          JSON.stringify(st.counter)
        }`,
      );
    });
  },
});
