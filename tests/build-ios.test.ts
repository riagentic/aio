// The `ios-client` target: an Xcode project whose WKWebView opens the connect
// page and navigates to the server. There is no Deno on iOS, so this is the
// most an iPhone can carry — and the project has to be complete on ANY host,
// because the step that needs a Mac is xcodebuild, not the project.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  buildIos,
  iosBundleId,
  iosProjectDir,
  isValidBundleId,
  plistText,
  renderIosTemplate,
} from "../src/build/build-ios.ts";
import { IOS_TEMPLATE } from "../src/build/ios-template.ts";
import { TARGETS } from "../src/build-all.ts";

Deno.test("ios: bundle id — declared wins when valid, else derived, else null", () => {
  assertEquals(iosBundleId("wallet", undefined), "app.aio.wallet");
  assertEquals(iosBundleId("my-app", undefined), "app.aio.myapp");
  assertEquals(
    iosBundleId("wallet", "com.example.wallet"),
    "com.example.wallet",
  );
  assertEquals(iosBundleId("wallet", "nodots"), null);
  assertEquals(iosBundleId("1st", undefined), null);
  assert(isValidBundleId("com.example.my-app"));
  assert(!isValidBundleId("com.example.my_app"));
});

Deno.test("ios: every placeholder is rendered and the plist is XML-safe", () => {
  const files = renderIosTemplate({
    appName: 'Tom & "Jerry" <3',
    bundleId: "com.example.tj",
    versionName: "1.2.3",
    versionCode: 10203,
    allowArbitraryLoads: true,
  });
  assert(Object.keys(files).length >= 6, "the template ships its files");
  for (const [rel, content] of Object.entries(files)) {
    assert(!/\{\{[A-Z_]+\}\}/.test(content), `${rel} still has a placeholder`);
  }
  const plist = files["App/Info.plist"]!;
  assertStringIncludes(plist, 'Tom &amp; "Jerry" &lt;3');
  assertStringIncludes(plist, "<key>NSAllowsArbitraryLoads</key>");
  assertStringIncludes(plist, "<true/>");
  const strict = renderIosTemplate({
    appName: "x",
    bundleId: "a.b",
    versionName: "1.0.0",
    versionCode: 1,
    allowArbitraryLoads: false,
  })["App/Info.plist"]!;
  assertStringIncludes(strict, "<false/>");
  const pbx = files["App.xcodeproj/project.pbxproj"]!;
  assertStringIncludes(pbx, 'PRODUCT_BUNDLE_IDENTIFIER = "com.example.tj"');
  assertStringIncludes(pbx, "CURRENT_PROJECT_VERSION = 10203");
  assertEquals(plistText("abc"), "abc");
});

Deno.test("ios: the project references only files the template ships", () => {
  const pbx = IOS_TEMPLATE["App.xcodeproj/project.pbxproj"]!;
  for (
    const name of ["AppDelegate.swift", "ViewController.swift", "Info.plist"]
  ) {
    assertStringIncludes(pbx, `path = ${name};`);
    assert(
      `App/${name}` in IOS_TEMPLATE,
      `${name} is referenced but not shipped`,
    );
  }
  assertStringIncludes(pbx, "path = www;");
  assertStringIncludes(pbx, "path = Assets.xcassets;");
  assert(
    "App/Assets.xcassets/AppIcon.appiconset/Contents.json" in IOS_TEMPLATE,
  );
});

Deno.test("ios: the fleet knows ios-client as a client target, and no ios app target exists", () => {
  assertEquals(TARGETS["ios-client"]?.role, "client");
  assertEquals(TARGETS["ios-client"]?.flags, ["--ios", "--remote"]);
  assert(
    !("ios" in TARGETS),
    "an app cannot run on iOS — there is no Deno there",
  );
});

Deno.test("ios: the build writes a complete project on this host", async () => {
  const root = await Deno.makeTempDir({ prefix: "aio-ios-" });
  try {
    await Deno.writeTextFile(
      join(root, "deno.json"),
      JSON.stringify({
        title: "Probe",
        version: "0.3.1",
        ios: { bundleId: "com.example.probe" },
      }),
    );
    const cfg = {
      root,
      binaryName: "probe",
      appTitle: "Probe",
      appDir: root,
      doRemote: true,
      bakedServer: null,
    } as unknown as Parameters<typeof buildIos>[0];
    await buildIos(cfg);
    const dir = iosProjectDir(cfg);
    for (
      const rel of [
        "App.xcodeproj/project.pbxproj",
        "App/Info.plist",
        "App/ViewController.swift",
        "App/www/index.html",
        "App/Assets.xcassets/AppIcon.appiconset/icon-1024.png",
      ]
    ) {
      assert((await Deno.stat(join(dir, rel))).size > 0, `${rel} missing`);
    }
    const plist = await Deno.readTextFile(join(dir, "App/Info.plist"));
    assertStringIncludes(plist, "<string>Probe</string>");
    const pbx = await Deno.readTextFile(
      join(dir, "App.xcodeproj/project.pbxproj"),
    );
    assertStringIncludes(
      pbx,
      'PRODUCT_BUNDLE_IDENTIFIER = "com.example.probe"',
    );
    assertStringIncludes(pbx, 'MARKETING_VERSION = "0.3.1"');
    const www = await Deno.readTextFile(join(dir, "App/www/index.html"));
    assertStringIncludes(www, "aio_server");
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});
