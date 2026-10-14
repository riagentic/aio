// The opt-in security switches an EXISTING app has not decided on.
//
// A few doors are closed only by a key the app sets, because closing them by
// default would change an app that already ships: a paired client that still
// connects after the server regenerated its certificate, a desktop app a
// harness drives through `AIO_CDP`. `am create` writes the safe value into a
// new app; for an older one `am doctor` names the open door (a hint — never
// an error, never an exit code) and `am fix --harden` closes the ones a
// deno.json edit can close. Nothing here changes an app that was not asked to.
import { stripComments, updatesKeyOnFirstUse } from "../build/capabilities.ts";

export type HardenFinding = {
  /** The key, as the app would write it. */
  key:
    | "build.strictPin"
    | "build.android.strict"
    | "electron.strictPin"
    | "electron.ignoreDebugEnv"
    | "updates.key";
  /** Where it goes: `deno.json`, or the entry (`aio.run()` — app source). */
  file: "deno.json" | "entry";
  /** The open door, in one sentence, and the key that closes it. */
  hint: string;
  /** Exactly what to write. */
  write: string;
};

/** Does the entry SAY anything about `key` — `true`, `false`, or a value
 *  computed elsewhere? Any of them is the app's decision. Pure. */
const decides = (code: string, key: string) =>
  new RegExp(`\\b${key}\\b`).test(code);

/** `am doctor`'s hint for an app with an Android target that has not chosen
 *  `android.colorScheme` — or null. Not a hardening switch (`am fix --harden`
 *  never writes it: it changes how the app LOOKS), the same shape of problem:
 *  the default is what 1.0.19 did, the better value is opt-in. Pure. */
export function androidColorSchemeHint(
  cfg: Record<string, unknown>,
  targets: readonly string[],
): string | null {
  const android = (cfg.android ?? {}) as Record<string, unknown>;
  if (!targets.some((t) => t.startsWith("android"))) return null;
  if ("colorScheme" in android) return null;
  return `the Android app shows its dark colours on every phone: with no ` +
    `android.colorScheme the page sees prefers-color-scheme: dark whatever ` +
    `the phone is set to, as every APK through 1.0.19 did. "android": { ` +
    `"colorScheme": "system" } in deno.json follows the phone's light/dark ` +
    `setting ("dark" keeps today's look and ends this hint)`;
}

/** `am doctor`'s hints for help that already shipped and this app does not
 *  use: a fix that is an opt-in reaches an app only when somebody tells it. A
 *  field report listed five of its own asks as "still open" two releases
 *  after they were built — "the fix ships, the reporting app does not learn
 *  of it". Hints only: nothing is written, no exit code moves, and each ends
 *  when the app decides either way (`"smoke": false`, `workerRespawn: false`).
 *  `sources` is the app's own code, comments stripped by the caller or not.
 *  Pure. */
export function shippedHelpHints(
  cfg: Record<string, unknown>,
  targets: readonly string[],
  sources: readonly { path: string; code: string }[],
): string[] {
  const out: string[] = [];
  const build = (cfg.build ?? {}) as Record<string, unknown>;
  // Said to an app whose package carries files a build can leave out — a
  // guest preload, a file its server reads — which is where a packaging gap
  // reached users. A new app (`am create`) declares neither, so it is not
  // told about a check it has nothing yet to fail.
  const compile = (cfg.compile ?? {}) as Record<string, unknown>;
  const carries = "guestPreloads" in build || "include" in compile;
  if (targets.length > 0 && carries && !("smoke" in build)) {
    out.push(
      `this app's builds are not started before they ship: "build": { ` +
        `"smoke": true } in deno.json (or \`deno task build --smoke\`) ` +
        `starts each built artifact and fails the build when it does not ` +
        `come up clean — a missing file in the package is found by the ` +
        `build, not by a user ("smoke": false ends this hint)`,
    );
  }
  const named = (hits: string[]) =>
    hits.slice(0, 3).join(", ") +
    (hits.length > 3 ? ` and ${hits.length - 3} more` : "");
  const dead = sources.filter(({ code }) => {
    const c = stripComments(code);
    return /\bworker\s*:\s*true\b/.test(c) && !/\bworkerRespawn\b/.test(c);
  }).map((x) => x.path);
  if (dead.length > 0) {
    out.push(
      `a \`worker: true\` cell that crashes stays dead until the app ` +
        `restarts (${named(dead)}): \`workerRespawn: true\` beside it ` +
        `starts a new worker on the committed state, and stops at the third ` +
        `crash in 60 s (\`workerRespawn: false\` ends this hint)`,
    );
  }
  const raw = sources.filter(({ code }) =>
    /\bVACUUM\s+INTO\b/i.test(stripComments(code))
  ).map((x) => x.path);
  if (raw.length > 0) {
    out.push(
      `a hand-written VACUUM INTO (${named(raw)}) fails on macOS when the ` +
        `target folder is reached through a symlink: \`db.snapshot(target)\` ` +
        `resolves the folder first and checks the copy`,
    );
  }
  return out;
}

