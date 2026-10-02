// The SSR raw-text guard (`rawTextContent`) refuses exactly what would end a
// <script>/<style> early, and nothing an HTML parser reads as plain text.
//
// The verdicts below were taken from a real HTML parser (parse5) for
// `<tag>TEXT</tag>`: "ends" = the element's text came back shorter than TEXT.
// `</ script>` is text — the tokenizer needs the tag name right after `</` —
// and a guard that also refused it threw in dev and, in production,
// HTML-escaped a whole working script.
//
// The guard judges the element's WHOLE content: the parser reads one run of
// characters, so a closing tag split over two children ends the element like
// one written whole. And a `<script>` has a second way to lose its end:
// `<!--` then `<script` leaves the tokenizer "double escaped", where the
// element's own `</script>` no longer closes it.
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { Window } from "happy-dom";
import { rawTextContent } from "../src/air/ssr-utils.ts";
import { generateHTML } from "../src/server/server-html-gen.ts";
import { h } from "../src/air/vdom-create.ts";
import { ErrorBoundary, Fragment } from "../src/air/vdom.ts";
import { renderToString } from "../src/air/vdom-ssr.ts";
import { renderToStream } from "../src/air/ssr-stream.ts";
import { setDevModeOverride } from "../src/state/dev-flag.ts";
import { closeWindow } from "../src/testing/close-window.ts";

const refused = (tag: string, text: string): boolean => {
  try {
    return rawTextContent(tag, text, true) !== text;
  } catch {
    return true;
  }
};

for (const tag of ["script", "style"]) {
  const T = tag.toUpperCase();
  // [text, refused] — every "ends" verdict of the parser must be refused.
  const cases: [string, boolean][] = [
    [`a</${tag}>b`, true],
    [`a</${T}>b`, true],
    [`a</${tag[0]}${T.slice(1)}>b`, true],
    [`a</${tag} b`, true],
    [`a</${tag}\tb`, true],
    [`a</${tag}\nb`, true],
    [`a</${tag}/b`, true],
    // Text to a parser on its own, but the next child may supply the `>`.
    [`a</${tag}`, true],
    // Not an end tag; refused since the guard first shipped, kept that way.
    [`a</${tag}x>b`, true],
    // Plain text to a parser — must pass untouched.
    [`a</ ${tag}>b`, false],
    [`a</\t${tag}>b`, false],
    [`a</\n${tag}>b`, false],
    [`a</s${tag}>b`, false],
    [`a<${tag}>b`, false],
    [`a<\\/${tag}>b`, false],
    [`if (a < b && c > d) x = "</div>"`, false],
  ];
  for (const [text, want] of cases) {
    Deno.test(`raw text <${tag}>: ${JSON.stringify(text)} is ${want ? "refused" : "passed"}`, () => {
      assertEquals(refused(tag, text), want);
      if (!want) {
        // Dev and production agree, and neither touches the text.
        assertEquals(rawTextContent(tag, text, true), text);
        assertEquals(rawTextContent(tag, text, false), text);
      }
    });
  }

  Deno.test(`raw text <${tag}>: the refusal's hint is not the text it forbids`, () => {
    const err = assertThrows(
      () => rawTextContent(tag, `x</${tag}>`, true),
      Error,
      `contains a literal "</${tag}"`,
    );
    const hint = /\(e\.g\. "([^"]+)"\)/.exec(err.message)?.[1];
    assertEquals(hint, `<\\/${tag}`);
    // The advice must itself pass the guard.
    assertEquals(refused(tag, hint!), false);
  });
}

// The same eaten backslash, in the page shell's own refusal: the rule it
// printed (`/^[w./-]+.(ts|tsx)$/`) was not the rule it enforces.
Deno.test("ui.entry refusal prints the pattern it tests", () => {
  const err = assertThrows(
    () =>
      generateHTML(
        {
          title: "t",
          prod: false,
          importMap: "{}",
          uiEntry: "a b.ts",
        } as Parameters<
          typeof generateHTML
        >[0],
      ),
    Error,
    'invalid ui.entry "a b.ts"',
  );
  assertEquals(
    /must match (\S+)/.exec(err.message)?.[1],
    String.raw`/^[\w./-]+\.(ts|tsx)$/`,
  );
});

// ── The whole content is judged, not each child ────────────────────────────

