// `ui.layout` and `ui.dir` must reach the target the app is actually shipped
// on, not only the dev server.
//
// Both were declared, accepted, threaded partway and then dropped:
//
//   ui.dir     `HtmlShellOptions.dir` was declared and `server-static.ts`
//              passed it — and `generateHTML` called `prodHTML(head, o.lang)`
//              and `aioDevHTML(head, …, o.lang)`, dropping it. So it reached
//              NO target: dev, prod and the packaged shell all served
//              `<html lang="ar">` with no `dir`. `htmlOpen`'s own comment
//              says "one attribute flips the whole default UI — that is the
//              entire point of having spent the CSS that way", and
//              `tests/rtl-logical-css.test.ts` checks the stylesheets for
//              physical properties without ever rendering a shell.
//
//   ui.layout  `aio-lifecycle.ts` SET it on the Electron shell object;
//              `ShellConfig` had no field for it and `udsProdHTML` never
//              forwarded it. Type-checking said nothing because the object was
//              an un-annotated const spread into the call, which turns
//              excess-property checking off. Measured: `{ theme: "full",
//              layout: false }` served 11458 bytes of HTML and packaged 13470
//              — the framework's `.row`/`.stack`/`.grid`/`.muted` inside the
//              app that declined them.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { closeWindow } from "../src/testing/close-window.ts";
import { generateHTML } from "../src/server/server-html-gen.ts";
import { udsProdHTML } from "../src/electron/electron-shared.ts";

const LAYOUT_MARKERS = [".row", ".stack", ".grid", ".muted"];

Deno.test("ui.dir: every generator writes it on <html>", () => {
  for (const prod of [true, false]) {
    const html = generateHTML({
      title: "RTL",
      prod,
      hasCSS: false,
      importMap: "",
      lang: "ar",
      dir: "rtl",
    });
    assertStringIncludes(
      html,
      'dir="rtl"',
      `the ${prod ? "prod" : "dev"} shell dropped ui.dir`,
    );
    assertStringIncludes(html, 'lang="ar"');
  }
  // …and the packaged Electron shell, which templates its own HTML.
  const shell = udsProdHTML("RTL", false, { lang: "ar", dir: "rtl" });
  assertStringIncludes(shell, 'dir="rtl"', "the Electron shell dropped ui.dir");
});

Deno.test("ui.layout: the packaged Electron shell drops the layout defaults too", () => {
  const served = generateHTML({
    title: "My App",
    prod: true,
    hasCSS: false,
    importMap: "",
    theme: "full",
    layout: false,
    themeName: "myapp",
  });
  const packaged = udsProdHTML("My App", false, {
    theme: "full",
    layout: false,
    themeName: "myapp",
  });
  for (const marker of LAYOUT_MARKERS) {
    assertEquals(
      served.includes(marker),
      false,
      `the server shell must not emit ${marker} under layout:false`,
    );
    assertEquals(
      packaged.includes(marker),
      false,
      `…and neither must the packaged one — an app cannot be laid out ` +
        `differently inside its own AppImage than under \`deno task dev\``,
    );
  }
  // The theme itself is still there — `layout` is the orthogonal half.
  assertStringIncludes(packaged, "--aio-accent");
});

Deno.test("ui.layout: true still emits the layout defaults on both", () => {
  // The other direction, so the test above cannot pass by emitting nothing.
  const served = generateHTML({
    title: "My App",
    prod: true,
    hasCSS: false,
    importMap: "",
    theme: "full",
    themeName: "myapp",
  });
  const packaged = udsProdHTML("My App", false, {
    theme: "full",
    themeName: "myapp",
  });
  for (const html of [served, packaged]) {
    assert(
      LAYOUT_MARKERS.some((m) => html.includes(m)),
      "an app that did NOT decline the layout must still get it",
    );
  }
});

// ── the packaged APK shell, which learns its config at BOOT ──────────────────
//
// An APK's shell is written before `aio.run()` exists, so `ui.theme`,
// `ui.layout` and `ui.dir` cannot be baked into it. They travel with the
// bundle and `_applyShellUi` applies them on the first tick. Three of the four
// were not applied at all:
//
//   theme:"none"  the shell's always-on tokens sheet stayed, so the app that
//                 asked for "no aio CSS on the page at all… not even the
//                 two-rule box-model baseline" got `*{box-sizing:border-box}`.
//   layout:false  one deferred sheet meant the APK always enabled the
//                 full-layout variant.
//   dir           never applied anywhere.
Deno.test("android shell: theme/layout/dir are applied at boot", async () => {
  const { Window } = await import("happy-dom");
  const { _applyShellUi } = await import("../src/standalone-air.ts");
  const { androidLocalHTML } = await import(
    "../src/server/server-html-gen.ts"
  );
  const shellHtml = androidLocalHTML("My App", false, { themeName: "myapp" });

  // deno-lint-ignore no-explicit-any
  const run = (ui: Record<string, unknown>): any => {
    const win = new Window({ url: "http://localhost/" });
    // deno-lint-ignore no-explicit-any
    const doc = win.document as any;
    doc.documentElement.innerHTML = shellHtml
      .replace(/^[\s\S]*?<head>/, "<head>")
      .replace(/<\/html>\s*$/, "");
    const origDoc = (globalThis as Record<string, unknown>).document;
    Object.defineProperty(globalThis, "document", {
      get: () => doc,
      configurable: true,
    });
    try {
      _applyShellUi(ui);
      return {
        html: String(doc.documentElement.outerHTML),
        dir: doc.documentElement.getAttribute("dir"),
        win,
      };
    } finally {
      if (origDoc === undefined) {
        // deno-lint-ignore no-explicit-any
        delete (globalThis as any).document;
      } else {
        Object.defineProperty(globalThis, "document", {
          get: () => origDoc,
          configurable: true,
        });
      }
    }
  };

  // theme:"none" — nothing of aio's own is left on the page.
  const none = run({ theme: "none" });
  assertEquals(
    /box-sizing:\s*border-box/.test(none.html),
    false,
    '`theme: "none"` must take the box-model baseline away too — that is ' +
      "the switch for bringing an existing stylesheet",
  );
  assertEquals(/--aio-accent/.test(none.html), false, "…and the tokens");
  await closeWindow(none.win);

  // layout:false with a full theme — the look, without the page layout.
  const noLayout = run({ theme: "full", layout: false });
  const live = noLayout.html.replace(
    /<style media="not all"[\s\S]*?<\/style>/g,
    "",
  );
  for (const marker of LAYOUT_MARKERS) {
    assertEquals(
      live.includes(marker),
      false,
      `the APK must not enable ${marker} for an app that declined the layout`,
    );
  }
  assert(live.includes("--aio-accent"), "…while keeping the theme itself");
  await closeWindow(noLayout.win);

  // dir — the one that reached no target at all.
  const rtl = run({ theme: "full", dir: "rtl" });
  assertEquals(rtl.dir, "rtl", "ui.dir must reach the APK's <html> too");
  await closeWindow(rtl.win);
});
