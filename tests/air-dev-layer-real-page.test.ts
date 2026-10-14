// A REAL dev page still has its diagnostics — both halves of the dev layer.
//
// The renderer's dev checks left the production bundle (air/dev-air.ts), and
// the chunk a page fetches (browser/dev-diagnostics.ts) is unchanged. The
// in-process tests prove the hooks are installed where Deno runs the source;
// this proves it where it matters — a headless Chromium on `aio dev`, which
// loads the same modules through the dev server's own transpile route:
//
//   · the STATIC half: an `<img>` with no alt and an `onClik` typo are said
//     on the page's console, which the forwarder carries to the server;
//   · the FETCHED half: `tab.text()` / `tab.trigger()` are the `am surface` /
//     `am trigger` engine, which lives in the chunk.
import { assert } from "@std/assert";
import { BROWSER, serverOutput, waitFor, withE2E } from "./e2e-harness.ts";

const CELLS = `import { cell } from "aio";
export const counter = cell("counter", {
  state: { n: 0 },
  methods: { inc(s) { s.n += 1; } },
});`;

const APP = `import { counter } from "./cells.ts";
export default function App() {
  return (
    <div>
      <img src="/none.png" />
      <i onClik={() => {}}>typo</i>
      <span t="n">{String(counter.n)}</span>
      <button t="go" onClick={() => counter.inc()}>go</button>
    </div>
  );
}`;

Deno.test({
  name:
    "dev layer on a real dev page: the renderer's checks speak, and the fetched chunk drives the page",
  ignore: BROWSER === null,
  async fn() {
    await withE2E({ cells: CELLS, app: APP }, async ({ server, tab }) => {
      // The fetched chunk: surface + trigger.
      await waitFor("mount", () => tab.text("n"));
      const r = await tab.trigger("App:go", "click");
      assert(r.ok, `trigger: ${r.error}`);
      await waitFor(
        "the click landed",
        async () => (await tab.text("n")) === "1" ? true : null,
        15_000,
      );
      // The static layer: both lints, forwarded from the page's console to
      // the app's own log directory (the boot banner names it).
      const logDir = /^\s+logs\s+(\S+)/m.exec(serverOutput(server.proc))?.[1];
      assert(logDir, "the boot banner names the log directory");
      const said = (what: string) =>
        waitFor(`the dev page says: ${what}`, async () => {
          for await (const e of Deno.readDir(logDir)) {
            if (!e.isFile) continue;
            const text = await Deno.readTextFile(`${logDir}/${e.name}`);
            if (text.includes(what)) return true;
          }
          return null;
        }, 15_000);
      await said("<img> missing");
      await said("unknown event");
    });
  },
});
