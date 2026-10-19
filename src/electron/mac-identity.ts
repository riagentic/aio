/**
 * @module
 * The app's identity on a macOS Electron bundle — its plists, its icon file
 * name, its version — stamped by string surgery so it runs the same on any
 * host. Used at BUILD time on the nested runtime of a bundled `.app`
 * (build/macos-app.ts), and at RUN time on the user's Mac for the window
 * bundle of a `"build": { "electronRuntime": "online" }` app
 * (shared-runtime.ts), so the two cannot drift.
 */
import { join } from "@std/path";

/** XML-escape a plist string value. */
export function xml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
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
  // A replacer FUNCTION, never a string: in a replacement string `$&`, `$$`,
  // `$\`` and `$'` are patterns, so a title like "Cost $& Saver" pasted the
  // matched plist back into itself (the class build-android's _fillTemplate
  // already closed).
  if (re.test(plist)) {
    return plist.replace(re, (_m, pre: string) => pre + valueXml);
  }
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
