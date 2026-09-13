// A `$` in an app title is a CHARACTER, and a control character is not a name.
//
// Two defects, four lines apart, in the code that writes an Android project.
//
// 1. `String.prototype.replaceAll` interprets `$$`, `$&`, `` $` `` and `$'`
//    inside a STRING replacement, and the value substituted is the app's own
//    title. Measured before the fix:
//
//        "Cash $$ Register"  → android:label="Cash $ Register"    (silent)
//        "Cost $& Saver"     → "Cost {{APP_NAME}}amp; Saver"
//        "Cost $` Saver"     → 225 characters of the preceding file spliced
//                              in, and a manifest that does not parse
//
//    The Kotlin escape writes `\$`, which FED the pattern — so escaping made
//    it worse rather than better.
//
// 2. The Kotlin spelling stripped control characters and the XML one did not,
//    so a title carrying a BEL, a VT or a NUL produced an
//    `AndroidManifest.xml` that is not well-formed, with nothing naming the
//    title. The iOS side's `plistText` had always stripped them.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  _appNameKotlin,
  _appNameXml,
  _fillTemplate,
} from "../src/build/build-android.ts";

const MANIFEST = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
  <application android:label="{{APP_NAME}}" {{ICON_ATTR}}>
  </application>
</manifest>`;

Deno.test("android: a $ in the title is substituted verbatim", () => {
  for (
    const title of [
      "Cash $$ Register",
      "Cost $& Saver",
      "Cost $` Saver",
      "Cost $' Saver",
      "Plain $ Sign",
    ]
  ) {
    const out = _fillTemplate(MANIFEST, {
      "{{APP_NAME}}": _appNameXml(title),
      "{{ICON_ATTR}}": "",
    });
    assertStringIncludes(
      out,
      `android:label="${_appNameXml(title)}"`,
      `the title was rewritten by its own $ pattern: ${title}`,
    );
    assert(
      !out.includes("{{APP_NAME}}"),
      `the placeholder survived for ${title}`,
    );
    assert(
      !out.includes("<?xml", 40),
      `the file spliced itself into the label for ${title}`,
    );
  }
});

Deno.test("android: the Kotlin spelling escapes $ rather than feeding it", () => {
  // In a Kotlin string literal `$name` is an interpolation, so the escape is
  // right — what was wrong was the escape then acting as a replacement
  // pattern one step later.
  assertEquals(_appNameKotlin("Cash $$ Register"), "Cash \\$\\$ Register");
  const out = _fillTemplate('rootProject.name = "{{APP_NAME}}"', {
    "{{APP_NAME}}": _appNameKotlin("Cash $$ Register"),
  });
  assertEquals(out, 'rootProject.name = "Cash \\$\\$ Register"');
});

Deno.test("android: both spellings strip control characters", () => {
  // Not legal XML at any escape, and the two deciders disagreed about it.
  for (
    const [name, fn] of [["xml", _appNameXml], [
      "kotlin",
      _appNameKotlin,
    ]] as const
  ) {
    for (const ch of ["\x00", "\x07", "\x0b", "\x1f", "\x7f"]) {
      const out = fn(`a${ch}b`);
      assertEquals(out, "ab", `${name} kept ${JSON.stringify(ch)}`);
    }
  }
});

Deno.test("android: the XML spelling still escapes what XML needs escaped", () => {
  assertEquals(
    _appNameXml(`A & B < C > D "E"`),
    "A &amp; B &lt; C &gt; D &quot;E&quot;",
  );
  // …and leaves ordinary text alone, including unicode and emoji.
  assertEquals(_appNameXml("日本語 アプリ 🚀"), "日本語 アプリ 🚀");
});
