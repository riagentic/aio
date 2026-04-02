// Boot orchestration — composes all boot steps into a structured startup context
export { handleCliExit, parseCli, type ParsedCli, printHelp } from "./cli.ts";
export { type BootLock, bootLock, type LockOptions } from "./lock.ts";
export {
  type BootIdentity,
  bootIdentity,
  type IdentityOptions,
} from "./identity.ts";
export {
  buildCertificateHandler,
  buildKeyboardShortcuts,
  buildWillNavigateHandler,
  type ElectronWindowMeta,
  escapeForExecuteJavaScript,
  requireElectronVersion,
  toSlug,
  WINDOW_STATE_HELPERS,
} from "./electron-helpers.ts";
