// The mobile templates: six confirmed bugs, each pinned where it was made.
//
// The Kotlin/Swift cases are generated-source assertions — they prove the
// shipped template says the right thing, not that a device does it (that is
// `test:android` / an Xcode run).
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  _appNameXml,
  _devUrlLiteral,
  _fillTemplate,
  _leftoverTokens,
  _writeConnectPage,
  safeDevUrl,
} from "../src/build/build-android.ts";
import { renderIosTemplate } from "../src/build/build-ios.ts";
import { ANDROID_TEMPLATE } from "../src/build/android-template.ts";
import { IOS_TEMPLATE } from "../src/build/ios-template.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const MAIN_ACTIVITY = "app/src/main/java/aio/app/MainActivity.kt";

// ── 1. a value is inserted verbatim, never scanned again ──────────────────

Deno.test("android manifest: a title that spells a token is inserted verbatim", () => {
  const manifest = ANDROID_TEMPLATE["app/src/main/AndroidManifest.xml"]!;
  const title = "Pick {{ICON_ATTR}} here";
  // Same key order as buildAndroid's map (APP_NAME before ICON_ATTR): the
  // per-token passes expanded the title's `{{ICON_ATTR}}` on the next pass.
  const filled = _fillTemplate(manifest, {
    "{{APP_NAME}}": _appNameXml(title),
    "{{ICON_ATTR}}": 'android:icon="@mipmap/ic_launcher"',
  });
  const label = /android:label="([^"]*)"/.exec(filled)![1];
  assertEquals(label, _appNameXml(title));
  assertStringIncludes(filled, 'android:icon="@mipmap/ic_launcher"');
});

Deno.test("_fillTemplate: an unknown token is left as written, so it is still reported", () => {
  const out = _fillTemplate("a {{ KNOWN }} b {{UNKNOWN}} c {{lower}}", {
    "{{KNOWN}}": "k",
  });
  assertEquals(out, "a k b {{UNKNOWN}} c {{lower}}");
  assertEquals(_leftoverTokens(out), ["{{UNKNOWN}}"]);
});

Deno.test("ios: a title that spells a token is inserted verbatim", () => {
  const title = "Pick {{BUNDLE_ID}} here";
  const out = renderIosTemplate({
    appName: title,
    bundleId: "app.aio.example",
    versionName: "1.2.3",
    versionCode: 7,
    allowArbitraryLoads: true,
  });
  const all = Object.values(out).join("\n");
  assertStringIncludes(all, title);
  assert(
    !all.includes("Pick app.aio.example here"),
    "the title was re-expanded",
  );
  assertStringIncludes(all, "app.aio.example");
});

// ── 2. --android-dev-url is pasted as an escaped Kotlin literal ──────────

/** The body of a Kotlin `"…"` literal, decoded — and null when a `$` or `\`
 *  in it is not part of an escape (a template, or a broken literal). */
function kotlinBody(lit: string): string | null {
  if (!lit.startsWith('"') || !lit.endsWith('"')) return null;
  const body = lit.slice(1, -1);
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "$" || c === '"') return null;
    if (c === "\\") {
      const n = body[++i];
      if (n === "$" || n === "\\" || n === '"') out += n;
      else return null;
    } else out += c;
  }
  return out;
}

Deno.test("android dev url: `$`, `{`, `}`, `\\` reach Kotlin escaped, and the URL survives", () => {
  for (
    const u of [
      "http://10.0.2.2:8000/?x=${android.os.Process.killProcess(android.os.Process.myPid())}",
      "http://10.0.2.2:8000/#$x",
      "http://10.0.2.2:8000/?a=\\",
      "http://10.0.2.2:8000",
    ]
  ) {
    const lit = _devUrlLiteral(u);
    const body = kotlinBody(lit);
    assert(body !== null, `would break/inject the Kotlin literal: ${lit}`);
    // Escaped, not rewritten: the dev APK opens exactly the validated URL.
    assertEquals(body, safeDevUrl(u));
  }
});

// ── 3. the connect page reads a capitalised scheme ───────────────────────

async function connectPage(target: "android" | "ios"): Promise<string> {
  const dir = await tempDir("aio-mobile-connect-");
  try {
    await _writeConnectPage(dir, "T", null, target);
    return await Deno.readTextFile(join(dir, "index.html"));
  } finally {
    await dropTempDir(dir);
  }
}