type Child = string | number | ReturnType<typeof h>;
const Slash = () => h(Fragment, null, "/script");
const Boom = (): never => {
  throw new Error("boom");
};

/** The three writers that emit a raw-text element, each handed `el()` as the
 *  element under a `<div>` that a `<p>` follows. */
const WRITERS: [string, (el: () => Child) => Promise<string>][] = [
  [
    "renderToString",
    (el) =>
      Promise.resolve().then(() =>
        renderToString(h("div", null, el(), h("p", null, "after")))
      ),
  ],
  ["renderToStream", async (el) => {
    let out = "";
    for await (
      const c of renderToStream(h("div", null, el(), h("p", null, "after")))
    ) out += c;
    return out;
  }],
  // A boundary's fallback is written by the stream's synchronous twin.
  ["renderToStream (sync subtree)", async (el) => {
    let out = "";
    const tree = h(
      "div",
      null,
      h(ErrorBoundary, { fallback: () => el() }, h(Boom, null)),
      h("p", null, "after"),
    );
    for await (const c of renderToStream(tree)) out += c;
    return out;
  }],
];

/** What a real HTML parser makes of `html`: the text of its first `tag`, and
 *  how many `<p>` and `<img>` it found. */
async function parsed(tag: string, html: string) {
  const w = new Window();
  try {
    const doc = new w.DOMParser().parseFromString(
      `<!doctype html><html><head></head><body>${html}</body></html>`,
      "text/html",
    );
    return {
      text: doc.querySelector(tag)?.textContent,
      p: doc.querySelectorAll("p").length,
      img: doc.querySelectorAll("img").length,
    };
  } finally {
    await closeWindow(w);
  }
}

// [tag, children, ends] — `ends`: the parser closes the element inside the
// joined text. Asserted against happy-dom's parser below, so the column
// cannot drift from what a parser does (parse5 7 and Chromium 153 agree).
const SPLIT: [string, Child[], boolean][] = [
  ["script", ['{"a":"</scr', 'ipt><img src=x>"}'], true],
  ["script", ["x = a <", "/script><img src=x>"], true],
  ["script", ["x = a </", "script><img src=x>"], true],
  ["script", ["x = a </script", "><img src=x>"], true],
  ["script", ["a</scr", "", "ipt><img src=x>"], true],
  ["script", ["a</", 5, "cript>b"], false],
  ["script", ["a</scr", "x", "ipt>b"], false],
  ["style", ['.a::after{content:"<', '/style><img src=x>"}'], true],
  ["style", ["a{}</sty", "le ><img src=x>"], true],
  ["style", ["a{}</sty", "x", "le>b"], false],
];

for (const [tag, children, ends] of SPLIT) {
  const text = children.join("");
  const el = () => h(tag, null, ...children);
  Deno.test(`raw text <${tag}> split as ${JSON.stringify(children)}: ${ends ? "refused" : "passed"} by every writer`, async () => {
    const raw = await parsed(tag, `<${tag}>${text}</${tag}><p>after</p>`);
    assertEquals(raw.text !== text, ends, "the parser's own verdict");
    for (const [name, write] of WRITERS) {
      setDevModeOverride(true);
      try {
        if (ends) {
          await assertRejects(() => write(el), Error, `</${tag}`, name);
        } else {
          assertEquals(
            await write(el),
            `<div><${tag}>${text}</${tag}><p>after</p></div>`,
            name,
          );
        }
      } finally {
        setDevModeOverride(null);
      }
      // Production: the same verdict, and nothing leaves the element.
      setDevModeOverride(false);
      const realError = console.error;
      let said = 0;
      console.error = () => void said++;
      try {
        const out = await write(el);
        const got = await parsed(tag, out);
        assertEquals([got.p, got.img], [1, 0], `${name}: ${out}`);
        assertEquals(said, ends ? 1 : 0, `${name}: said once, loudly`);
        if (!ends) assertEquals(got.text, text, name);
      } finally {
        console.error = realError;
        setDevModeOverride(null);
      }
    }
  });
}

