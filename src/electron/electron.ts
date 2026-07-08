// Electron launcher — barrel re-export from split modules

export type { AioMeta } from "./electron-shared.ts";
export { electronMainScript } from "./electron-scripts.ts";
export { electronClientScript } from "./electron-client-script.ts";
export { electronMainScriptUDS } from "./electron-uds.ts";
export {
  findElectronBin,
  launchElectron,
  launchElectronClient,
} from "./electron-spawn.ts";