for (const target of ["android", "ios"] as const) {
  Deno.test(`connect page (${target}): a capitalised scheme is still that scheme`, async () => {
    const html = await connectPage(target);
    const src =
      /function parse\(v\)\{[\s\S]*?return \{bare:bare,u:u,v:v\};\s*\}/
        .exec(html)![0];
    const parse = new Function(`${src}; return parse;`)() as (
      v: string,
    ) => { bare: boolean; u: URL | null; v: string };
    const p = parse("Https://192.168.1.5:8443/?token=abc");
    assertEquals(p.u?.host, "192.168.1.5:8443"); // was: "https"
    assertEquals(p.bare, false);
    assertEquals(p.v, "https://192.168.1.5:8443/?token=abc");
    assertEquals(parse("HTTP://h:8000").u?.protocol, "http:");
    // Bare stays bare, with its https-when-keyed rule.
    assertEquals(parse("h:8000").u?.protocol, "http:");
    assertEquals(parse("h:8000/?token=k").u?.protocol, "https:");

    // …and the keyboard is told not to capitalise or correct it.
    const addr = /<input id="addr"[^>]*>/.exec(html)![0];
    for (
      const a of [
        'autocapitalize="off"',
        'autocorrect="off"',
        'spellcheck="false"',
        'inputmode="url"',
      ]
    ) assertStringIncludes(addr, a);
  });
}

// ── 4. iOS sends every hash its connect page explains ────────────────────

Deno.test("ios: the shell can send every hash its connect page explains", async () => {
  const html = await connectPage("ios");
  const swift = IOS_TEMPLATE["App/ViewController.swift"]!;
  const explained = [...html.matchAll(/location\.hash==='#(\w+)'/g)].map((m) =>
    m[1]
  );
  const sent = [...swift.matchAll(/showForm\("(\w+)"\)/g)].map((m) => m[1]);
  const dead = explained.filter((h) => h !== "change" && !sent.includes(h));
  assertEquals(dead, []); // was: ["untrusted"]
});

Deno.test("ios: an untrusted certificate goes to #untrusted, not #unreachable", () => {
  const swift = IOS_TEMPLATE["App/ViewController.swift"]!;
  const fn = /didFailProvisionalNavigation[\s\S]*?\n {4}\}\n/.exec(swift)![0];
  const untrusted = fn.indexOf('showForm("untrusted")');
  assert(untrusted > 0);
  for (
    const code of [
      "NSURLErrorServerCertificateUntrusted",
      "NSURLErrorServerCertificateHasBadDate",
      "NSURLErrorServerCertificateHasUnknownRoot",
      "NSURLErrorServerCertificateNotYetValid",
    ]
  ) {
    const at = fn.indexOf(code);
    assert(at > 0 && at < untrusted, `${code} must route to "untrusted"`);
  }
  assertStringIncludes(fn, 'showForm("unreachable")');
});

// ── 5. a subframe never launches an external app ─────────────────────────

Deno.test("android: shouldOverrideUrlLoading keeps a subframe's navigation in its frame", () => {
  const kt = ANDROID_TEMPLATE[MAIN_ACTIVITY]!;
  const fn =
    /override fun shouldOverrideUrlLoading[\s\S]*?\n {16}\}\n/.exec(kt)![0];
  const guard = fn.indexOf("request?.isForMainFrame != true) return false");
  assert(guard > 0, "no main-frame guard");
  assert(
    guard < fn.indexOf("Intent.ACTION_VIEW"),
    "the guard must precede ACTION_VIEW",
  );
  // The main frame's logic is unchanged.
  assertStringIncludes(fn, "if (uri.host == ASSET_HOST) return false");
  assertStringIncludes(fn, "TALKS_TO_SERVER &&");
});

// ── 6. a second camera request never orphans the first ───────────────────

Deno.test("android: a camera request while one is pending is denied, not swapped in", () => {
  const kt = ANDROID_TEMPLATE[MAIN_ACTIVITY]!;
  const assign = kt.indexOf("pendingCameraRequest = request");
  assert(assign > 0);
  const before = kt.slice(0, assign);
  const busy = before.lastIndexOf("else if (pendingCameraRequest != null)");
  assert(busy > 0, "no pending-request check before the assignment");
  assertStringIncludes(before.slice(busy), "request.deny()");
});
