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
  _applicationIdRefusal,
  _appNameFor,
  _appNameKotlin,
  _appNameXml,
  _fillTemplate,
  _leftoverTokens,
  androidApplicationId,
} from "../src/build/build-android.ts";
import { ANDROID_TEMPLATE } from "../src/build/android-template.ts";

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

Deno.test("android: whitespace inside {{ }} cannot survive as a token", () => {
  // a field report: an overlay reformatted `{{APP_NAME}}` to
  // `{{ APP_NAME }}`; the substitution matched nothing, the placeholder reached
  // AndroidManifest.xml, and gradle failed with an opaque merge error.
  const padded = '<application android:label="{{ APP_NAME }}" {{ ICON_ATTR }}>';
  const out = _fillTemplate(padded, {
    "{{APP_NAME}}": "X",
    "{{ICON_ATTR}}": 'android:icon="@mipmap/ic_launcher"',
  });
  assertEquals(
    out,
    '<application android:label="X" android:icon="@mipmap/ic_launcher">',
  );
  assert(!out.includes("{{"), "no placeholder may survive formatting");
  // Tabs and newlines inside the braces are the same defect.
  assertEquals(
    _fillTemplate("a={{\n\tAPP_NAME\t\n}}", { "{{APP_NAME}}": "Y" }),
    "a=Y",
  );
  // A lowercase name is not a token and is left alone.
  assertEquals(_fillTemplate("{{ not_a_token }}", {}), "{{ not_a_token }}");
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

Deno.test("android: a token no substitution knows is named, once — it would reach gradle as text", () => {
  const out = _fillTemplate(
    `<a l="{{ APP_NAME }}" t="{{APP_TITLE}}" u="{{APP_TITLE}}" k="{{lower}}"/>`,
    { "{{APP_NAME}}": "Notes" },
  );
  assertEquals(_leftoverTokens(out), ["{{APP_TITLE}}"]);
  assertEquals(
    _leftoverTokens(_fillTemplate(MANIFEST, {
      "{{APP_NAME}}": "N",
      "{{ICON_ATTR}}": "",
    })),
    [],
  );
});

// Gradle 8.14 refuses a project name with any of `/ \ : < > " ? * |` —
// measured: a title `Café $& "Ünï" ☕ \ App` failed `assembleDebug` at
// settings.gradle.kts line 1 ("The project name ... must not contain").
// settings.gradle.kts takes the binary name; the label keeps the title.
Deno.test("android: settings.gradle.kts project name is Gradle-legal for any title", () => {
  for (
    const title of ["Notes: Work", 'A/B "test"?', "C:\\x <y> *|", "Café ☕"]
  ) {
    const settings = _fillTemplate(ANDROID_TEMPLATE["settings.gradle.kts"]!, {
      "{{APP_NAME}}": _appNameFor("settings.gradle.kts", title, "notes-work"),
    });
    const name = settings.match(/rootProject\.name = "(.*)"/)![1]!;
    assertEquals(name, "notes-work", title);
    assert(!/[\/\\:<>"?*|]/.test(name), name);
  }
  assertEquals(
    _appNameFor("app/src/main/AndroidManifest.xml", 'A "b"', "a-b"),
    "A &quot;b&quot;",
  );
  assertEquals(
    _appNameFor("app/src/main/java/aio/app/MainActivity.kt", 'A "b"', "a-b"),
    'A \\"b\\"',
  );
});

// An app named "3D Viewer" (slug `3d-viewer`) derives `app.aio.3dviewer`,
// which Android refuses — and the refusal named no way out.
Deno.test("android: a derived applicationId that cannot be names the key that fixes it", () => {
  assertEquals(androidApplicationId("3d-viewer"), null);
  const why = _applicationIdRefusal("3d-viewer");
  assertStringIncludes(why, "app.aio.3dviewer");
  assertStringIncludes(
    why,
    '"android": { "applicationId": "com.example.app" }',
  );
  assertStringIncludes(_applicationIdRefusal("x", "nodots"), '"nodots"');
});
