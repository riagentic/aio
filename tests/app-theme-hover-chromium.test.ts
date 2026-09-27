// The default theme's button states, resolved by a REAL cascade (headless
// Chromium) — not by reading the stylesheet text.
//
// Every base rule in src/build/app-theme.ts is `:where(…)` (0,0,0), but the
// generic `:where(button,…):hover:not(:disabled)` is (0,2,0). A variant hover
// that restates only box-shadow therefore LOST its fill to the grey hover:
// a hovered `.primary`/submit showed its white label on near-white (~1.1:1),
// and `.danger` did the same. A text-reading probe that took "no background in
// the hover rule" to mean "the accent survives" passed while the page broke.
//
// Asserted here for .primary, submit, .danger, submit.danger and the kit's
// `.aio-btn--*`, in light and dark, with and without the docs' rebrand recipe:
// hover / active / focus-visible keep the rest fill and label, a filled hover
// adds a ring, a disabled hover changes nothing.
//
// Runs when a chromium/chrome binary is on the box; skipped (visibly)
// otherwise. Opt out with AIO_E2E=0.
import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { appThemeCss } from "../src/build/app-theme.ts";
import { UI_CSS } from "../src/ui/styles.ts";
import { cdpConnect } from "../src/media/cdp.ts";
import { tempDir } from "../src/testing/temp-dir.ts";
import { testDisplayEnv } from "../src/testing/test-display.ts";
import { stopChild } from "./stop-child.ts";
import { findBrowser } from "./e2e-harness.ts";

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

/** id → markup. `fill` = a button whose fill must survive every state. */
const BUTTONS = [
  { id: "primary", html: `<button class="primary">x</button>`, fill: true },
  { id: "submit", html: `<button type="submit">x</button>`, fill: true },
  { id: "danger", html: `<button class="danger">x</button>`, fill: true },
  {
    id: "submitDanger",
    html: `<button type="submit" class="danger">x</button>`,
    fill: true,
  },
  { id: "plain", html: `<button>x</button>`, fill: false },
  { id: "ghost", html: `<button class="ghost">x</button>`, fill: false },
  ...(["primary", "danger"] as const).map((v) => ({
    id: `kit-${v}`,
    html: `<button class="aio-btn aio-btn--md aio-btn--${v}">x</button>`,
    fill: true,
  })),
  ...(["secondary", "ghost"] as const).map((v) => ({
    id: `kit-${v}`,
    html: `<button class="aio-btn aio-btn--md aio-btn--${v}">x</button>`,
    fill: false,
  })),
];

const REBRAND = ":root{--aio-accent:#6d5efc;--aio-on-accent:#fff}";

Deno.test({
  name:
    "theme (chromium): hover/active/focus keep a filled button's fill and label, both themes",
  ignore: BROWSER === null,
  sanitizeOps: false, // aio-ok(sanitizers): external browser, reaped in `finally`
  sanitizeResources: false, // aio-ok(sanitizers): same — the child outlives the check
  async fn() {
    const profile = await tempDir("aio-theme-hover-");
    const browser = new Deno.Command(BROWSER!, {
      args: [
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
      env: testDisplayEnv(),
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
      await c.call("DOM.enable");
      const page = (rebrand: boolean) =>
        `<!doctype html><html><head>` +
        `<style>${appThemeCss("hover-probe")}</style>` +
        `<style>${UI_CSS}</style>` +
        // Unlayered, and ONLY transitions: a computed style read mid-transition
        // is an in-between colour, not the state's.
        `<style>*{transition:none!important}${rebrand ? REBRAND : ""}</style>` +
        `</head><body>` +
        BUTTONS.map((b) => b.html.replace("<button", `<button id="${b.id}"`))
          .join("") +
        BUTTONS.map((b) =>
          b.html.replace("<button", `<button disabled id="${b.id}-off"`)
        ).join("") +
        `</body></html>`;
      type Look = { bg: string; color: string; shadow: string };
      const look = (id: string) =>
        js<Look>(
          `(() => { const s = getComputedStyle(document.getElementById(${
            JSON.stringify(id)
          })); return { bg: s.backgroundColor, color: s.color, shadow: s.boxShadow }; })()`,
        );
      const force = async (id: string, states: string[]) => {
        const { root } = await c.call("DOM.getDocument") as {
          root: { nodeId: number };
        };
        const { nodeId } = await c.call("DOM.querySelector", {
          nodeId: root.nodeId,
          selector: `#${id}`,
        }) as { nodeId: number };
        await c.call("CSS.forcePseudoState", {
          nodeId,
          forcedPseudoClasses: states,
        });
      };
      let checked = 0;
      for (const scheme of ["light", "dark"] as const) {
        await c.call("Emulation.setEmulatedMedia", {
          features: [{ name: "prefers-color-scheme", value: scheme }],
        });
        for (const rebrand of [false, true]) {
          await js(
            `document.open(); document.write(${
              JSON.stringify(page(rebrand))
            }); document.close(); true`,
          );
          await c.call("CSS.enable");
          const where = `${scheme}${rebrand ? " +rebrand" : ""}`;
          const surface2 = await js<string>(
            `(() => { const d = document.createElement("i"); d.style.background = "var(--aio-surface-2)"; document.body.append(d); const v = getComputedStyle(d).backgroundColor; d.remove(); return v; })()`,
          );
          for (const b of BUTTONS) {
            const rest = await look(b.id);
            for (
              const states of [["hover"], ["hover", "active"], [
                "focus",
                "focus-visible",
              ]]
            ) {
              await force(b.id, states);
              const got = await look(b.id);
              await force(b.id, []);
              const at = `${b.id} :${states.join(":")} (${where})`;
              assertEquals(got.color, rest.color, `${at}: label changed`);
              if (b.fill) {
                assertEquals(got.bg, rest.bg, `${at}: lost its fill`);
                assertNotEquals(got.bg, surface2, `${at}: grey hover won`);
                if (states[0] === "hover") {
                  assertNotEquals(got.shadow, rest.shadow, `${at}: no ring`);
                }
              }
              checked++;
            }
            const offRest = await look(`${b.id}-off`);
            await force(`${b.id}-off`, ["hover", "active"]);
            const offHover = await look(`${b.id}-off`);
            await force(`${b.id}-off`, []);
            assertEquals(offHover, offRest, `${b.id} disabled (${where})`);
            if (b.fill) {
              assertEquals(offRest.bg, rest.bg, `${b.id} disabled keeps fill`);
            }
          }
        }
      }
      assertEquals(checked, BUTTONS.length * 3 * 4);
    } finally {
      await cdp?.close();
      await stopChild(browser, { quiet: true });
    }
  },
});