Deno.test("raw text: a component child's output is part of the judged content", async () => {
  // `<` + a component that renders `/script` + `>` is a closing tag.
  const el = () => h("script", null, "a<", h(Slash, null), ">b");
  const made = await parsed("script", "<script>a</script>b</script>");
  assertEquals(made.text, "a", "the parser ends the element there");
  for (const [name, write] of WRITERS) {
    setDevModeOverride(true);
    try {
      await assertRejects(() => write(el), Error, "</script", name);
    } finally {
      setDevModeOverride(null);
    }
  }
});

Deno.test("raw text: the stream sends no child before the whole content is judged", async () => {
  setDevModeOverride(true);
  const sent: string[] = [];
  try {
    await assertRejects(
      async () => {
        for await (
          const c of renderToStream(h("script", null, "FIRST</scr", "ipt>"))
        ) sent.push(c);
      },
      Error,
      "</script",
    );
  } finally {
    setDevModeOverride(null);
  }
  assert(!sent.join("").includes("FIRST"), `already sent: ${sent.join("")}`);
});

// ── <script>: "<!--" then "<script" ────────────────────────────────────────
//
// [text, swallows] — `swallows`: the element's own `</script>` does not end
// it, and the script takes the rest of the page. happy-dom's parser does not
// implement the "script data double escaped" states, so these verdicts are
// written down: measured with parse5 7.3 and Chromium 153's DOMParser on
// `<script>TEXT</script><p>`, which agree on every row.
const DOUBLE: [string, boolean][] = [
  ["a<!--<script>b", true],
  ["a<!-- <script b", true],
  ["a<!--<SCRIPT>b", true],
  ["a<!--<script/b", true],
  ["a<!--<script\tb", true],
  ["a<!--<script\nb", true],
  ["a<!--<script\fb", true],
  ["a<!--<script\rb", true],
  ["a<!--x--><!--<script>b", true],
  ["a<!--<script>-->x<!--<script>", true],
  ["a<!--<script>b--!>c", true],
  ["a<!--<script>b- ->c", true],
  ["a<!--<a<script>b", true],
  ["a<!--</<script>b", true],
  ["a<!--<script>b<", true],
  ["a<!--<script>b</scrip", true],
  // Closed again by `-->`, never opened, or not the tag name: plain text.
  ["a<!--<script>b-->c", false],
  ["a<!--<script>b--->c", false],
  ["a<!--<script>-->x<!--", false],
  ["a<!--><script>b", false],
  ["a<!---><script>b", false],
  ["a<!--<scriptx>b", false],
  ["a<!--<scrip>b", false],
  ["a<!--<script", false],
  ["a<!- -<script>b", false],
  ["a<script>b<!--c", false],
  ["a<script>b", false],
  ["a<!--b", false],
];

for (const [text, swallows] of DOUBLE) {
  Deno.test(`raw text <script>: ${JSON.stringify(text)} is ${swallows ? "refused" : "passed"}`, () => {
    assertEquals(refused("script", text), swallows);
    // A <style> has no such state: the same text is plain text there.
    assertEquals(rawTextContent("style", text, true), text);
    if (!swallows) assertEquals(rawTextContent("script", text, false), text);
  });
}

Deno.test("raw text <script>: the double-escape shape is judged over the joined children", async () => {
  const el = () =>
    h("script", { type: "application/json" }, '{"bio":"<!', "--<scr", 'ipt>"}');
  for (const [name, write] of WRITERS) {
    setDevModeOverride(true);
    try {
      await assertRejects(() => write(el), Error, '"<!--" and then', name);
    } finally {
      setDevModeOverride(null);
    }
    setDevModeOverride(false);
    const realError = console.error;
    let said = 0;
    console.error = () => void said++;
    try {
      const out = await write(el);
      assert(!out.includes("<!--"), `${name}: ${out}`);
      assertEquals(said, 1, name);
    } finally {
      console.error = realError;
      setDevModeOverride(null);
    }
  }
});

Deno.test("raw text <script>: every spelling the double-escape refusal offers passes the guard", () => {
  const err = assertThrows(
    () => rawTextContent("script", "a<!--<script>b", true),
    Error,
    "swallows the rest of the page",
  );
  const hints = [...err.message.matchAll(/"([^"]*!--)"/g)].map((m) => m[1]!)
    .filter((x) => x !== "<!--");
  assertEquals(hints, ["<\\!--", "\\x3C!--", "\\u003C!--"]);
  for (const open of hints) {
    assertEquals(refused("script", `a${open}<script>b`), false, open);
  }
});
