// open-external.ts — the per-OS "open this on the desktop" launcher, once.
//
// Three field-report apps (a disk analyzer, a config manager, this repo's own
// dev-server fallback) each re-derived the darwin/windows/linux ternary; the
// framework itself carried two more copies. One exported helper, fail-loud.

import { log } from "../diagnostics/logger.ts";

/** Open a file, folder or URL with the OS default handler (`open` /
 *  `start` / `xdg-open`) — the desktop app pattern "reveal in file manager" /
 *  "open in browser", from a cell method or serverFn. Server-only.
 *
 *  Resolves when the launcher hands off; rejects (never silently) when the
 *  launcher is missing or refuses the target. */
export async function openExternal(target: string): Promise<void> {
  if (typeof target !== "string" || target.length === 0) {
    throw new Error("openExternal: target must be a non-empty string");
  }
  const os = Deno.build.os;
  // Windows `start` is a cmd builtin, not an executable — it must go through
  // `cmd /c`, with an empty title argument so a quoted path is not eaten as
  // the window title.
  const [cmd, args]: [string, string[]] = os === "darwin"
    ? ["open", [target]]
    : os === "windows"
    ? ["cmd", ["/c", "start", "", target]]
    : ["xdg-open", [target]];
  const child = new Deno.Command(cmd, {
    args,
    stdout: "null",
    stderr: "null",
  }).spawn();
  const status = await child.status;
  if (!status.success) {
    throw new Error(
      `openExternal: ${cmd} exited with code ${status.code} for "${target}"`,
    );
  }
}

/** Framework-internal: best-effort variant for the dev-server's own
 *  browser-open fallbacks — logs instead of throwing (the server keeps
 *  serving either way; the URL is printed for a human to click). */
export function openExternalBestEffort(target: string): void {
  openExternal(target).catch(() => {
    log.info(`open ${target} in your browser`);
  });
}
