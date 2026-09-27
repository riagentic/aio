// Bug hunt r10 (ui): the packaged/standalone shell decides `ui.theme: "auto"`
// with a different question than the server does.
//
// Server (server-html-gen.ts headContent): `"auto"` steps aside only when the
// app ships `style.css` (`hasCSS`). Standalone (standalone-air.ts
// `_applyShellUi`) claims "the same rule the server shell applies" but asks
// `document.querySelector('link[rel="stylesheet"]')` — ANY stylesheet link.
// A `ui.head` web-font link (`<link rel="stylesheet" href="https://fonts…">`,
// the example `ui.head` exists for) therefore turns the default look OFF in
// the standalone shell while the server shell for the same config paints it.
import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { _applyShellUi } from "../src/standalone-air.ts";
import {
  androidLocalHTML,
  generateHTML,
} from "../src/server/server-html-gen.ts";
import { closeWindow } from "../src/testing/close-window.ts";

const FONT =
  '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">';

Deno.test('ui.theme "auto" + a ui.head font stylesheet: standalone paints the look exactly as the server does', async () => {
  // The server: no style.css → the full look, font link or not.
  const server = generateHTML({
    title: "My App",
    prod: true,
    hasCSS: false,
    importMap: "",
    theme: "auto",
    themeName: "myapp",
    headExtra: FONT,
  });
  assertEquals(server.includes("── canvas"), true, "server paints the look");

  // The standalone shell for the same app (no style.css, same ui.head).
  const shell = androidLocalHTML("My App", false, {
    themeName: "myapp",
    head: FONT,
  });
  const win = new Window({ url: "http://localhost/" });
  // deno-lint-ignore no-explicit-any
  const doc = win.document as any;
  doc.documentElement.innerHTML = shell
    .replace(/^[\s\S]*?<head>/, "<head>")
    .replace(/<\/html>\s*$/, "");
  const g = globalThis as Record<string, unknown>;
  const had = Object.getOwnPropertyDescriptor(g, "document");
  Object.defineProperty(g, "document", { get: () => doc, configurable: true });
  try {
    _applyShellUi({ theme: "auto" });
    const deferred = doc.querySelector("style[data-aio-theme-deferred]");
    assertEquals(
      deferred?.getAttribute("media") ?? null,
      null,
      'standalone must enable the full look for "auto" with no style.css — ' +
        "a font <link> is not the app's stylesheet",
    );
  } finally {
    if (had) Object.defineProperty(g, "document", had);
    else delete g.document;
    await closeWindow(win);
  }
});
