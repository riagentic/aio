// Real Chromium over the socket: typing outruns a slow method while the parent
// re-renders every 15 ms. A raw `<input value={c.name} onInput={inline}>` stored
// "cf" for "abcdef" — every mid-flight render re-asserted a stale prop (the
// value before the first keystroke, an older keystroke's echo) over newer
// typed text. It also reads `c.$pending()`, which the browser cell stub
// lacked (a blank page). In-process twin: tests/controlled-input-inflight-echo.test.tsx.
import { assertEquals } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { findBrowser, waitFor, withE2E } from "./e2e-harness.ts";

const ROOT = fromFileUrl(new URL("..", import.meta.url));

const CELLS = `import { cell } from "aio";
export const c = cell("c", {
  state: { name: "" },
  methods: {
    async setSlow(s, v) { await new Promise((r) => setTimeout(r, 120)); s.name = v; },
    setSync(s, v) { s.name = v; },
  },
});`;

const APP = `import { useLocal, signal } from "aio/air";
import { Input } from "aio/ui";
import { c } from "./cells.ts";
const tick = signal(0);
setInterval(() => tick.set(tick() + 1), 15);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export default function App() {
  const { local: out, set } = useLocal("-");
  const run = async (k, sel) => {
    const el = document.querySelector(sel);
    el.focus();
    const snaps = [];
    for (const ch of "abcdef") {
      el.value += ch;
      el.dispatchEvent(new InputEvent("input", { bubbles: true, data: ch, inputType: "insertText" }));
      await sleep(40);
      snaps.push(el.value);
    }
    await sleep(900);
    // Short: the surface truncates long text.
    set(k + ":" + snaps.join(",") + "|" + el.value + "|" + c.name);
  };
  return (
    <div>
      <input aria-label="Raw" class="raw" value={c.name} onInput={(e) => c.setSlow(e.target.value)} />
      <Input aria-label="Kit" class="kit" value={c.name} onInput={(v) => c.setSlow(v)} />
      <span>{tick() % 2 ? "x" : "y"}</span>
      <span t="busy">{c.$pending() ? "saving" : "idle"}</span>
      <span t="out">{out}</span>
      <button t="raw" onClick={() => run("raw", "input.raw")}>r</button>
      <button t="kit" onClick={() => run("kit", "input.kit, .kit input")}>k</button>
      <button t="reset" onClick={() => c.setSync("")}>x</button>
    </div>
  );
}`;

const SNAPS = ["a", "ab", "abc", "abcd", "abcde", "abcdef"];

Deno.test({
  name:
    "chromium: fast typing against a slow method under parent re-renders keeps every key",
  ignore: findBrowser() === null,
  fn: async () => {
    await withE2E({
      cells: CELLS,
      app: APP,
      imports: { "aio/ui": `${ROOT}src/ui/mod.ts` },
    }, async ({ tab }) => {
      await waitFor("mount", () => tab.text("out"));
      for (const k of ["raw", "kit"]) {
        await tab.trigger("App:reset", "click");
        await new Promise((r) => setTimeout(r, 300));
        await tab.trigger(`App:${k}`, "click");
        const got = await waitFor(k, async () => {
          const t = await tab.text("out");
          return t?.startsWith(`${k}:`) ? t : null;
        }, 20_000);
        assertEquals(got, `${k}:${SNAPS.join(",")}|abcdef|abcdef`);
      }
    });
  },
});
