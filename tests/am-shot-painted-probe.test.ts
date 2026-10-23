// `am shot`'s `painted` is vouched for only once the aio UI is MOUNTED.
//
// Right after a live reload the new document already runs rAFs, so the old
// probe (two rAFs, nothing else) answered `painted: true` before anything was
// rendered — and the capture was black. Measured against a real Chromium.
import "./store-sandbox.ts";
import { assert, assertEquals } from "@std/assert";
import { PAINTED_PROBE } from "../src/am/am-cmd-shot.ts";
import {
  chromiumPage,
  findChromium,
  launchChromium,
} from "../src/testing/chromium.ts";

const CHROME = findChromium();

Deno.test({
  name: "am shot: painted waits for the aio UI to mount, not just for rAFs",
  ignore: !CHROME,
  fn: async () => {
    const browser = await launchChromium(CHROME!, [
      "--remote-debugging-port=0",
      "about:blank",
    ]);
    const cdp = await chromiumPage(browser);
    try {
      const evalJs = (expression: string, awaitPromise = false) =>
        cdp.call("Runtime.evaluate", {
          expression,
          awaitPromise,
          returnByValue: true,
        }) as Promise<{ result?: { value?: unknown } }>;
      // A runtime with no `__aioMounted` (an older aio): load is enough.
      assertEquals((await evalJs(PAINTED_PROBE, true)).result?.value, true);

      // The page mid-reload: loaded, rAFs running, no root mounted yet.
      await evalJs(
        "globalThis.__n = 0; globalThis.__aioMounted = () => __n; " +
          "setTimeout(() => { __n = 1; globalThis.__at = Date.now(); }, 400)",
      );
      const r = await evalJs(
        `(${PAINTED_PROBE}).then(() => Date.now() - __at)`,
        true,
      );
      const after = r.result?.value as number;
      assert(
        typeof after === "number" && after >= 0,
        `vouched for a frame before the UI mounted (${JSON.stringify(r)})`,
      );

      // App never mounts — the shell's boot-failure card IS the UI. Waiting
      // the full timeout and blaming a hidden window was wrong: it paints now.
      await evalJs(
        "globalThis.__aioMounted = () => 0; const c = " +
          "document.createElement('div'); " +
          "c.dataset.aioBlankScreen = 'waiting for state'; " +
          "document.body.appendChild(c)",
      );
      // Without the card rule the probe NEVER resolves, so any finite bound
      // tells the two apart — a generous one: a 2 s bound on a CDP round trip
      // plus two frames failed under full-suite load.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const card = await Promise.race([
        evalJs(PAINTED_PROBE, true).then((x) => x.result?.value),
        new Promise((r) => timer = setTimeout(() => r("timeout"), 20_000)),
      ]).finally(() => clearTimeout(timer));
      assertEquals(card, true, "a boot-failure card counts as painted");
    } finally {
      await cdp.close();
      await browser.close();
    }
  },
});
