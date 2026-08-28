// Return-value transport — the payoff of the ack round-trip: `await cell.m()`
// in a browser resolves with the method's ACTUAL return value, transported in
// the ack frame (AckPayload.value), not void. Covers both a SYNC method (value
// arrives via dispatch()'s resolved `ret`) and an ASYNC method (value arrives
// when the server-side executor resolves the registered call). A non-JSON
// return is coerced to `undefined` rather than hanging the caller.
import { assert } from "@std/assert";
import { BROWSER, waitFor, withE2E } from "./e2e-harness.ts";

const ignore = BROWSER === null;

const CELLS = `import { cell } from "aio";
export const calc = cell("calc", {
  state: { n: 0 },
  methods: {
    // SYNC: mutate AND return a computed value.
    addAndSum(s, a, b) { s.n += a; return { sum: a + b, n: s.n }; },
    // ASYNC: awaits, mutates across the await, returns a value.
    async doubleAsync(s, x) { await Promise.resolve(); s.n += 1; return x * 2; },
    // Non-serializable return — must resolve to undefined, never hang.
    giveFn(s) { s.n += 1; return () => 42; },
  },
});`;

// Each button awaits a method and stores the JSON of what it resolved with, so
// the DOM proves the real value crossed the wire (not void). \`typeof undefined\`
// is captured verbatim for the non-serializable case.
const APP = `import { useLocal } from "aio/air";
import { calc } from "./cells.ts";
export default function App() {
  const { local: out, set } = useLocal("pending");
  return (
    <div>
      <span t="n">{String(calc.n)}</span>
      <span t="out">{out}</span>
      <button t="sync" onClick={async () => {
        const r = await calc.addAndSum(2, 3);
        set(() => JSON.stringify(r));
      }}>sync</button>
      <button t="async" onClick={async () => {
        const r = await calc.doubleAsync(21);
        set(() => "n=" + String(r));
      }}>async</button>
      <button t="fn" onClick={async () => {
        const r = await calc.giveFn();
        set(() => "fn=" + typeof r);
      }}>fn</button>
    </div>
  );
}`;

Deno.test({
  name:
    "e2e return-value: SYNC method resolves the browser await with its value",
  ignore,
  async fn() {
    await withE2E({ cells: CELLS, app: APP }, async ({ server, tab }) => {
      await waitFor("mount", () => tab.text("out"));
      await tab.trigger("App:sync", "click");
      await waitFor("value returned", async () => {
        return (await tab.text("out")) === JSON.stringify({ sum: 5, n: 2 })
          ? true
          : null;
      }, 15_000);
      const st = await server.state() as { calc?: { n?: number } };
      assert(
        st.calc?.n === 2,
        `mutation must also land, got ${JSON.stringify(st.calc)}`,
      );
    });
  },
});

Deno.test({
  name:
    "e2e return-value: ASYNC method resolves the browser await with its value",
  ignore,
  async fn() {
    await withE2E({ cells: CELLS, app: APP }, async ({ tab }) => {
      await waitFor("mount", () => tab.text("out"));
      await tab.trigger("App:async", "click");
      await waitFor("async value returned", async () => {
        return (await tab.text("out")) === "n=42" ? true : null;
      }, 15_000);
    });
  },
});

Deno.test({
  name:
    "e2e return-value: non-serializable return resolves to undefined (no hang)",
  ignore,
  async fn() {
    await withE2E({ cells: CELLS, app: APP }, async ({ tab }) => {
      await waitFor("mount", () => tab.text("out"));
      await tab.trigger("App:fn", "click");
      // The await must SETTLE (proving no hang) with an undefined value.
      await waitFor("fn call settled to undefined", async () => {
        return (await tab.text("out")) === "fn=undefined" ? true : null;
      }, 15_000);
    });
  },
});
