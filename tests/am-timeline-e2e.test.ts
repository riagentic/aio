// End-to-end proof of the timeline wiring (risoto #4): a real dispatch on a real
// server flows through the afterActionHook into the in-memory ring and surfaces
// on the trojan `timeline` route with the exact state diff it produced. Covers
// the seam the unit tests can't — aio.ts hook → timeline.record → trojan route.
import { assert } from "@std/assert";
import { BROWSER, waitFor, withE2E } from "./e2e-harness.ts";

const ignore = BROWSER === null;

const CELLS = `import { cell } from "aio";
export const counter = cell("counter", {
  state: { n: 0 },
  methods: { inc(s, by = 1) { s.n += by; } },
});`;

const APP = `import { counter } from "./cells.ts";
export default function App() {
  return (
    <div>
      <span t="n">{String(counter.n)}</span>
      <button t="go" onClick={() => counter.inc(2)}>go</button>
    </div>
  );
}`;

type TimelineResp = {
  entries: {
    seq: number;
    type: string;
    payload?: unknown;
    diff: { path: string; before: unknown; after: unknown }[];
  }[];
};

Deno.test({
  name: "e2e timeline: a dispatch surfaces on the trojan route with its diff",
  ignore,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await withE2E({ cells: CELLS, app: APP }, async ({ server, tab }) => {
      await waitFor("mount", () => tab.text("n"));
      await tab.trigger("App:go", "click");
      await waitFor("state converged", async () => {
        return (await tab.text("n")) === "2" ? true : null;
      }, 15_000);

      const tl = await (await fetch(`${server.base}/__aio/trojan/timeline`))
        .json() as TimelineResp;
      const inc = tl.entries.find((e) => e.type === "counter:inc");
      assert(
        inc,
        `timeline must record the inc dispatch, got ${
          JSON.stringify(tl.entries)
        }`,
      );
      assert(
        inc!.diff.some((d) => d.path === "counter.n" && d.after === 2),
        `diff must show counter.n → 2, got ${JSON.stringify(inc!.diff)}`,
      );
      assert(
        (inc!.payload as { args?: unknown[] })?.args?.[0] === 2,
        `payload must carry the method args, got ${
          JSON.stringify(inc!.payload)
        }`,
      );
    });
  },
});
