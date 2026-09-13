// An Android label is a STRING RESOURCE, not just an XML attribute.
//
// `_appNameXml` made the title well-formed XML and stopped there — but aapt2
// reads `android:label` with resource-string rules. Measured with aapt2 36
// (`aapt2 dump xmltree` on the linked APK):
//
//   "back\slash"  → label "backslash"   (a backslash starts an escape)
//   "\u0041"      → label "A"
//   "?quest"      → link FAILS: "resource attr/quest not found" (a reference)
//   "@string/x"   → a reference to someone else's string, or a failed link
//
// And U+FFFE / U+FFFF are not XML characters at all: "not well-formed".
//
// The pure checks run everywhere; the aapt2 round-trip adds the real parser's
// verdict where an SDK is installed.
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  _appNameXml,
  _cleartextAttr,
  _fillTemplate,
} from "../src/build/build-android.ts";
import { ANDROID_TEMPLATE } from "../src/build/android-template.ts";
import { resolveSdk } from "../src/build/build-helpers.ts";
import { plistText } from "../src/build/build-ios.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const TITLES = [
  "back\\slash",
  "\\u0041",
  "trail\\",
  "?quest",
  "@at",
  "@string/app_name",
  "@android:string/ok",
  "mid?@x",
  "it's",
  'say "hi"',
  "a&b<c>",
  "Café ☕ 🚀",
];

Deno.test("android label: backslashes and a leading ?/@ are resource-escaped", () => {
  assertEquals(_appNameXml("back\\slash"), "back\\\\slash");
  assertEquals(_appNameXml("\\u0041"), "\\\\u0041");
  assertEquals(_appNameXml("?quest"), "\\?quest");
  assertEquals(_appNameXml("@string/app_name"), "\\@string/app_name");
  // Only a LEADING ?/@ is a reference.
  assertEquals(_appNameXml("mid?@x"), "mid?@x");
  // Quotes and apostrophes survive an attribute verbatim — XML escape only.
  assertEquals(_appNameXml(`it's "x"`), "it's &quot;x&quot;");
});

Deno.test("android label + iOS plist: U+FFFE/U+FFFF are stripped (not XML characters)", () => {
  assertEquals(_appNameXml("a\uFFFEb\uFFFFc"), "abc");
  assertEquals(plistText("a\uFFFEb\uFFFFc"), "abc");
});

/** The label aapt2 actually linked, or null when there is no SDK here. */
async function aapt2Label(title: string, dir: string): Promise<string | null> {
  const sdk = resolveSdk();
  if (!sdk) return null;
  const tools = [...Deno.readDirSync(join(sdk, "build-tools"))].map((e) =>
    e.name
  ).sort().pop();
  const jars = [...Deno.readDirSync(join(sdk, "platforms"))].map((e) => e.name)
    .sort().pop();
  if (!tools || !jars) return null;
  const aapt2 = join(sdk, "build-tools", tools, "aapt2");
  const manifest = _fillTemplate(
    ANDROID_TEMPLATE["app/src/main/AndroidManifest.xml"]!,
    {
      "{{APPLICATION_ID}}": "app.aio.labelprobe",
      "{{APP_NAME}}": _appNameXml(title),
      "{{ICON_ATTR}}": "",
      "{{CLEARTEXT_ATTR}}": _cleartextAttr(
        { remote: false } as Parameters<typeof _cleartextAttr>[0],
      ),
    },
  )
    // The AppCompat theme lives in a library this link does not have; the
    // label is the only thing under test.
    .replace(
      "@style/Theme.AppCompat.NoActionBar",
      "@android:style/Theme.Material",
    )
    .replace("<manifest ", '<manifest package="app.aio.labelprobe" ');
  const mf = join(dir, "AndroidManifest.xml");
  const apk = join(dir, "o.apk");
  await Deno.writeTextFile(mf, manifest);
  const link = await new Deno.Command(aapt2, {
    args: [
      "link",
      "-o",
      apk,
      "--manifest",
      mf,
      "-I",
      join(sdk, "platforms", jars, "android.jar"),
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!link.success) {
    return `LINK FAILED: ${new TextDecoder().decode(link.stderr).trim()}`;
  }
  const dump = await new Deno.Command(aapt2, {
    args: ["dump", "xmltree", "--file", "AndroidManifest.xml", apk],
    stdout: "piped",
    stderr: "piped",
  }).output();
  const txt = new TextDecoder().decode(dump.stdout);
  return txt.match(/android:label\(0x01010001\)="(.*?)" \(Raw: /s)?.[1] ??
    `NO LABEL IN:\n${txt}`;
}

Deno.test("android label: aapt2 links every title and keeps it verbatim (where an SDK exists)", async () => {
  if (!resolveSdk()) return; // no SDK on this host — the pure checks above gate
  const dir = await tempDir("aio-android-label-");
  try {
    for (const title of TITLES) {
      assertEquals(await aapt2Label(title, dir), title, `title ${title}`);
    }
  } finally {
    await dropTempDir(dir);
  }
});
