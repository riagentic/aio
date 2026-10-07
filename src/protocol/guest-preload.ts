/** The `<webview>` guest-preload contract, shared by the app's page
 *  (`guestPreload()`, `<Browser preload>`), the Electron main process (the
 *  `will-attach-webview` hook in `src/electron/electron-shared.ts`) and the
 *  build (`build.guestPreloads` staging). One home, so the sides cannot
 *  drift. Pure, dependency-free. */

/** What a declared guest preload is called in the page: this prefix plus the
 *  path it was declared under. A `file:` URL because Electron drops any other
 *  scheme from a `<webview preload>` before the main process sees it — but it
 *  names no file: the main process maps it onto the declared file, wherever
 *  this run keeps it (the project in dev, the package's `dist/` when built).
 *  @internal */
export const GUEST_PRELOAD_URL = "file:///aio-guest-preload/";

/** The event the app's `window` receives when the main process refuses a
 *  `<webview>` preload: a `CustomEvent` whose `detail` is
 *  `{ preload, reason }`. */
export const GUEST_PRELOAD_REFUSED_EVENT = "aio:guest-preload-refused";

/** Why `path` cannot be declared in deno.json `build.guestPreloads`, or null.
 *  A declared path is relative to the deno.json, `/`-separated, and made of
 *  plain segments (letters, digits, `.`, `_`, `-`) — so it reads the same in
 *  a URL, on every OS, and can never climb out of the directory it is
 *  resolved in. Pure. */
export function guestPreloadRefusal(path: unknown): string | null {
  if (typeof path !== "string" || path === "") {
    return "it must be a non-empty string";
  }
  // aio-ok: path-split — a declared name, `/`-separated on every OS
  for (const seg of path.split("/")) {
    if (seg === "") {
      return "it must be relative to the deno.json, with single `/` separators";
    }
    if (seg === "." || seg === "..") {
      return "`.` and `..` segments are not allowed";
    }
    if (!/^[A-Za-z0-9._-]+$/.test(seg)) {
      return "only letters, digits, `.`, `_` and `-` are allowed in a " +
        "segment (and `/` between them)";
    }
  }
  return null;
}

/**
 * The `preload` of a `<webview>` guest: a file this app declared in deno.json
 * `build.guestPreloads`, named the same way in `deno task dev` and in every
 * packaged build.
 *
 * ```tsx
 * // deno.json: "build": { "guestPreloads": ["src/dapp/preload.cjs"] }
 * <webview src={url} preload={guestPreload("src/dapp/preload.cjs")} />
 * ```
 *
 * `path` is the declared one, verbatim (relative to the deno.json). An
 * undeclared path is refused when the guest attaches — in dev too — and the
 * refusal is logged and dispatched as `aio:guest-preload-refused` on `window`.
 */
export function guestPreload(path: string): string {
  const why = guestPreloadRefusal(path);
  if (why) {
    throw new TypeError(
      `guestPreload(${JSON.stringify(path)}): ${why}. Pass the path exactly ` +
        `as declared in deno.json build.guestPreloads, e.g. ` +
        `"src/guest/preload.cjs".`,
    );
  }
  return GUEST_PRELOAD_URL + path;
}
