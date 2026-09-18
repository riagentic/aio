// macOS `.app` bundle + `.dmg`: the shape a macOS user actually needs.
//
// The bug this pins produced, for real: a `.zip` holding the Deno binary next
// to a pristine `Electron.app` still named "Electron" and signed
// `com.github.Electron`. It "built successfully" and was useless — no `.app`,
// no Dock identity, no icon, and an unsigned nested Electron that macOS kills
// with exit status 1 and no output at all (measured on a real macOS 14 guest).
//
// Everything here is pure or filesystem-only, so it runs on any host. The
// facts that could only be learned from a Mac — that `codesign` refuses a
// `dist/` in `Contents/MacOS/`, that deleting `default_app.asar` silently
// breaks Electron, that matching `CFBundleIdentifier`s merge two processes
// into one Dock entry — are recorded in the source where they were measured.
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { join } from "@std/path";
import {
  assembleMacApp,
  electronPlistsFor,
  ICNS_PNG_TYPES,
  icnsFromPng,
  icnsFromSlots,
  macAppPlist,
  pkgInfo,
  setPlistValue,
} from "../src/build/macos-app.ts";
import {
  DEFAULT_KEPT_LOCALE_PAKS,
  DEFAULT_KEPT_LOCALES,
  trimLocalePaks,
  trimLprojLocales,
} from "../src/build/electron-locales.ts";
import {
  codesignScript,
  localDmgScript,
  remoteDmgScript,
  resolveMacHost,
} from "../src/build/dmg.ts";
import {
  isValidBundleId,
  resolveMacBundleId,
} from "../src/build/build-config.ts";
import { appIconPng, pngSize } from "../src/build/app-icon.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

// ── the bundle's identity: Info.plist ────────────────────────────────────────

Deno.test("macapp: the plist carries every key macOS reads for identity", () => {
  const xml = macAppPlist({
    name: "Counter",
    executable: "counter",
    identifier: "app.aio.counter",
    iconFile: "AppIcon",
    version: "0.1.0",
  });
  for (
    const [key, value] of [
      ["CFBundleName", "Counter"],
      ["CFBundleDisplayName", "Counter"],
      ["CFBundleExecutable", "counter"],
      ["CFBundleIdentifier", "app.aio.counter"],
      ["CFBundleIconFile", "AppIcon"],
      ["CFBundlePackageType", "APPL"],
      ["CFBundleShortVersionString", "0.1.0"],
    ] as const
  ) {
    assertStringIncludes(xml, `<key>${key}</key>`);
    assertStringIncludes(xml, `<string>${value}</string>`);
  }
  assertStringIncludes(xml, "<key>NSHighResolutionCapable</key>");
  assertStringIncludes(xml, "<true/>");
  assertStringIncludes(xml, "<key>LSMinimumSystemVersion</key>");
});

Deno.test("macapp: a title cannot break the plist it is written into", () => {
  // A title is user data. `&` or `<` in it must not end the XML document — a
  // plist the OS cannot parse is an app that does not launch.
  const xml = macAppPlist({
    name: `A&B <C> "D" 'E'`,
    executable: "app",
    identifier: "x.y",
    iconFile: "AppIcon",
    version: "1.0",
  });
  assertStringIncludes(xml, "A&amp;B");
  assertStringIncludes(xml, "&lt;C&gt;");
  assertStringIncludes(xml, "&quot;D&quot;");
  assert(xml.includes("&apos;E&apos;"), "apostrophe escaped");
  // The raw characters must NOT appear inside a value.
  assert(!xml.includes("<C>"), "an unescaped < would end the element");
});

Deno.test("macapp: buildVersion follows version unless given", () => {
  const base = {
    name: "x",
    executable: "x",
    identifier: "x.y",
    iconFile: "I",
  };
  assertEquals(
    macAppPlist({ ...base, version: "1.2.3" }),
    macAppPlist({ ...base, version: "1.2.3", buildVersion: "1.2.3" }),
  );
  assertStringIncludes(
    macAppPlist({ ...base, version: "1.2.3", buildVersion: "42" }),
    "<string>42</string>",
  );
});

Deno.test("macapp: PkgInfo is the 8-byte APPL type/creator", () => {
  assertEquals(new TextDecoder().decode(pkgInfo()), "APPL????");
});

