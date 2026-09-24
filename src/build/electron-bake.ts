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
