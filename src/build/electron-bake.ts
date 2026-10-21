/**
 * Does this build bake `dist/electron.json` (the Electron version a compiled
 * binary's launcher fetches)? Only a plain compiled binary that could launch
 * Electron: not the CLI, the connect-page client, Android or iOS — and not a
 * HEADLESS (server-kind) binary, which carries no UI to put in a window. It
 * used to ship the file too, telling anyone reading `dist/` that a relay
 * server runs Electron 44 (a user-driven hunt). A browser-kind binary keeps
 * it: it can still be launched with `--client=electron`.
 */
export function bakesElectronVersion(b: {
  doCompile: boolean;
  doCli: boolean;
  doClient: boolean;
  doAndroid: boolean;
  doIos: boolean;
  doHeadless?: boolean;
}): boolean {
  return b.doCompile && !b.doCli && !b.doClient && !b.doAndroid && !b.doIos &&
    !b.doHeadless;
}

/** The `dist/electron.json` record. Pure.
 *
 *  - `sha256` (the pinned checksums, an `online` build only) makes it
 *    `runtime: "shared"`: the launcher looks in the per-user store.
 *  - `client`: an online binary that does not boot in Electron says which
 *    client it does, so its update fetches no ~100 MB Electron for a binary
 *    that opens in a browser (`prefetchSharedElectron`); its first
 *    `--client=electron` start downloads with the progress window, as any
 *    online start does.
 *  - `splash` (`build.splash`) is drawn before any app code runs.
 *
 *  Each is left out when it does not apply, so an offline record, and a
 *  desktop package's, is byte-for-byte what it was. */
export function electronRecord(r: {
  version: string;
  sha256?: Record<string, string>;
  client?: string;
  splash?: unknown;
}): Record<string, unknown> {
  return {
    ...(r.sha256
      ? { version: r.version, runtime: "shared", sha256: r.sha256 }
      : { version: r.version }),
    ...(r.sha256 && r.client && r.client !== "electron"
      ? { client: r.client }
      : {}),
    ...(r.splash ? { splash: r.splash } : {}),
  };
}
