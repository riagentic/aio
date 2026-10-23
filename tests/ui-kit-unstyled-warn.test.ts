// A field report: `<Menu>` drew its items inline and `<Button>` looked bare —
// the app never mounted `<UiStyles/>`, and nothing said so. Dev now says it
// once per page; it stays quiet under SSR (no document), when `<UiStyles/>` is
// on the page, and when the app's own CSS styles the kit class.
import { assert, assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import { Button } from "../src/ui/mod.ts";
import { Switch } from "../src/ui/controls.ts";
import { _resetKitStylesCheck, UI_CSS } from "../src/ui/styles.ts";

type G = Record<string, unknown>;

/** Render `make` with dev on and `document` = a page whose head holds `css`
 *  (null: no document at all, as under SSR); every kit line it printed. */
async function kitWarnings(
  css: string | null,
  make: () => unknown,
  dev = true,
): Promise<string[]> {
  const g = globalThis as G;
  const prev = { doc: g.document, dev: g.__aioDev };
  const win = css === null ? null : new Window({ url: "https://app.test/" });
  if (win) {
    win.document.head.innerHTML = css ?? "";
    g.document = win.document;
  } else delete g.document;
  g.__aioDev = dev;
  const warns: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => warns.push(a.map(String).join(" "));
  _resetKitStylesCheck();
  try {
    make();
    make(); // a second render must not say it twice
    // Checked once the page has loaded (its style.css too) — happy-dom is
    // still "interactive" here, as a real page is while its bundle runs.
    assertEquals(warns.length, 0, "said before the page loaded");
    win?.dispatchEvent(new win.Event("load"));
    await new Promise((r) => setTimeout(r, 0));
  } finally {
    console.warn = orig;
    g.document = prev.doc;
    g.__aioDev = prev.dev;
    if (win) await closeWindow(win);
  }
  return warns.filter((w) => w.includes("styles the kit"));
}

const button = () => Button({ children: "Go" });

Deno.test("kit: no UiStyles and no kit CSS → one dev line naming the fix", async () => {
  const w = await kitWarnings("", button);
  assertEquals(w.length, 1, w.join("\n"));
  assert(w[0]!.includes("<UiStyles/>") && w[0]!.includes('"aio-btn"'), w[0]);
  // CSS for some OTHER aio class (the themed title bar) does not style the kit.
  const other = await kitWarnings("<style>.aio-titlebar{}</style>", button);
  assertEquals(other.length, 1, other.join("\n"));
  // controls.ts components route through the same check.
  const s = await kitWarnings("", () => Switch({ checked: false }));
  assertEquals(s.length, 1, s.join("\n"));
});

Deno.test("kit: quiet with <UiStyles/>, with the app's own kit CSS, under SSR, in prod", async () => {
  assertEquals(
    await kitWarnings(`<style data-aio-ui>${UI_CSS}</style>`, button),
    [],
  );
  assertEquals(
    await kitWarnings(
      "<style>@media screen { .aio-btn { color: red } }</style>",
      button,
    ),
    [],
  );
  assertEquals(await kitWarnings(null, button), []);
  assertEquals(await kitWarnings("", button, false), []);
});
