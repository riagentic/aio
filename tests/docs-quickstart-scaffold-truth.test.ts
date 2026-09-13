// The quickstart's "deno.json (what `am create` generates)" block is a claim
// about one command's output, and it had drifted from it on every axis a
// reader copies: `"version": "0.1.0"` where create writes `"0.1"` (a third
// part pins the build number), an `electron` mapping a browser app never gets,
// `^` ranges where the pinned framework's exact versions go, five entries and
// two tasks missing. Hand-wiring from that block produced an app `am doctor`
// then had to correct. So the block is compared with what create writes:
// `scaffold()`'s deno.json, plus the two things create adds after it — the
// `aioVersion` pin and the framework's exact dep versions (`syncFrameworkDeps`).
import { assert, assertEquals, assertMatch } from "@std/assert";
import { scaffold } from "../src/am/am-cmd-create.ts";
import { FRAMEWORK_DEPS } from "../src/am/am-versions.ts";

const ROOT = new URL("../", import.meta.url).pathname;
const read = (rel: string) => Deno.readTextFile(ROOT + rel);

/** The first fenced block of `lang` after `heading`. */
function blockAfter(doc: string, heading: string, lang: string): string {
  const at = doc.indexOf(heading);
  assert(at >= 0, `quickstart lost its "${heading}" section`);
  const open = doc.indexOf("```" + lang + "\n", at);
  assert(open >= 0, `no \`\`\`${lang} block after "${heading}"`);
  const start = open + lang.length + 4;
  return doc.slice(start, doc.indexOf("\n```", start));
}

Deno.test("quickstart: the generated deno.json block is what `am create my-app` writes", async () => {
  const qs = await read("docs/basics/quickstart.md");
  const shown = JSON.parse(
    blockAfter(qs, "### deno.json (what `am create` generates)", "json"),
  ) as Record<string, unknown> & { imports: Record<string, string> };

  const written = JSON.parse(
    scaffold("my-app", "counter", true)["deno.json"]!,
  ) as Record<string, unknown> & { imports: Record<string, string> };
  const framework = JSON.parse(await read("deno.json")) as {
    imports: Record<string, string>;
  };
  for (const dep of FRAMEWORK_DEPS) {
    if (dep in written.imports && framework.imports[dep]) {
      written.imports[dep] = framework.imports[dep];
    }
  }

  assertMatch(
    String(shown.aioVersion),
    /^v\d+\.\d+\.\d+/,
    "create records the pin as aioVersion",
  );
  const { aioVersion: _pin, ...rest } = shown;
  assertEquals(rest, written);
});

Deno.test("quickstart: 'What you got' lists every file create writes", async () => {
  const qs = await read("docs/basics/quickstart.md");
  const tree = blockAfter(qs, "## What you got", "");
  const listed = new Set(
    tree.split("\n").map((l) => l.trim().split(/\s+/)[0]).filter(Boolean),
  );
  const files = Object.keys(scaffold("my-app", "counter", true));
  assert(files.length > 0, "scaffold wrote nothing");
  for (const file of files) {
    assert(
      listed.has(file),
      `"${file}" is scaffolded but not listed:\n${tree}`,
    );
  }
});

Deno.test("quickstart: the window-size flags are shown with the only client that takes them", async () => {
  const qs = await read("docs/basics/quickstart.md");
  // A browser app refuses `--width` ("only applies when client is electron"),
  // and the scaffold's default client is browser.
  assert(
    !qs.includes("`deno task dev --width=1200 --height=800`"),
    "the bare flag form is refused on the default app",
  );
  assert(qs.includes("deno task dev --client=electron --width=1200"));
});
