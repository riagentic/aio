// dist/ is STAGING: whatever survives this clean ships inside the binary.
//
// That makes the keep-rule an ALLOWLIST, and an allowlist is where a new
// artifact goes to be silently dropped. It happened once already, to the
// client bundle's source map: the bundle step wrote `dist/.app.js.map`, the
// server read it at boot, and the staging clean deleted it in between — the
// feature present at both ends and absent in the middle, with nothing to see
// but forwarded errors that kept saying `app.js:1:22073`.
//
// So the rule is a named predicate and this asks it directly.
import { assert } from "@std/assert";
import { keepInDistStaging } from "../src/build/dist-staging.ts";
import {
  APP_ICON,
  APP_STYLE,
  BUNDLE_JS,
  BUNDLE_MAP,
} from "../src/server/app-files.ts";
import { ELECTRON_VERSION_FILE } from "../src/electron/electron-runtime-fetch.ts";

Deno.test("everything the binary needs survives the staging clean", () => {
  for (
    const keep of [
      BUNDLE_JS,
      APP_STYLE,
      APP_ICON,
      ELECTRON_VERSION_FILE,
      BUNDLE_MAP,
    ]
  ) {
    assert(
      keepInDistStaging(keep),
      `${keep} is staged for the binary and must survive the clean — ` +
        `deleting it here is invisible at both ends`,
    );
  }
});

Deno.test("a previous target's leftovers do NOT survive", () => {
  // The reason the rule is an allowlist and not "files this build wrote".
  for (
    const drop of [
      "ex-counter-0.1.0",
      "manifest.json",
      "app.js.map", // the SERVED spelling — see below
      "linux-x64",
      "some-old-artifact",
    ]
  ) {
    assert(
      !keepInDistStaging(drop),
      `${drop} would ship inside the next binary`,
    );
  }
});

Deno.test("the map that survives is the UNSERVABLE spelling", () => {
  // `.map` is in SHELL_EXT, so `dist/app.js.map` is servable: the app's whole
  // source over an unauthenticated read. The dot-prefixed name is refused by
  // `isProtectedPath` at any depth. These two facts are one decision, so the
  // allowlist must keep the safe name and drop the dangerous one.
  assert(BUNDLE_MAP.startsWith("."), `${BUNDLE_MAP} must be a dotfile`);
  assert(keepInDistStaging(BUNDLE_MAP));
  assert(!keepInDistStaging(`${BUNDLE_JS}.map`));
});
