/**
 * @module
 * macOS `.app` bundle assembly — the shape a desktop app has on macOS.
 *
 * A macOS GUI app is not a binary and not a zip: it is a DIRECTORY with a
 * `Contents/Info.plist`, an icon, and a bundle identifier, and the OS itself
 * reads those to draw the Dock entry, the menu bar and the window. `deno
 * compile --target aarch64-apple-darwin` emits a bare Mach-O — correct, and
 * not an app. What shipped before this module was a zip holding that binary
 * NEXT TO a pristine `Electron.app` still called "Electron": Gatekeeper saw an
 * unsigned archive, the Dock saw `com.github.Electron`, and the menu bar said
 * "Electron". That is the "utter garbage" a macOS user got.
 *
 * This module builds the real thing, cross-platform, and is pure enough that
 * the whole layout is unit-tested without a Mac:
 *
 *   Counter.app/
 *     Contents/
 *       Info.plist              ← identity: CFBundleExecutable, Identifier, Icon
 *       PkgInfo                 ← APPL????
 *       MacOS/
 *         <binary>              ← the Deno server binary IS the bundle executable
 *         electron/             ← the runtime, where packagedElectronCandidates looks
 *           Electron.app/
 *       Resources/
 *         AppIcon.icns
 *
 * Three facts make this layout correct, and each was measured on a real
 * macOS 14 guest rather than assumed:
 *
 *  1. **The Deno binary is `CFBundleExecutable`.** aio is a two-process app:
 *     the compiled binary owns the server and spawns Electron as its window.
 *     Naming the binary as the executable means the OS launches the server, its
 *     identity is the app's, and Electron is a child — one Dock entry, one
 *     window, one lifetime.
 *
 *  2. **`dist/` does NOT go in `Contents/MacOS/`.** `codesign` treats that
 *     directory as code-only; a PNG there makes the seal fail with "code object
 *     is not signed at all / In subcomponent: …/dist/icon.png". The compiled
 *     binary already EMBEDS `dist/` in its Deno VFS and serves it to Electron
 *     over the app's own socket, so nothing needs to be on disk — the app runs
 *     identically with an empty `Resources/`.
 *
 *  3. **The nested Electron carries the SAME `CFBundleIdentifier` and icon.**
 *     macOS merges processes by identifier; matching them is what turns two
 *     binaries into one Dock icon named after the app instead of "Electron".
 *
 * `Contents/MacOS/electron/Electron.app` is deliberate rather than the
 * Apple-canonical `Contents/Frameworks/`: `packagedElectronCandidates`
 * (`electron-spawn.ts`) resolves the shipped runtime at
 * `dirname(execPath)/electron/…`, so this placement needs no resolver change
 * and keeps one truth about where a packaged runtime lives. It was verified to
 * `codesign --deep --strict` clean in exactly this position.
 */
import { join } from "@std/path";
import { appIconPng, pngSize } from "./app-icon.ts";
import { copyDir } from "./build-helpers.ts";
import { DEFAULT_KEPT_LOCALES, trimLprojLocales } from "./electron-locales.ts";
import { NO, OK } from "../diagnostics/fmt.ts";

/** ICNS element OSTypes for PNG-encoded images, by pixel dimension.
 *
 *  PNG-in-ICNS is legal since macOS 10.7 and is what every modern `.app`
 *  ships; the 1-bit/24-bit/RLE encodings of the 1990s format are not worth
 *  emitting. `ic11`/`ic12` are the 16/32pt @2x retina slots (32/64 px), and
 *  `ic13`/`ic14` are the 256/512pt @2x ones — an icon that omits them looks
 *  soft in the Dock on a Retina display, which is every Mac now. */
export const ICNS_PNG_TYPES: ReadonlyArray<{ type: string; size: number }> = [
  { type: "ic11", size: 32 }, // 16pt @2x
  { type: "ic12", size: 64 }, // 32pt @2x
  { type: "ic07", size: 128 },
  { type: "ic08", size: 256 },
  { type: "ic13", size: 256 }, // 128pt @2x
  { type: "ic09", size: 512 },
  { type: "ic14", size: 512 }, // 256pt @2x
  { type: "ic10", size: 1024 }, // 512pt @2x
];