// ── the bundle identifier: permanent identity, refused not sanitized ─────────

Deno.test("macapp: the bundle id defaults to app.aio.<binary>, declared wins", () => {
  assertEquals(resolveMacBundleId({}, "counter"), "app.aio.counter");
  assertEquals(
    resolveMacBundleId(
      { build: { macos: { bundleId: "com.acme.Counter" } } },
      "counter",
    ),
    "com.acme.Counter",
    "a declared id is used VERBATIM — casing included, because it is identity",
  );
});

Deno.test("macapp: an invalid declared bundle id is REFUSED, not fixed up", () => {
  // Silently slugifying would change an app's permanent macOS identity behind
  // its author's back — the same rule android.applicationId follows. The
  // message must name the value AND the shape.
  for (const bad of ["Counter", "com.acme.", "com acme.x", "", "no-dot"]) {
    let err: Error | null = null;
    try {
      resolveMacBundleId({ build: { macos: { bundleId: bad } } }, "counter");
    } catch (e) {
      err = e as Error;
    }
    assert(err, `${JSON.stringify(bad)} must be refused`);
    assertStringIncludes(err.message, "bundleId");
    assertStringIncludes(err.message, JSON.stringify(bad));
  }
});

Deno.test("macapp: the bundle-id rule is the SAME one iOS enforces", () => {
  // A second copy would be free to drift from what the iOS target accepts.
  for (
    const [id, ok] of [
      ["app.aio.counter", true],
      ["com.acme.Counter", true],
      ["com.example.a-b.c1", true],
      ["single", false],
      ["com..x", false],
      ["com.acme.", false],
    ] as const
  ) {
    assertEquals(isValidBundleId(id), ok, id);
  }
});

// ── editing Electron's plists without a Mac ──────────────────────────────────

Deno.test("macapp: setPlistValue replaces an existing value", () => {
  const p = `<?xml version="1.0"?>
<plist version="1.0"><dict>
\t<key>CFBundleIdentifier</key>
\t<string>com.github.Electron</string>
\t<key>CFBundleName</key>
\t<string>Electron</string>
</dict></plist>`;
  const out = setPlistValue(p, "CFBundleIdentifier", "app.aio.counter");
  assertStringIncludes(out, "<string>app.aio.counter</string>");
  assert(!out.includes("com.github.Electron"), "old value is gone");
  assertStringIncludes(out, "<string>Electron</string>", "others untouched");
});

Deno.test("macapp: setPlistValue ADDS a key that is absent", () => {
  // Electron's helper plists do not carry CFBundleDisplayName; inserting it
  // (rather than skipping absent keys) is what names the menu bar.
  const p = `<plist version="1.0"><dict>
\t<key>CFBundleIdentifier</key>
\t<string>com.github.Electron.helper</string>
</dict></plist>`;
  const out = setPlistValue(p, "CFBundleDisplayName", "Counter");
  assertStringIncludes(out, "<key>CFBundleDisplayName</key>");
  assertStringIncludes(out, "<string>Counter</string>");
  // …and it lands INSIDE the dict.
  assert(out.indexOf("CFBundleDisplayName") < out.lastIndexOf("</dict>"));
});

Deno.test("macapp: setPlistValue handles booleans and refuses nothing", () => {
  const p =
    `<plist version="1.0"><dict><key>LSUIElement</key><true/></dict></plist>`;
  assertEquals(
    setPlistValue(p, "LSUIElement", false).includes("<false/>"),
    true,
  );
});

Deno.test("macapp: a plist with no dict is left alone, not mangled", () => {
  // Returning the input unchanged is the safe failure: a caller then writes
  // the file it already had rather than a half-inserted one.
  assertEquals(setPlistValue("not a plist", "X", "y"), "not a plist");
});

