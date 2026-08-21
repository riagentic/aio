// framework-pin.ts — ONE answer to "is `dep/aio` linked to what the app pinned?"
//
// A source-layout app records its framework in `deno.json` as
// `"aioVersion": "v1.0.0-alpha42"` and imports through a gitignored `dep/aio`
// symlink. Two tools report on that pairing — `am pin` (status/drift) and
// `aio doctor` — and they used to decide it independently:
//
//   am pin:  linkedPath === pathPinTarget(pin)   for a path pin,
//            else basename-under-the-version-store
//   doctor:  last path segment of the link === the raw pin string
//
// So a LOCAL-DEV pin (`aioVersion: "path:/home/me/aio"`, what `am pin <path>`
// writes for framework co-development) made `am pin` say "linked as pinned" and
// `aio doctor` say
//     FAIL framework pin matches dep/aio (path:/home/me/aio)
//     fix: dep/aio points at aio, not path:/home/me/aio — run `am fix`
// — red forever on a correct setup, exiting 1 in CI, and the advice was a
// no-op: `am fix` recreates exactly the link doctor was complaining about.
// The same restatement also made doctor pass on a link that merely ENDS with
// the pin's name while pointing outside the version store.
//
// The rule lives here, once. `server` may not import `am` (see
// scripts/check-boundaries.ts) and `am` may import `server`, so this is the
// side both can share.

import { dirname, join, resolve } from "@std/path";
import { homedir } from "./paths.ts";

/** A LOCAL-DEV pin: `aioVersion: "path:/abs/checkout"` — the app follows a
 *  framework checkout on THIS machine (framework co-development). */
export const PATH_PIN_PREFIX = "path:";

/** Is this pin a local-dev path pin rather than a provisioned version ref? */
export function isPathPin(ref: string): boolean {
  return ref.startsWith(PATH_PIN_PREFIX);
}

/** The checkout a path pin names. */
export function pathPinTarget(ref: string): string {
  return ref.slice(PATH_PIN_PREFIX.length);
}

/** Where provisioned versions live: `~/.local/lib/aio-versions/<ref>/`. */
export function versionsDir(): string {
  return Deno.env.get("AIO_VERSIONS_DIR") ??
    join(homedir(), ".local", "lib", "aio-versions");
}

/** Path a given ref is (or would be) provisioned at. */
export function versionPath(ref: string): string {
  return join(versionsDir(), ref);
}

/** The version ref a `dep/aio` target names — null when the link points
 *  somewhere other than the version store (a hand-made link, a vendored copy,
 *  a local checkout), because then it names no version at all. */
export function refOfLink(target: string): string | null {
  const base = dirname(target);
  return base === versionsDir() ? target.slice(base.length + 1) : null;
}

/** The directory `dep/aio` must point at for `pin` to be satisfied. */
export function pinnedFrameworkPath(pin: string): string {
  return isPathPin(pin) ? pathPinTarget(pin) : versionPath(pin);
}

/** Does a `dep/aio` link satisfy the app's pin? THE decider — every tool that
 *  reports pin/link agreement asks this, so they cannot contradict each other. */
export function linkSatisfiesPin(pin: string, linkedPath: string): boolean {
  return isPathPin(pin)
    ? resolve(linkedPath) === resolve(pathPinTarget(pin))
    : refOfLink(linkedPath) === pin;
}

/** Why a VERSION pin and this link disagree, said as a choice rather than a
 *  dead end.
 *
 *  `dep/aio -> ../../aio` (a sibling framework checkout) is the documented
 *  co-development setup, and writing the plain version — the obvious thing —
 *  makes it permanently red: doctor FAILs, aiol WARNs, and the offered fix,
 *  `am fix`, would "resolve" it by relinking away from the checkout the
 *  developer deliberately chose. Nothing said that `path:` pins exist, so the
 *  only visible exit was the wrong one. A field report spent 15 minutes
 *  chasing a FAIL that was not a defect.
 *
 *  Returns null when the link is under the version store, where "run `am fix`"
 *  really is the whole answer. */
export function pinDisagreementHint(
  pin: string,
  linkedPath: string,
): string | null {
  if (isPathPin(pin) || refOfLink(linkedPath) !== null) return null;
  return `dep/aio points at a CHECKOUT (${linkedPath}), not a release in ` +
    `${versionsDir()}. Two ways forward, and only you know which: keep the ` +
    `checkout and pin it — \`am pin path:${resolve(linkedPath)}\` — or ` +
    `follow the release and relink with \`am fix\` (which points dep/aio at ` +
    `${versionPath(pin)}).`;
}
