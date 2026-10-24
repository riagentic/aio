// `<Browser>` where no `<webview>` tag exists (no electron.webviewTag /
// childWindows, or a browser tab) rendered an empty box and said nothing
// (R9-hw). It says so once per page, naming the option. (Its own file: the
// once-per-page flag is module state.)
import { assertEquals, assertStringIncludes } from "@std/assert";
import { h } from "../src/air/vdom.ts";
import { testUI } from "../src/testing/ui-test.ts";
import { Browser } from "../src/ui/browser.ts";

Deno.test("<Browser> without a <webview> tag warns once, naming electron.webviewTag", async () => {
  const warns: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => warns.push(a.join(" "));
  try {
    const ui = await testUI(() =>
      h(
        "div",
        null,
        h(Browser, { src: "https://a.test/" }),
        h(Browser, { src: "https://b.test/" }),
      )
    );
    try {
      await ui.settle();
    } finally {
      await ui.dispose();
    }
  } finally {
    console.warn = orig;
  }
  const said = warns.filter((w) => w.includes("<Browser> renders nothing"));
  assertEquals(said.length, 1, warns.join("\n"));
  assertStringIncludes(said[0]!, "electron: { webviewTag: true }");
});
