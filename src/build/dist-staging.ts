// dist-staging.ts — what survives the clean that runs before `deno compile`.
//
// NOT exported from `src/build.ts`. That file is the `aio/build` entry, so
// anything on it is public surface and frozen forever; this is an internal
// rule about one directory, and a rule does not become an API by needing a
// test.
import {
  APP_ICON,
  APP_STYLE,
  BUNDLE_JS,
  BUNDLE_MAP,
} from "../server/app-files.ts";
import { ELECTRON_VERSION_FILE } from "../electron/electron-runtime-fetch.ts";

/** Which `dist/` entries survive the staging clean that runs before
 *  `deno compile`.
 *
 *  dist/ is STAGING, never a destination: anything left in it ships inside the
 *  binary, so the clean cannot be narrowed to "files this build wrote" without
 *  also shipping the previous target's leftovers. That makes this an
 *  ALLOWLIST, and an allowlist is a place for a new artifact to be silently
 *  dropped — which is exactly what happened to `BUNDLE_MAP`: the bundle step
 *  wrote it and the server read it, and this loop deleted it in between, so
 *  the feature was present at both ends and absent in the middle. A named,
 *  tested predicate is the fix: adding a staged file means adding it here, and
 *  a test can ask the question directly. */
export function keepInDistStaging(name: string): boolean {
  return name === BUNDLE_JS || name === APP_STYLE ||
    name === APP_ICON || name === ELECTRON_VERSION_FILE ||
    // The client bundle's source map — how a forwarded browser error names
    // the author's file instead of `app.js:1:22073`.
    name === BUNDLE_MAP;
}