/** Build an `.icns` from whatever {@link ICNS_PNG_TYPES} slots `pngFor` can
 *  fill. Returning null for a slot SKIPS it, which is how a user icon smaller
 *  than 512 px avoids claiming a size it cannot fill. Pure. */
export function icnsFromSlots(
  pngFor: (index: number, size: number) => Uint8Array | null,
): Uint8Array {
  const parts: Uint8Array[] = [];
  ICNS_PNG_TYPES.forEach(({ type, size }, i) => {
    const png = pngFor(i, size);
    if (png === null) return;
    const el = new Uint8Array(8 + png.length);
    for (let k = 0; k < 4; k++) el[k] = type.charCodeAt(k);
    new DataView(el.buffer).setUint32(4, el.length);
    el.set(png, 8);
    parts.push(el);
  });
  return wrapIcns(parts);
}

/** Build an `.icns` from an app's GENERATED monogram — pure TypeScript, so a
 *  Linux build host needs no `sips`, `iconutil`, or ImageMagick. Each slot is
 *  rasterized at its EXACT pixel size (the monogram renderer is resolution
 *  independent), so every icon the Dock asks for is native. Verified by
 *  `iconutil -c iconset` on a real Mac, which is the only test that matters. */
export async function icnsFromName(name: string): Promise<Uint8Array> {
  const cache = new Map<number, Uint8Array>();
  const parts: Uint8Array[] = [];
  for (const { type, size } of ICNS_PNG_TYPES) {
    let png = cache.get(size);
    if (!png) {
      png = await appIconPng(name, size);
      cache.set(size, png);
    }
    const el = new Uint8Array(8 + png.length);
    for (let k = 0; k < 4; k++) el[k] = type.charCodeAt(k);
    new DataView(el.buffer).setUint32(4, el.length);
    el.set(png, 8);
    parts.push(el);
  }
  return wrapIcns(parts);
}

