// Every XML file aio generates must actually PARSE.
//
// `tests/build-ios.test.ts` has a case named "the plist is XML-safe" that does
// `assertStringIncludes` — it checks that a title was escaped, never that the
// document is well-formed. So this shipped, in every `ios-client` build aio
// has ever produced:
//
//   plistlib: not well-formed (invalid token): line 47, column 33
//   47:      usually plain http (`aio --expose` serves https with a self-signed
//
// XML 1.0 §2.5 makes `--` inside a comment a FATAL well-formedness error, and
// the comment explaining App Transport Security quoted a command-line flag.
// Every conforming reader refuses the file — `plutil -convert`, `xmllint`, a
// CI plist lint, Python's `plistlib` — for a reason that has nothing to do
// with the app.
//
// The rule this pins is the CLASS: a generated document that a parser refuses,
// for any of the three things that actually go wrong in hand-written XML.
import { assert, assertEquals } from "@std/assert";
import { ANDROID_TEMPLATE } from "../src/build/android-template.ts";
import { IOS_TEMPLATE } from "../src/build/ios-template.ts";

/** Well-formedness faults that a string-built XML document really produces.
 *  Deliberately narrow and named: a checker that claims to be a parser and is
 *  not would be its own version of the bug above. */
function xmlFaults(src: string): string[] {
  const faults: string[] = [];
  // 1. `--` inside a comment (XML 1.0 §2.5). THE one that shipped.
  const commentRe = /<!--([\s\S]*?)-->/g;
  for (const m of src.matchAll(commentRe)) {
    if (m[1]!.includes("--")) {
      const at = src.slice(0, m.index!).split("\n").length;
      faults.push(
        `line ${at}: "--" inside a comment — XML forbids it: ` +
          JSON.stringify(m[1]!.trim().slice(0, 60)),
      );
    }
  }
  // 2. an unterminated comment.
  const opens = (src.match(/<!--/g) ?? []).length;
  const closes = (src.match(/-->/g) ?? []).length;
  if (opens !== closes) {
    faults.push(`${opens} "<!--" against ${closes} "-->" — unbalanced`);
  }
  // 3. a bare `&` that is not an entity.
  const bare = src.replace(/<!--[\s\S]*?-->/g, "").matchAll(
    /&(?!(?:[a-zA-Z][a-zA-Z0-9]{1,30}|#\d{1,7}|#x[0-9a-fA-F]{1,6});)/g,
  );
  for (const m of bare) {
    const at = src.slice(0, m.index!).split("\n").length;
    faults.push(`line ${at}: a bare "&" that is not an entity`);
  }
  return faults;
}

Deno.test("the XML fault checker finds the faults it names", () => {
  // …because a checker that matches nothing passes forever, which is exactly
  // how the `--` above survived a test called "the plist is XML-safe".
  assertEquals(xmlFaults("<a><!-- fine --></a>"), []);
  assertEquals(
    xmlFaults("<a><!-- run `x --flag` --></a>").length,
    1,
    "a `--` inside a comment must be caught",
  );
  assertEquals(xmlFaults("<a><!-- open </a>").length, 1, "unterminated");
  assertEquals(xmlFaults("<a>Tom &amp; Jerry</a>"), []);
  assertEquals(xmlFaults("<a>Tom & Jerry</a>").length, 1, "bare ampersand");
  assertEquals(xmlFaults("<a>&#169; &#x1F600;</a>"), [], "numeric entities");
});

Deno.test("every generated XML template is well-formed", () => {
  const all: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(IOS_TEMPLATE).map(([k, v]) => [`ios:${k}`, v]),
    ),
    ...Object.fromEntries(
      Object.entries(ANDROID_TEMPLATE).map(([k, v]) => [`android:${k}`, v]),
    ),
  };
  const bad: string[] = [];
  for (const [name, src] of Object.entries(all)) {
    if (!/\.(?:plist|xml)$/.test(name)) continue;
    const faults = xmlFaults(src);
    if (faults.length) bad.push(`${name}\n    ${faults.join("\n    ")}`);
  }
  assertEquals(
    bad,
    [],
    "a generated document no XML parser will accept ships in the artifact:\n" +
      bad.join("\n"),
  );
  // …and the scan must have actually looked at something.
  assert(
    Object.keys(all).some((n) => /\.(?:plist|xml)$/.test(n)),
    "no XML templates were scanned — the test proved nothing",
  );
});
