// Transport-faithful subscription/delta coverage — the bug class that shipped
// broken through 20 alphas because the in-process harness can't see the wire.
// Each test boots a real server + real Chromium and asserts the client's
// rendered DOM converges with server-initiated state changes over the socket.
import { assert } from "@std/assert";
import { BROWSER, waitFor, withE2E } from "./e2e-harness.ts";

const ignore = BROWSER === null;

// A server scheduler drives changes nothing the client dispatched — the honest
// test of "does the delta actually arrive".
const TICKER = (cellsExtra = "", every = 500) =>
  `import { a, b } from "./cells.ts";
import "./cells.ts";
import { aio } from "aio";
${cellsExtra}
await aio.run({ persist: false, schedules: [
  { id: "ta", every: ${every}, action: a.inc.action() },
  { id: "tb", every: ${every}, action: b.inc.action() },
] });`;

const TWO_CELLS = `import { cell } from "aio";
export const a = cell("a", { state: { n: 0 }, methods: { inc(s) { s.n += 1; } } });
export const b = cell("b", { state: { m: 0 }, methods: { inc(s) { s.m += 1; } } });`;

Deno.test({
  name: "e2e sub: two directly-read cells both receive server deltas",
  ignore,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await withE2E({
      cells: TWO_CELLS,
      appTs: TICKER(),
      app: `import { a, b } from "./cells.ts";
export default function App() {
  return (<div><span t="av">{String(a.n)}</span><span t="bv">{String(b.m)}</span></div>);
}`,
    }, async ({ server, tab }) => {
      await waitFor("mount", () => tab.text("av"));
      await waitFor("both cells climb", async () => {
        const av = await tab.text("av");
        const bv = await tab.text("bv");
        return Number(av) >= 3 && Number(bv) >= 3 ? true : null;
      }, 15_000);
      const st = await server.state() as {
        a?: { n?: number };
        b?: { m?: number };
      };
      assert(
        (await tab.text("av")) === String(st.a?.n) &&
          (await tab.text("bv")) === String(st.b?.m),
        "both directly-read cells must track the server",
      );
    });
  },
});

Deno.test({
  name: "e2e sub: useCell(a) partial-sub does not starve directly-read b",
  ignore,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    // The exact bug shape, broadened: one cell via useCell (narrows the
    // subscription), the other via direct access — both must update.
    await withE2E({
      cells: TWO_CELLS,
      appTs: TICKER(),
      app: `import { useCell } from "aio/air";
import { a, b } from "./cells.ts";
export default function App() {
  const { state } = useCell(a);
  return (<div><span t="av">{String(state.n)}</span><span t="bv">{String(b.m)}</span></div>);
}`,
    }, async ({ tab }) => {
      await waitFor("mount", () => tab.text("bv"));
      await waitFor("directly-read b climbs despite partial sub", async () => {
        return Number(await tab.text("bv")) >= 3 ? true : null;
      }, 15_000);
      assert(Number(await tab.text("bv")) >= 3, "b must not be starved");
    });
  },
});

Deno.test({
  name: "e2e sub: a cell read only after a conditional mount still subscribes",
  ignore,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    // Mirrors the reporter's nav-heavy shape: `b` is read only inside a branch
    // that mounts after a click (post-connect, no popstate). It must subscribe
    // when first read and then receive live deltas.
    await withE2E({
      cells: TWO_CELLS,
      appTs: TICKER(),
      app: `import { useLocal } from "aio/air";
import { a, b } from "./cells.ts";
export default function App() {
  const { local: open, set } = useLocal(false);
  return (
    <div>
      <span t="av">{String(a.n)}</span>
      <button t="reveal" onClick={() => set(true)}>reveal</button>
      {open ? <span t="bv">{String(b.m)}</span>: <span t="hidden">hidden</span>}
    </div>
  );
}`,
    }, async ({ tab }) => {
      await waitFor("mount", () => tab.text("av"));
      // b not read yet — reveal it (post-connect), then it must start tracking.
      await tab.trigger("App:reveal", "click");
      await waitFor("late-mounted b receives deltas", async () => {
        const bv = await tab.text("bv");
        return bv !== null && Number(bv) >= 2 ? true : null;
      }, 15_000);
      assert(Number(await tab.text("bv")) >= 2, "late-read b must subscribe");
    });
  },
});