/** Where an app's own Android activity lives — the file an `android/`
 *  overlay replaces the template's with (`_overlay` in build-android.ts). */
export const OWN_ACTIVITY = "android/app/src/main/java/aio/app/MainActivity.kt";

/** Does the app in `dir` overlay its own `MainActivity.kt`? */
export const ownsActivity = (dir: string): Promise<boolean> =>
  Deno.stat(`${dir}/${OWN_ACTIVITY}`).then((s) => s.isFile, () => false);

/** THE decider, pure: the switches this app's shape makes relevant and that
 *  neither its deno.json nor its entry has decided. `targets` is the fleet
 *  the app declares (`declaredTargets`); `entrySrc` null = no readable entry,
 *  so nothing is claimed about `aio.run()`; `ownActivity` — the app overlays
 *  its own `MainActivity.kt` ({@linkcode ownsActivity}). */
export function hardenFindings(
  cfg: Record<string, unknown>,
  targets: readonly string[],
  entrySrc: string | null,
  ownActivity = false,
): HardenFinding[] {
  const out: HardenFinding[] = [];
  const build = (cfg.build ?? {}) as Record<string, unknown>;
  const tasks = Object.values((cfg.tasks ?? {}) as Record<string, unknown>)
    .filter((t): t is string => typeof t === "string");
  const code = entrySrc === null ? null : stripComments(entrySrc);
  // True of the default since the pin proof (src/server/pin-proof.ts): the
  // key is withheld from an address that cannot prove it holds it — once
  // the pairing has seen the real server prove. Until then it is sent.
  const hole = "a paired client that finds another certificate at the " +
    "server's address still sends it the saved key, unless that pairing has " +
    "already seen the server prove it holds the key (a server on aio " +
    "1.0.20 or newer, connected to once)";
  const cost = "a client must then pair again after the server's " +
    "certificate is regenerated";

  if (targets.includes("electron-client") && !("strictPin" in build)) {
    out.push({
      key: "build.strictPin",
      file: "deno.json",
      hint: `the packaged Electron client is built without the strict pin: ` +
        `${hole}. "build": { "strictPin": true } in deno.json refuses ` +
        `instead (${cost})`,
      write: `"build": { "strictPin": true }`,
    });
  }
  const android = build.android;
  if (
    ownActivity &&
    !(android && typeof android === "object" && "strict" in android)
  ) {
    out.push({
      key: "build.android.strict",
      file: "deno.json",
      hint: `this app replaces the Android template's activity with its own ` +
        `(${OWN_ACTIVITY}), and a build only WARNS when that file drops ` +
        `something the template's does — the page-only bridge, the ` +
        `on-device store, the insets frame, Back: a release can ship ` +
        `without one because a warning scrolled past. "build": { ` +
        `"android": { "strict": true } } in deno.json fails the build ` +
        `instead (an overlay that already warns then builds no APK until ` +
        `it is fixed)`,
      write: `"build": { "android": { "strict": true } }`,
    });
  }
  if (
    code !== null && !decides(code, "strictPin") &&
    (tasks.some((t) => t.includes("--server-url")) ||
      decides(code, "serverUrl"))
  ) {
    out.push({
      key: "electron.strictPin",
      file: "entry",
      hint: `this app launches a remote Electron client (--server-url) ` +
        `without the strict pin: ${hole}. electron: { strictPin: true } in ` +
        `aio.run() refuses instead (${cost})`,
      write: `electron: { strictPin: true }`,
    });
  }
  if (
    code !== null && targets.includes("electron") &&
    !decides(code, "ignoreDebugEnv")
  ) {
    out.push({
      key: "electron.ignoreDebugEnv",
      file: "entry",
      hint: `the desktop app reads AIO_CDP and AIO_PORT from its ` +
        `environment: a variable left there by another app opens a DevTools ` +
        `or TCP port on this one. electron: { ignoreDebugEnv: true } in ` +
        `aio.run() ignores them (--cdp and --port keep working; a harness ` +
        `that sets the variables must pass the flags)`,
      write: `electron: { ignoreDebugEnv: true }`,
    });
  }
  if (code !== null && updatesKeyOnFirstUse(entrySrc!)) {
    out.push({
      key: "updates.key",
      file: "entry",
      hint: `this app trusts its release signing key on first use: an ` +
        `install whose FIRST update check is answered by someone who took ` +
        `over the release host pins their key for good. ` +
        `updates: { key: <the public key \`am publish\` prints> } in ` +
        `aio.run() ships the key inside the app instead (an install that ` +
        `already pinned this key is unchanged; one that pinned ANOTHER key ` +
        `follows the configured one from that build on — so it must be the ` +
        `key your releases are signed with)`,
      write: `updates: { key: <the public key \`am publish\` prints> }`,
    });
  }
  return out;
}
