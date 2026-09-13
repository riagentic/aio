// `docs/ui/air-components.md` said `false` removes `aria-*` too —
// "`<button aria-pressed={false}>` renders `<button>`". The renderer has
// written `aria-pressed="false"` since the fix pinned by
// tests/aria-false-is-a-value.test.ts, because in ARIA "false" is a value (an
// absent aria-pressed means "not a toggle button"). The doc told readers to
// work around behaviour that no longer existed — and, read literally, that
// `aria-expanded={open}` was unsafe.
//
// Each "`<jsx>` renders `<html>`" sentence in that section is now checked
// against BOTH renderers, so the prose cannot drift from the code again.
import { assert, assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import { h, renderToString } from "../src/air/vdom.ts";
import { _setDocument, _unmount, mount } from "../src/air/aio-renderer.ts";

/** `<tag attr={false}>` → [tag, attr] — the only JSX shape the section uses. */
function parseJsx(jsx: string): [string, Record<string, unknown>] {
  const m = /^<(\w+) ([\w-]+)=\{(false|null|undefined)\}>$/.exec(jsx);
  assert(m, `unrecognised JSX in the doc claim: ${jsx}`);
  const v = m[3] === "false" ? false : m[3] === "null" ? null : undefined;
  return [m[1]!, { [m[2]!]: v }];
}

Deno.test("air-components: every `false`-attribute render claim matches both renderers", async () => {
  const md = await Deno.readTextFile(
    new URL("../docs/ui/air-components.md", import.meta.url),
  );
  const start = md.indexOf("### `false` removes an attribute");
  assert(start >= 0, "the section is still there");
  const section = md.slice(start, md.indexOf("\n### ", start + 1));
  const claims = [
    ...section.replace(/\s+/g, " ").matchAll(
      /`(<[^`]+>)` renders `(<[^`]+>)`/g,
    ),
  ];
  assert(
    claims.some((c) => c[1]!.includes("aria-")),
    "the section states what an aria-* false renders",
  );

  const win = new Window({ url: "http://localhost/" });
  // deno-lint-ignore no-explicit-any
  const doc = win.document as any;
  _setDocument(doc);
  try {
    for (const [, jsx, claimed] of claims) {
      const [tag, props] = parseJsx(jsx!);
      const ssr = renderToString(h(tag, props));
      assertEquals(ssr, `${claimed}</${tag}>`, `SSR of ${jsx}`);
      const root = doc.createElement("div");
      doc.body.appendChild(root);
      const handle = mount(root, (() => h(tag, props)) as never);
      assertEquals(root.innerHTML, `${claimed}</${tag}>`, `DOM of ${jsx}`);
      _unmount(handle);
    }
  } finally {
    _setDocument(null as never);
    await closeWindow(win);
  }
});