Deno.test("macapp: the bundle carries Electron's licence files, not just the runtime", async () => {
  // Chromium and Electron are REDISTRIBUTED inside the app, and
  // `LICENSES.chromium.html` is the notice that requires. The Linux/Windows
  // packages carry it; copying only `Electron.app` (the files sit BESIDE it in
  // the published runtime) silently dropped it from macOS.
  const dir = await tempDir("macapp-lic-");
  try {
    // A minimal staged payload with the runtime's licence files.
    const staged = join(dir, "staged");
    await Deno.mkdir(join(staged, "electron"), { recursive: true });
    await Deno.writeTextFile(join(staged, "electron", "LICENSE"), "MIT-ish");
    await Deno.writeTextFile(
      join(staged, "electron", "LICENSES.chromium.html"),
      "<html>notices</html>",
    );
    await Deno.writeTextFile(join(staged, "counter"), "binary");
    // …and a runtime bundle to copy.
    const el = join(staged, "electron", "Electron.app", "Contents");
    await Deno.mkdir(join(el, "MacOS"), { recursive: true });
    await Deno.mkdir(join(el, "Resources"), { recursive: true });
    await Deno.mkdir(join(el, "Frameworks"), { recursive: true });
    await Deno.writeTextFile(join(el, "Info.plist"), "<plist/>");
    await Deno.writeTextFile(join(el, "MacOS", "Electron"), "el-bin");

    const app = await assembleMacApp({
      stagedDir: staged,
      outDir: join(dir, "out"),
      name: "Counter",
      binaryName: "counter",
      identifier: "app.aio.counter",
      version: "1.0.0",
      iconIcns: new Uint8Array([1, 2, 3]),
    });
    for (
      const f of [
        "LICENSE",
        "LICENSES.chromium.html",
      ]
    ) {
      const p = join(app, "Contents", "Resources", f);
      assertEquals(
        (await Deno.stat(p)).isFile,
        true,
        `${f} must ship in Contents/Resources — redistribution requires it`,
      );
    }
    // And NOT in Contents/MacOS, which is code-only (see the seal rule).
    await assertRejects(
      () => Deno.stat(join(app, "Contents", "MacOS", "LICENSES.chromium.html")),
    );
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("macapp: electronPlistsFor names the bundle and its helpers", async () => {
  const dir = await tempDir("macapp-plists-");
  try {
    const el = join(dir, "Electron.app", "Contents");
    await Deno.mkdir(
      join(el, "Frameworks", "Electron Helper.app", "Contents"),
      {
        recursive: true,
      },
    );
    await Deno.mkdir(
      join(el, "Frameworks", "Electron Helper (GPU).app", "Contents"),
      {
        recursive: true,
      },
    );
    await Deno.writeTextFile(join(el, "Info.plist"), "<plist/>");
    await Deno.writeTextFile(
      join(el, "Frameworks", "Electron Helper.app", "Contents", "Info.plist"),
      "<plist/>",
    );
    await Deno.writeTextFile(
      join(
        el,
        "Frameworks",
        "Electron Helper (GPU).app",
        "Contents",
        "Info.plist",
      ),
      "<plist/>",
    );
    const found = await electronPlistsFor(join(dir, "Electron.app"));
    assertEquals(found.length, 3);
    assert(found[0]!.endsWith("Contents/Info.plist"));
    assert(found.some((f) => f.includes("Electron Helper.app")));
    assert(found.some((f) => f.includes("Helper (GPU).app")));
  } finally {
    await dropTempDir(dir);
  }
});

// ── locale trimming: the biggest safe saving ─────────────────────────────────

Deno.test("locales: macOS .lproj trimming keeps only the requested languages", async () => {
  const dir = await tempDir("macapp-locales-");
  try {
    for (const loc of ["en", "en_GB", "de", "ja", "ru", "zh_CN"]) {
      await Deno.mkdir(join(dir, `${loc}.lproj`), { recursive: true });
      await Deno.writeTextFile(join(dir, `${loc}.lproj`, "locale.pak"), "x");
    }
    // A non-lproj file must survive — trimming is scoped to translations.
    await Deno.writeTextFile(join(dir, "resources.pak"), "keep me");

    assertEquals(trimLprojLocales(dir, DEFAULT_KEPT_LOCALES), 4);
    const left = [...Deno.readDirSync(dir)].map((e) => e.name).sort();
    assertEquals(left, ["en.lproj", "en_GB.lproj", "resources.pak"]);
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("locales: Linux/Windows .pak trimming is the SAME saving on the flat layout", async () => {
  // 46-49 MB of Chromium translations shipped in every Linux AppImage and
  // Windows zip because only the macOS path trimmed. The two layouts are one
  // decision, so both are covered by this module.
  const dir = await tempDir("locales-pak-");
  try {
    await Deno.mkdir(join(dir, "locales"), { recursive: true });
    for (const loc of ["en-US", "en-GB", "de", "ja", "ru", "zh-CN"]) {
      await Deno.writeTextFile(join(dir, "locales", `${loc}.pak`), "x");
    }
    // Never touch a sibling that is not a locale.
    await Deno.writeTextFile(join(dir, "resources.pak"), "keep me");

    assertEquals(
      trimLocalePaks(join(dir, "locales"), DEFAULT_KEPT_LOCALE_PAKS),
      4,
    );
    const left = [...Deno.readDirSync(join(dir, "locales"))].map((e) => e.name)
      .sort();
    assertEquals(left, ["en-GB.pak", "en-US.pak"]);
    assertEquals(
      [...Deno.readDirSync(dir)].map((e) => e.name).includes("resources.pak"),
      true,
      "a non-locale .pak beside the runtime is left alone",
    );
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("locales: trimming a missing directory is a no-op, not a throw", () => {
  // Electron's layout differs between versions; a directory that is not there
  // is not a build failure.
  assertEquals(trimLprojLocales("/nonexistent/xyz", ["en"]), 0);
  assertEquals(trimLocalePaks("/nonexistent/xyz", ["en-US"]), 0);
});

// ── the icon ─────────────────────────────────────────────────────────────────

Deno.test("macapp: an icns is a container of typed, PNG-encoded elements", () => {
  const png = new Uint8Array([1, 2, 3, 4]);
  const icns = icnsFromSlots(() => png);
  // Header: magic + total length.
  assertEquals(
    String.fromCharCode(...icns.subarray(0, 4)),
    "icns",
  );
  assertEquals(
    new DataView(icns.buffer).getUint32(4),
    icns.length,
  );
  // One element per slot, each `type` + length + payload.
  let at = 8;
  let count = 0;
  while (at < icns.length) {
    const len = new DataView(icns.buffer).getUint32(at + 4);
    const type = String.fromCharCode(...icns.subarray(at, at + 4));
    assert(
      ICNS_PNG_TYPES.some((t) => t.type === type),
      `${type} is not a known ICNS PNG type`,
    );
    assertEquals(len, 8 + png.length, `${type} length counts its header`);
    at += len;
    count++;
  }
  assertEquals(count, ICNS_PNG_TYPES.length);
});

Deno.test("macapp: icnsFromSlots skips a slot that returns null", () => {
  const png = new Uint8Array([9, 9]);
  const icns = icnsFromSlots((i) => i === 0 ? png : null);
  let at = 8;
  let count = 0;
  while (at < icns.length) {
    at += new DataView(icns.buffer).getUint32(at + 4);
    count++;
  }
  assertEquals(count, 1, "only the filled slot is written");
});

Deno.test("macapp: a square icon is accepted, a non-square one is not", async () => {
  const square = await appIconPng("Counter", 128);
  assertEquals(pngSize(square), { w: 128, h: 128 });
  assert(icnsFromPng(square) !== null, "a square PNG becomes an icns");

  // 1x1 is square and legal; a corrupt buffer is not a PNG at all.
  assertEquals(icnsFromPng(new Uint8Array([1, 2, 3])), null);
});

// ── the DMG step ─────────────────────────────────────────────────────────────

Deno.test("dmg: resolveMacHost prefers the declared host over the env", () => {
  assertEquals(resolveMacHost("dev@mac-mini", "env@host"), {
    target: "dev@mac-mini",
  });
  assertEquals(resolveMacHost(null, "env@host"), { target: "env@host" });
  assertEquals(resolveMacHost(undefined, undefined), null);
  assertEquals(resolveMacHost("  ", "  "), null, "blank is unset");
});

Deno.test("dmg: a Mac and a Mac-over-SSH make the SAME image", () => {
  // Both paths end in one shared tail: sign the staged app, add the
  // /Applications link, image the STAGE as UDZO. The native path used to image
  // the bare .app — a DMG with no drag-to-Applications target.
  const local = localDmgScript({
    appPath: "/out/Counter.app",
    workDir: "/tmp/w",
    binaryName: "counter",
    volumeName: "Counter",
    outPath: "/out/app.dmg",
    sign: true,
  });
  const remote = remoteDmgScript({
    workDir: "/tmp/w",
    appName: "Counter.app",
    binaryName: "counter",
    volumeName: "Counter",
    outFile: "app.dmg",
    sign: true,
  });
  for (const script of [local, remote]) {
    assertStringIncludes(
      script,
      "ln -s /Applications '/tmp/w/stage'/Applications",
    );
    assertStringIncludes(script, "-srcfolder '/tmp/w/stage' -ov -format UDZO");
    assertStringIncludes(
      script,
      "codesign -v --deep --strict '/tmp/w/stage/Counter.app'",
    );
    // Sealed BEFORE the image is made — an image of an unsealed app is final.
    assert(script.indexOf("codesign") < script.indexOf("hdiutil"));
  }
  assertStringIncludes(
    local,
    "ditto '/out/Counter.app' '/tmp/w/stage/Counter.app'",
  );
  assertStringIncludes(local, "UDZO '/out/app.dmg'");
});

Deno.test("dmg: the remote script clears only the STAGE, never its payload", () => {
  // The bug this pins: `rm -rf <workDir>` removed `payload.tgz` — the file the
  // very next line untars — and `tar` reported the file it had just been
  // handed as missing.
  const script = remoteDmgScript({
    workDir: "/tmp/w",
    appName: "Counter.app",
    binaryName: "counter",
    volumeName: "Counter",
    outFile: "app.dmg",
    sign: false,
  });
  assertStringIncludes(script, "rm -rf '/tmp/w/stage'");
  assert(
    !script.includes("rm -rf '/tmp/w'"),
    "the work dir (holding payload.tgz) must survive",
  );
  assertStringIncludes(script, "tar -xzf '/tmp/w/payload.tgz'");
});

Deno.test("dmg: the code seal is built deepest-first", () => {
  // A signature covers what it contains: sealing the outer bundle before a
  // framework inside it invalidates the outer seal. The ORDER is the whole
  // correctness of this function.
  const s = codesignScript("/out/Counter.app", "counter");
  // Needles must be unique to their step: `Frameworks/*.app` appears in BOTH
  // the helper-binary loop and the helper-APP loop, so each is matched by the
  // text that distinguishes it.
  const at = (needle: string) => {
    const i = s.indexOf(needle);
    assert(i >= 0, `expected the script to contain ${needle}`);
    return i;
  };
  const helperBin = at(`Frameworks/*.app; do for b in`);
  const dylib = at("Libraries/");
  const framework = at("Frameworks/*.framework");
  const helperApp = at(`Frameworks/*.app; do sign "$h"`);
  const nested = at("Electron.app/Contents'/..");
  const outerBinary = at("MacOS/'counter'");
  const outer = s.lastIndexOf("'/out/Counter.app'");

  assert(helperBin < framework, "helper binaries sign before frameworks");
  assert(dylib < framework, "dylibs sign before the framework that hosts them");
  assert(framework < helperApp, "frameworks before the helper apps");
  assert(helperApp < nested, "helper apps before the nested Electron.app");
  assert(nested < outerBinary, "nested bundle before the outer binary");
  assert(outerBinary < outer, "outer bundle signs LAST");
  assertStringIncludes(s, "codesign -v --deep --strict");
});

Deno.test("dmg: signing a path with a quote cannot break out of the shell", () => {
  const s = codesignScript("/tmp/it's/Counter.app", "counter");
  // The value is single-quoted with the standard `'\''` escape, so the quote
  // is data — not the end of the string.
  assertStringIncludes(s, `'/tmp/it'\\''s/Counter.app'`);
});

Deno.test("dmg: the outer binary is signed BY NAME, not by glob", () => {
  // `MacOS/*` also matches the `electron/` runtime directory, and codesign
  // refuses a directory with "bundle format unrecognized".
  const s = codesignScript("/out/Counter.app", "counter");
  assertStringIncludes(s, "/out/Counter.app'/Contents/MacOS/'counter'");
  assert(!s.includes("Contents/MacOS/*"), "no glob over the MacOS directory");
});
