// app-version.ts — `appVersion()`: the app's own version, in the page.
//
// `aio/server`'s `appVersion()` reads deno.json and the build stamp — a page
// with no server (a standalone APK, the web target) had no way to show
// "App version 0.2.5" short of a second, hand-stamped constant that drifts
// from the build's. Every shell aio writes now carries the resolved version
// in `window.__aioConfig.appVersion` (the server's shell in dev and prod, the
// packaged Electron shell, the APK and web builds). On the server — where a
// page is server-rendered — it is the version the server runs
// (`globalThis.__aioAppVersion`, set by the server's boot), so SSR and the browser render the same
// text. A page whose shell carries none (one from an older build) falls back
// to the version its server announced in the hello.
import type { AioWindow } from "../protocol/protocol-types.ts";
import { peerHello } from "../protocol/protocol-version.ts";

/** The version of the app this page belongs to — `major.minor.build`, the
 *  same string `aio/server`'s `appVersion()`, `--version` and the build's
 *  artifact names carry (`1.2.345`, `1.2.346-dirty.0c7e11aa`). `null` when
 *  nothing told the page (a shell no aio build wrote, before a server hello,
 *  an in-process test) or the version could not be resolved (the server's
 *  `unknown (…)` is a sentence for a log, not a version to show).
 *
 * @example
 * ```tsx
 * import { appVersion } from "aio/air";
 * const About = () => <p>App version {appVersion() ?? "unknown"}</p>;
 * ```
 */
export function appVersion(): string | null {
  const g = globalThis as AioWindow & {
    __aioAppVersion?: unknown;
    document?: unknown;
  };
  const v = g.__aioConfig?.appVersion ?? g.__aioAppVersion ??
    // A hello is a client's fact about its server: only a PAGE takes that
    // version as its own (a CLI client of another app must not).
    (g.document !== undefined ? peerHello()?.app : undefined);
  return typeof v === "string" && /^\d+\.\d+\.\d+/.test(v) ? v : null;
}
