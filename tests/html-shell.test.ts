// AIO-423: the HTML shell must ship a responsive `<meta viewport>` by
// default (mobile was broken by default — Chrome fell back to a 980px layout),
// overridable via ui.viewport, opt-out-able with `false`, plus a ui.head escape
// hatch for meta/OG/favicon/fonts.

import { assert, assertEquals } from "jsr:@std/assert";
import { generateHTML } from "../src/server/server-html-gen.ts";

const gen = (
  opts: { viewport?: string | false; head?: string; prod?: boolean } = {},
) =>
  generateHTML(
    "T",
    opts.prod ?? false,
    false,
    "{}",
    undefined,
    undefined,
    undefined,
    undefined,
    "App.tsx",
    opts.viewport,
    opts.head,
  );

Deno.test("html shell: responsive viewport is present by default (dev + prod)", () => {
  const want =
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">';
  assert(gen().includes(want), "dev shell has default viewport");
  assert(gen({ prod: true }).includes(want), "prod shell has default viewport");
});

Deno.test("html shell: ui.viewport overrides the content string", () => {
  const html = gen({ viewport: "width=1280" });
  assert(html.includes('<meta name="viewport" content="width=1280">'));
  assert(
    !html.includes("width=device-width"),
    "default viewport replaced, not duplicated",
  );
});

Deno.test("html shell: ui.viewport=false omits the tag (fixed-width opt-out)", () => {
  assertEquals(gen({ viewport: false }).includes('name="viewport"'), false);
});

Deno.test("html shell: ui.head injects verbatim <head> content", () => {
  const head =
    '<meta name="description" content="hello"><link rel="icon" href="/f.ico">';
  const html = gen({ head });
  assert(html.includes(head), "custom head content present verbatim");
});

// The dev browser was aio's most PERMISSIVE environment: every `__aioDev`
// tripwire in the isomorphic core (frozen state, readonly hints, hidden-field
// reads) was set only by the test harnesses, so a mutation that throws in a
// test quietly corrupted state in the browser you develop in. Dev sets it; prod
// must never, or a shipped app pays for dev-only checks.
Deno.test("html shell: dev sets __aioDev before any module, prod never does", () => {
  const dev = generateHTML("t", false, false, "{}");
  const prod = generateHTML("t", true, false, "{}");
  assert(dev.includes("window.__aioDev=true"), "dev shell arms the tripwires");
  assert(
    dev.indexOf("window.__aioDev=true") < dev.indexOf('<script type="module">'),
    "must run before the first module import",
  );
  assert(!prod.includes("__aioDev"), "prod shell stays clean");
});
