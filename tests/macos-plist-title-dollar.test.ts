// Bug hunt r3 (build/macOS): `setPlistValue` — used by `stampElectronIdentity`
// to write the app's TITLE into the nested Electron runtime's Info.plist —
// passes the escaped value as a STRING replacement to `String.replace`, so
// `$&`, `$1`, `$$`, `` $` `` and `$'` inside the title are interpreted as
// replacement patterns. build-android.ts `_fillTemplate` documents and fixes
// exactly this class ("Cash $$ Register" → "Cash $ Register", "Cost $& Saver"
// → spliced markup); the macOS path still has it. The module's own doc says
// every value "is escaped exactly once".
import { assertStringIncludes } from "@std/assert";
import { setPlistValue } from "../src/build/macos-app.ts";

const PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
\t<key>CFBundleName</key>
\t<string>Electron</string>
\t<key>CFBundleIdentifier</key>
\t<string>com.github.Electron</string>
</dict>
</plist>
`;

Deno.test("hunt-r3 build: setPlistValue writes a title with `$$` verbatim", () => {
  const out = setPlistValue(PLIST, "CFBundleName", "Cash $$ Register");
  assertStringIncludes(out, "<string>Cash $$ Register</string>");
});

Deno.test("hunt-r3 build: setPlistValue writes a title with `$&` verbatim", () => {
  const out = setPlistValue(PLIST, "CFBundleName", "Cost $& Saver");
  // `&` is XML-escaped once; the `$` must survive as a literal.
  assertStringIncludes(out, "<string>Cost $&amp; Saver</string>");
});
