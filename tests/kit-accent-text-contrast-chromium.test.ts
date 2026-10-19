// Kit text drawn in the accent reads at WCAG AA on the themed page, resolved by
// a REAL cascade (headless Chromium).
//
// The theme has two accents: `--aio-accent` is the FILL (its ink is
// `--aio-on-accent`), `--aio-accent-ink` is the accent AS TEXT on the page. The
// kit painted the active tab's label and a Markdown link with the FILL — so an
// app whose identity hue lands on a light fill (measured: "kit-probe-hunt3",
// a pale green) showed its selected tab at 1.4:1 on white, in "tokens" and
// "auto" alike.
//
// Runs when a chromium/chrome binary is on the box; skipped (visibly)
// otherwise. Opt out with AIO_E2E=0.
import { assert } from "@std/assert";
import { appThemeCss } from "../src/build/app-theme.ts";
import { UI_CSS } from "../src/ui/styles.ts";
import { cdpConnect } from "../src/media/cdp.ts";
import { tempDir } from "../src/testing/temp-dir.ts";
import { testDisplayEnv } from "../src/testing/test-display.ts";
import { stopChild } from "./stop-child.ts";
import { browserOsFlags, findBrowser } from "./e2e-harness.ts";
import { browserHomeEnv } from "../src/testing/chromium.ts";

const BROWSER = findBrowser();

async function waitFor<T>(
  what: string,
  fn: () => Promise<T | null | undefined>,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn().catch(() => null);
    if (v !== null && v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timeout waiting for ${what}`);
}

/** Identity hues across the wheel, incl. the pale one that was measured. */
const APPS = ["kit-probe-hunt3", "notekeeper", "demo", "todo", "ops-panel"];

/** WCAG contrast of each probe's text colour on the page background. */
const MEASURE = `(() => {
  const cv = document.createElement("canvas").getContext("2d");
  const rgb = (c) => { cv.clearRect(0,0,1,1); cv.fillStyle = c; cv.fillRect(0,0,1,1); return [...cv.getImageData(0,0,1,1).data].slice(0,3); };
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126*f(c[0]) + 0.7152*f(c[1]) + 0.0722*f(c[2]); };
  const bg = rgb(getComputedStyle(document.body).backgroundColor);
  return [...document.querySelectorAll("[data-probe]")].map((e) => {
    const a = lum(rgb(getComputedStyle(e).color)), b = lum(bg);
    return [e.dataset.probe, (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)];
  });
})()`;

Deno.test({
  name:
    "kit (chromium): accent-coloured text (active tab, Markdown link) clears AA",
  ignore: BROWSER === null,
  sanitizeOps: false, // aio-ok(sanitizers): external browser, reaped in `finally`
  sanitizeResources: false, // aio-ok(sanitizers): same — the child outlives the check
  async fn() {
    const profile = await tempDir("aio-kit-accent-");
    const browser = new Deno.Command(BROWSER!, {
      args: [
        ...browserOsFlags,
        "--headless=new",
        "--no-sandbox",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--password-store=basic",
        "--use-mock-keychain",
        `--user-data-dir=${profile}`,
        "--remote-debugging-port=0",
        "about:blank",
      ],
      env: { ...browserHomeEnv(profile), ...testDisplayEnv() },
      stdin: "null",
      stdout: "null",
      stderr: "null",
    }).spawn();
    let cdp: Awaited<ReturnType<typeof cdpConnect>> | null = null;
    try {
      const wsUrl = await waitFor("devtools", async () => {
        const p = Number(
          (await Deno.readTextFile(`${profile}/DevToolsActivePort`))
            .split("\n")[0],
        );
        const targets = await (await fetch(`http://127.0.0.1:${p}/json`))
          .json() as { type: string; webSocketDebuggerUrl: string }[];
        return targets.find((t) => t.type === "page")?.webSocketDebuggerUrl;
      });
      cdp = await cdpConnect(wsUrl);
      const c = cdp;
      const js = async <T>(expression: string): Promise<T> => {
        const r = await c.call("Runtime.evaluate", {
          expression,
          returnByValue: true,
        }) as { result?: { value?: T }; exceptionDetails?: unknown };
        assert(!r.exceptionDetails, JSON.stringify(r.exceptionDetails));
        return r.result?.value as T;
      };
      const bad: string[] = [];
      let checked = 0;
      for (const scheme of ["light", "dark"] as const) {
        await c.call("Emulation.setEmulatedMedia", {
          features: [{ name: "prefers-color-scheme", value: scheme }],
        });
        for (const app of APPS) {
          const page = `<!doctype html><html><head>` +
            `<style>${appThemeCss(app)}</style><style>${UI_CSS}</style>` +
            `<style>*{transition:none!important}</style></head><body>` +
            `<button class="aio-tab aio-tab--active" data-probe="active tab">Alpha</button>` +
            `<a class="aio-md__a" href="#" data-probe="markdown link">link</a>` +
            `</body></html>`;
          await js(
            `document.open(); document.write(${
              JSON.stringify(page)
            }); document.close(); true`,
          );
          for (const [what, ratio] of await js<[string, number][]>(MEASURE)) {
            checked++;
            if (ratio < 4.5) {
              bad.push(`${what} · ${app} · ${scheme}: ${ratio.toFixed(2)}:1`);
            }
          }
        }
      }
      assert(checked === APPS.length * 2 * 2, `measured ${checked}`);
      assert(bad.length === 0, `below AA 4.5:1:\n  ${bad.join("\n  ")}`);
    } finally {
      await cdp?.close();
      await stopChild(browser, { quiet: true });
    }
  },
});
