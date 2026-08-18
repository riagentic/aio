// `ui.chrome` — how much of the desktop window the OS draws.
//
// Three modes, and the load-bearing property is that "themed" gives back
// everything dropping the OS frame takes away: a drag region, the three window
// verbs, and double-click-to-maximise. The shell and the Electron window must
// AGREE about which mode is active — a frameless window whose page draws no
// title bar is an app you cannot move or close.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { generateHTML } from "../src/server/server-html-gen.ts";
import { electronMainScriptUDS } from "../src/electron/electron-uds.ts";
import { udsPreloadScript } from "../src/electron/electron-shared.ts";
import { VALID_UI_KEYS, validateConfig } from "../src/server/config.ts";

const shell = (chrome?: "standard" | "themed" | "none") =>
  generateHTML(
    "Demo",
    true,
    false,
    "",
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    chrome,
  );

Deno.test("chrome: only themed adds a title bar to the shell", () => {
  assertEquals(shell(undefined).includes("aio-titlebar"), false);
  assertEquals(shell("standard").includes("aio-titlebar"), false);
  assertEquals(shell("none").includes("aio-titlebar"), false);
  assertStringIncludes(shell("themed"), "aio-titlebar");
});

Deno.test("chrome: the themed bar is draggable, its buttons are not", () => {
  const html = shell("themed");
  assertStringIncludes(html, "-webkit-app-region:drag");
  assertStringIncludes(html, "-webkit-app-region:no-drag");
  for (const verb of ["minimize", "maximize", "close"]) {
    assertStringIncludes(html, `data-act="${verb}"`);
  }
});

Deno.test("chrome: the themed bar is restylable by the app", () => {
  const html = shell("themed");
  // Named hooks, not inline styles — an app that wants its own colours must be
  // able to get them from its own stylesheet with no framework involvement.
  for (
    const hook of [
      ".aio-titlebar{",
      ".aio-titlebar-title{",
      ".aio-titlebar-button{",
      "--aio-titlebar-height",
      "--aio-titlebar-bg",
      "--aio-titlebar-fg",
    ]
  ) {
    assertStringIncludes(html, hook);
  }
});

Deno.test("chrome: the bar removes itself where there is no window", () => {
  // The same shell is served to a browser tab. Three dead buttons there would
  // be worse than no bar at all, so mounting is gated on the bridge existing.
  assertStringIncludes(shell("themed"), "if(!window.__aioWindow");
});

Deno.test("chrome: the Electron window frame follows the mode", () => {
  const script = (chrome?: "standard" | "themed" | "none") =>
    electronMainScriptUDS("http://127.0.0.1:1/", "/tmp/s.sock", {
      meta: { chrome },
    });
  assertStringIncludes(script(undefined), "b.frame = true");
  assertStringIncludes(script("standard"), "b.frame = true");
  assertStringIncludes(script("themed"), "b.frame = false");
  assertStringIncludes(script("none"), "b.frame = false");
});

Deno.test("chrome: the window verbs exist on both ends of the bridge", () => {
  const preload = udsPreloadScript();
  assertStringIncludes(preload, "__aioWindow");
  const main = electronMainScriptUDS("http://127.0.0.1:1/", "/tmp/s.sock", {
    meta: { chrome: "themed" },
  });
  for (const verb of ["minimize", "maximize", "close"]) {
    assertStringIncludes(preload, verb);
    assertStringIncludes(main, verb);
  }
  // "none" gets the bridge too: an app drawing its own bar needs the verbs.
  assertStringIncludes(
    electronMainScriptUDS("http://127.0.0.1:1/", "/tmp/s.sock", {
      meta: { chrome: "none" },
    }),
    "__aio:win",
  );
});

Deno.test("chrome: a misspelled VALUE is refused, not defaulted", () => {
  let code: number | null = null;
  const exit = ((c: number) => {
    code = c;
    throw new Error("exit");
  }) as (c: number) => never;
  assertEquals(
    (() => {
      try {
        validateConfig({ chrome: "themed" }, VALID_UI_KEYS, "ui", exit);
        return "ok";
      } catch {
        return "refused";
      }
    })(),
    "ok",
  );
  try {
    validateConfig({ chrome: "Themed" }, VALID_UI_KEYS, "ui", exit);
  } catch { /* the exit stub throws */ }
  assert(code === 1, "a bad chrome value must fail the boot, not fall back");
});
