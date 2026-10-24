// Time travel driven from a REAL dev page (headless Chromium).
//
// `useTimeTravel().undo()` and the floating panel's buttons both send `tt-cmd`
// through `_sendTTCmd` (air/time-travel-panel.ts), which forwards to the send
// function the client transport injects with `setSendFn`. Nothing ever called
// `setSendFn` — every control was a silent no-op while the history list it
// sat beside rendered fine. This drives the hook from the page and reads the
// rewound state back from the SERVER, the only place undo is real.
import { assertEquals } from "@std/assert";
import { BROWSER, waitFor, withE2E } from "./e2e-harness.ts";

const CELLS = `import { cell } from "aio";
export const counter = cell("counter", {
  state: { n: 0 },
  methods: { inc(s) { s.n += 1; } },
});`;

const APP = `import { counter } from "./cells.ts";
import { useTimeTravel } from "aio/air";
export default function App() {
  const tt = useTimeTravel();
  return (
    <div>
      <span t="n">{String(counter.n)}</span>
      <span t="hist">{tt ? String(tt.entries.length) : "none"}</span>
      <button t="go" onClick={() => counter.inc()}>go</button>
      <button t="undo" onClick={() => tt?.undo()}>undo</button>
    </div>
  );
}`;

Deno.test({
  name:
    "time travel on a real dev page: useTimeTravel().undo reaches the server and rewind its state",
  ignore: BROWSER === null,
  async fn() {
    await withE2E({ cells: CELLS, app: APP }, async ({ server, tab }) => {
      const textIs = (name: string, want: string) =>
        waitFor(
          `${name} = ${want}`,
          async () => (await tab.text(name)) === want ? true : null,
          15_000,
        );
      await waitFor("mount", () => tab.text("n"));
      for (let i = 1; i <= 2; i++) {
        assertEquals((await tab.trigger("App:go", "click")).ok, true);
        await textIs("n", String(i));
      }
      await waitFor(
        "history",
        async () => Number(await tab.text("hist")) >= 2 ? true : null,
        15_000,
      );
      assertEquals((await tab.trigger("App:undo", "click")).ok, true);
      await textIs("n", "1");
      assertEquals(
        ((await server.state()).counter as { n: number }).n,
        1,
        "the server's state rewound",
      );
      // An undo PAUSES time travel, and `am trigger` refuses to click while
      // paused (the action would be dropped) — so the page's redo is not
      // drivable from here. One command proves the wiring both share.
    });
  },
});