/** Frame already-built ICNS elements in the container header. Pure. */
function wrapIcns(parts: Uint8Array[]): Uint8Array {
  const body = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(8 + body);
  for (let i = 0; i < 4; i++) out[i] = "icns".charCodeAt(i);
  new DataView(out.buffer).setUint32(4, out.length);
  let at = 8;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Build an `.icns` from a single user-supplied `icon.png`.
 *
 *  Deliberately NOT scaled in the build: scaling a PNG means decoding and
 *  resampling it, which would be a FOURTH PNG codec in this repo (the monogram
 *  rasterizer, `app-icon.ts`'s writer, and `am`'s comparison reader are the
 *  other three) — and `build → am` is not an allowed edge anyway. Instead the
 *  source PNG is placed at its own size and macOS scales it for the other Dock
 *  sizes, which it does with high quality. The convention is a square 512 px
 *  `icon.png` (what `writeDefaultIcon` and the docs produce), so in practice
 *  one image fills the slots it can and the rest are scaled by the OS.
 *
 *  A source whose dimensions we cannot read (`pngSize` → null) yields no icns,
 *  and the caller falls back to the generated monogram — never an icon-less
 *  bundle. */
export function icnsFromPng(png: Uint8Array): Uint8Array | null {
  const dim = pngSize(png);
  if (!dim || dim.w !== dim.h) return null;
  // Place the source in every slot at or below its size; macOS scales it up
  // for the largest Dock sizes, which it does well and is why no resampler is
  // needed here.
  return icnsFromSlots((_i, size) => size <= dim.w ? png : null);
}

/** A macOS `Info.plist` document. Written rather than templated so every value
 *  is escaped exactly once — a title with an `&` or a `<` in it must not be
 *  able to produce a plist the OS refuses to read. */
export interface MacAppPlist {
  /** `CFBundleName` / `CFBundleDisplayName` — what the Dock and menu bar show. */
  name: string;
  /** `CFBundleExecutable` — the file in `Contents/MacOS/`. */
  executable: string;
  /** `CFBundleIdentifier` — reverse-DNS; also how macOS merges the Deno server
   *  and its Electron child into ONE app. */
  identifier: string;
  /** `CFBundleIconFile` — a name in `Contents/Resources/` (no extension). */
  iconFile: string;
  version: string;
  /** Build number; falls back to {@link version}. */
  buildVersion?: string;
  /** `LSMinimumSystemVersion`. Electron 43 needs 12.0. */
  minimumSystemVersion?: string;
  /** Extra `<key>/<string|true>` pairs (e.g. `NS*UsageDescription`). */
  extra?: Record<string, string | boolean>;
}

/** XML-escape a plist string value. */
function xml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/** Render the bundle-level `Info.plist`. Pure. */
export function macAppPlist(p: MacAppPlist): string {
  const rows: string[] = [];
  const str = (k: string, v: string) =>
    rows.push(`  <key>${xml(k)}</key>\n  <string>${xml(v)}</string>`);
  const bool = (k: string, v: boolean) =>
    rows.push(`  <key>${xml(k)}</key>\n  <${v ? "true" : "false"}/>`);
  str("CFBundleName", p.name);
  str("CFBundleDisplayName", p.name);
  str("CFBundleExecutable", p.executable);
  str("CFBundleIdentifier", p.identifier);
  str("CFBundleIconFile", p.iconFile);
  str("CFBundleInfoDictionaryVersion", "6.0");
  str("CFBundlePackageType", "APPL");
  str("CFBundleShortVersionString", p.version);
  str("CFBundleVersion", p.buildVersion ?? p.version);
  str("LSMinimumSystemVersion", p.minimumSystemVersion ?? "12.0");
  bool("NSHighResolutionCapable", true);
  for (const [k, v] of Object.entries(p.extra ?? {})) {
    typeof v === "boolean" ? bool(k, v) : str(k, v);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${rows.join("\n")}
</dict>
</plist>
`;
}

/** The `PkgInfo` file — legacy, four bytes of type + four of creator, still
 *  read by some launchers. Pure. */
export function pkgInfo(): Uint8Array {
  return new TextEncoder().encode("APPL????");
}

/** Electron's helper apps, whose *binaries* must keep their names ("Electron
 *  Helper (Renderer)") because Chromium discovers them by that path. Only the
 *  app bundle's plist is renamed for appearance. */
const HELPER_SUFFIXES = ["", " (GPU)", " (Plugin)", " (Renderer)"] as const;

/** Every `Info.plist` inside a nested Electron bundle whose identity must
 *  match the app: the bundle itself plus its four helper apps.
 *
 *  Rewriting a plist invalidates the code signature, so signing must run
 *  AFTER this — `buildMacApp` orders it that way. */
export async function electronPlistsFor(
  electronAppDir: string,
): Promise<string[]> {
  const contents = join(electronAppDir, "Contents");
  const out = [join(contents, "Info.plist")];
  for (const s of HELPER_SUFFIXES) {
    const helper = join(
      contents,
      "Frameworks",
      `Electron Helper${s}.app`,
      "Contents",
      "Info.plist",
    );
    try {
      if ((await Deno.stat(helper)).isFile) out.push(helper);
    } catch {
      // aio-ok: a helper app the runtime does not ship is one fewer plist to
      // rewrite, and Electron's own layout has varied across versions.
    }
  }
  return out;
}

/** Identity to stamp into a nested Electron bundle. */
export interface ElectronIdentity {
  name: string;
  identifier: string;
  iconFile: string;
  version: string;
}

/** Rewrite an XML plist's `<key>k</key>` value in place, ADDING the key when it
 *  is absent. Pure over a string, which is what makes it testable.
 *
 *  Deliberately string surgery rather than a real plist parser: the input is
 *  Electron's own generated plist, whose formatting is fixed, and a full
 *  parser/serializer would reorder keys and reformat in ways that make a diff
 *  against upstream Electron impossible to read. An absent key is appended
 *  before the closing `</dict>`, so `CFBundleDisplayName` (which Electron's
 *  helpers do not carry) can be inserted rather than skipped. */
export function setPlistValue(
  plist: string,
  key: string,
  value: string | boolean,
): string {
  const valueXml = typeof value === "boolean"
    ? `<${value ? "true" : "false"}/>`
    : `<string>${xml(value)}</string>`;
  // Match `<key>key</key>` followed by any single value element (string or the
  // boolean singletons). Non-greedy up to the next closing tag.
  const re = new RegExp(
    `(<key>\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*</key>\\s*)` +
      `(?:<string>[\\s\\S]*?</string>|<true/>|<false/>)`,
  );
  if (re.test(plist)) return plist.replace(re, `$1${valueXml}`);
  // Absent: insert just before the final </dict>.
  const at = plist.lastIndexOf("</dict>");
  if (at < 0) return plist; // not a plist dict — leave it alone
  const insertion = `\t<key>${xml(key)}</key>\n\t${valueXml}\n`;
  return plist.slice(0, at) + insertion + plist.slice(at);
}

/** Stamp the app's identity into a nested Electron bundle, so macOS shows ONE
 *  app in the Dock rather than "Electron".
 *
 *  Pure TypeScript and cross-platform: `plutil` only exists on macOS, and a
 *  Linux build host must be able to produce the same bundle a Mac would. */
export async function stampElectronIdentity(
  electronAppDir: string,
  id: ElectronIdentity,
): Promise<void> {
  const contents = join(electronAppDir, "Contents");
  // The app's icon, under the name the plist will point at.
  const iconSrc = join(contents, "Resources", `${id.iconFile}.icns`);
  void iconSrc; // written by the caller, which owns the icns bytes
  for (const plistPath of await electronPlistsFor(electronAppDir)) {
    let text: string;
    try {
      text = await Deno.readTextFile(plistPath);
    } catch {
      continue;
    }
    text = setPlistValue(text, "CFBundleName", id.name);
    text = setPlistValue(text, "CFBundleDisplayName", id.name);
    text = setPlistValue(text, "CFBundleIdentifier", id.identifier);
    text = setPlistValue(text, "CFBundleIconFile", id.iconFile);
    text = setPlistValue(text, "CFBundleShortVersionString", id.version);
    text = setPlistValue(text, "CFBundleVersion", id.version);
    await Deno.writeTextFile(plistPath, text);
  }
}

/** Remove Electron's own icon so the app's shows instead.
 *
 *  `default_app.asar` is deliberately NOT removed, and that is a fact worth
 *  recording because it looks like an obvious saving. Electron's Info.plist
 *  carries `ElectronAsarIntegrity` with that file's hash, and MEASURED on a
 *  real macOS 14 guest, deleting the asar makes Electron exit status 1 with NO
 *  output at all — an app that launches and dies in 0.3 s. Removing the
 *  integrity key too does not help. It is 112 KB; leave it. */
export async function stripElectronBranding(
  electronAppDir: string,
): Promise<void> {
  const resources = join(electronAppDir, "Contents", "Resources");
  await Deno.remove(join(resources, "electron.icns")).catch(() => {
    // aio-ok(silent-catch): absence is the outcome this wants; a runtime that
    // already omitted the file is fine.
  });
}

/** Assemble the `.app` bundle at `appDir` from a staged Electron AppDir.
 *
 *  The inputs mirror `electronStagingDir`'s contents, so this can run on any
 *  platform (a Linux CI host included) and the result is byte-for-byte what a
 *  Mac would produce minus the code signature, which is the caller's job (only
 *  `codesign` can do that, and only on macOS).
 *
 *  Returns the bundle path. */
export async function assembleMacApp(opts: {
  /** `<root>/.aio/build/AppDir` — the staged payload. */
  stagedDir: string;
  /** Where to write `<name>.app` (the build's outDir). */
  outDir: string;
  /** Display name, e.g. "Counter". */
  name: string;
  /** The compiled binary's file name inside the staged dir, e.g. "counter". */
  binaryName: string;
  /** Reverse-DNS bundle id, e.g. "app.aio.counter". */
  identifier: string;
  /** A real version string; Electron rejects non-numeric ones. */
  version: string;
  /** `.icns` bytes — the caller supplies them (see {@link icnsFromName}). */
  iconIcns: Uint8Array;
  /** Locales to keep in the nested runtime. */
  keepLocales?: readonly string[];
}): Promise<string> {
  const { stagedDir, outDir, name, binaryName, identifier, version } = opts;
  const app = join(outDir, `${name}.app`);
  await Deno.remove(app, { recursive: true }).catch(() => {
    // aio-ok(silent-catch): a fresh bundle is assembled from scratch; there is
    // nothing to preserve. A remove that fails will surface on the mkdir.
  });
  const macos = join(app, "Contents", "MacOS");
  const resources = join(app, "Contents", "Resources");
  await Deno.mkdir(macos, { recursive: true });
  await Deno.mkdir(resources, { recursive: true });

  // 1. The Deno binary IS the bundle executable. `dist/` stays out of MacOS/
  //    (it breaks the code seal) — the binary embeds it in its VFS.
  const srcBin = join(stagedDir, binaryName);
  try {
    await Deno.stat(srcBin);
  } catch {
    throw new Error(
      `${NO} ${srcBin} is missing from the staged payload — the compile step ` +
        `did not produce the bundle's executable, so this .app would be empty.`,
    );
  }
  await Deno.copyFile(srcBin, join(macos, binaryName));
  await Deno.chmod(join(macos, binaryName), 0o755).catch(() => {
    // aio-ok(silent-catch): Windows hosts have no POSIX mode bits; the copy
    // is what matters and chmod is best-effort (see chmodIfSupported).
  });

  // 2. The Electron runtime, exactly where `packagedElectronCandidates` looks:
  //    dirname(execPath)/electron/Electron.app
  const electronSrc = join(stagedDir, "electron", "Electron.app");
  const electronDst = join(macos, "electron", "Electron.app");
  await Deno.mkdir(join(macos, "electron"), { recursive: true });
  await copyDir(electronSrc, electronDst);

  // Electron's own licence files, into `Contents/Resources/` — the bundle's
  // conventional home for them, and the location `codesign` is happy with
  // (`Contents/MacOS/` is code-only, which is the same rule that keeps `dist/`
  // out of it). The Linux and Windows packages carry these beside the runtime;
  // a macOS app that redistributes Chromium and Electron must carry them too,
  // and copying only `Electron.app` (the files sit BESIDE it in the published
  // runtime) dropped them silently.
  for (const name of ["LICENSE", "LICENSES.chromium.html"]) {
    await Deno.copyFile(
      join(stagedDir, "electron", name),
      join(resources, name),
    ).catch(() => {
      // aio-ok: a runtime that ships no licence file is not a reason to fail a
      // build; every official Electron release includes them.
    });
  }

  // 3. Identity + icon on the nested runtime — the difference between a Dock
  //    entry called "Counter" and one called "Electron".
  const iconName = "AppIcon";
  await Deno.writeFile(join(resources, `${iconName}.icns`), opts.iconIcns);
  await Deno.writeFile(
    join(electronDst, "Contents", "Resources", `${iconName}.icns`),
    opts.iconIcns,
  );
  await stripElectronBranding(electronDst);
  await stampElectronIdentity(electronDst, {
    name,
    identifier,
    iconFile: iconName,
    version,
  });

  // 4. Trim the translations — the biggest safe saving in the bundle.
  const fwResources = join(
    electronDst,
    "Contents",
    "Frameworks",
    "Electron Framework.framework",
    "Versions",
    "A",
    "Resources",
  );
  const keep = opts.keepLocales ?? DEFAULT_KEPT_LOCALES;
  const removed = trimLprojLocales(fwResources, keep);
  // The top-level Resources also carries empty per-language stubs.
  trimLprojLocales(join(electronDst, "Contents", "Resources"), keep);

  // 5. The bundle's own identity.
  await Deno.writeTextFile(
    join(app, "Contents", "Info.plist"),
    macAppPlist({
      name,
      executable: binaryName,
      identifier,
      iconFile: iconName,
      version,
    }),
  );
  await Deno.writeFile(join(app, "Contents", "PkgInfo"), pkgInfo());

  if (removed > 0) {
    console.log(
      `${OK} trimmed ${removed} unused locale(s) from the Electron runtime`,
    );
  }
  return app;
}
