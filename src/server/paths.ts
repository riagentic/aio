// Path resolution utilities — extracted from aio.ts (AIO-52)
// Pure functions for resolving KV, SQLite, UDS, and data directory paths.

import { fromFileUrl, join, resolve } from "@std/path";
import { lockDir } from "./single-instance-lock.ts";
import { log } from "../diagnostics/logger.ts";

/** True when running inside a compiled binary (AppImage, deno compile) */
export function isCompiled(): boolean {
  if (Deno.env.get("APPIMAGE")) return true;
  // Deno compile VFS: modules embedded at file:///tmp/deno-compile-<app>/...
  if (import.meta.url.includes("/deno-compile-")) return true;
  return !import.meta.url.startsWith("file://");
}

/** Ordered `dist/` candidates for prod-detection in a COMPILED binary, most
 *  authoritative first. Pure (every input injected) so the ORDER — the part
 *  that broke — is unit-testable without compiling.
 *
 *  A compiled binary embeds `dist/` (via `--include dist/`) into the VFS next
 *  to the entry module, so entry-relative paths are the only candidates that
 *  hold regardless of cwd, exec location, or `dep/aio` nesting depth. They MUST
 *  come first: probing the real filesystem first (cwd, exec dir, module root)
 *  means a binary run from any directory without a real `dist/` beside it fails
 *  to detect prod, falls back to the dev lint (which needs `src/App.tsx` at
 *  cwd) and crashes — e.g. from an AppImage mount or a moved binary. */
export function distCandidates(opts: {
  mainModule: string;
  cwd: string;
  execDir: string;
  moduleDir: string | null;
}): string[] {
  const entryDist: string[] = [];
  try {
    for (const rel of ["../dist", "./dist"]) {
      entryDist.push(fromFileUrl(new URL(rel, opts.mainModule)));
    }
  } catch { /* mainModule not a file: URL — skip */ }
  return [...entryDist, ...realDistCandidates(opts)];
}

/** The subset of `distCandidates` that lives on the REAL filesystem — i.e. the
 *  ones a FOREIGN process can open.
 *
 *  Entry-relative candidates are deliberately excluded: in a compiled binary
 *  they point into Deno's virtual FS (`/tmp/deno-compile-<app>/…`), which only
 *  the Deno process can read. `Deno.stat` happily resolves it, so handing that
 *  path to Electron produced a path that exists for us and not for it — the
 *  AppImage blank-window bug: Electron's `fs.existsSync` said no, it fell back
 *  to `http://localhost:<port>`, and prod had already skipped the TCP server. */
export function realDistCandidates(opts: {
  cwd: string;
  execDir: string;
  moduleDir: string | null;
}): string[] {
  const moduleRoot = opts.moduleDir
    ? resolve(opts.moduleDir, "..", "..", "..")
    : null;
  return [
    resolve(join(opts.cwd, "dist")),
    resolve(join(opts.execDir, "dist")),
    ...(moduleRoot ? [resolve(join(moduleRoot, "dist"))] : []),
  ];
}

/** Returns user home directory — $HOME or $USERPROFILE, throws if neither set */
export function homedir(): string {
  const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE");
  if (!home) {
    throw new Error(
      "Cannot determine home directory — set $HOME environment variable",
    );
  }
  return home;
}

/** LEGACY layout only — `~/.local/share/<appId>/`, where auth.db / app.key /
 *  data.kv lived before the one-directory move. Both remaining callers only
 *  LOOK for files here (the migration, and the old-KV import), so this must not
 *  create the directory: doing so re-created the very location the move exists
 *  to retire, on every boot, for every app that had never used it.
 *  New code uses `appDirs()` — see src/server/app-dirs.ts. */
export function resolveDataDirLegacy(appId: string): string {
  const dataHome = Deno.env.get("XDG_DATA_HOME") ??
    join(homedir(), ".local", "share");
  return join(dataHome, appId);
}

/** LEGACY KV path — compiled apps only (dev let Deno pick its own location).
 *  Read to import an old `Deno.Kv` store into SQLite, nothing more. */
export function resolveKvPath(appId: string): string | undefined {
  if (!isCompiled()) return undefined;
  return join(resolveDataDirLegacy(appId), "data.kv");
}

/** Resolves transport: UDS on linux/mac with electron, WS otherwise */
export function resolveTransport(
  transport: "uds" | "ws" | "auto" | undefined,
  useElectron: boolean,
  expose: boolean,
): "uds" | "ws" {
  if (transport === "ws") return "ws";
  if (transport === "uds") return "uds";
  if (
    useElectron && !expose &&
    (Deno.build.os === "linux" || Deno.build.os === "darwin")
  ) return "uds";
  return "ws";
}

/** Resolves UDS socket path — /tmp/aio/{appId}.sock (same dir as lock files) */
export function resolveSocketPath(appId: string): string {
  const dir = lockDir();
  const sockPath = join(dir, `${appId}.sock`);
  if (sockPath.length > 100) {
    log.warn(
      `UDS path is ${sockPath.length} chars (limit ~108) — using /tmp/aio fallback`,
    );
    return join("/tmp/aio", `${appId}.sock`);
  }
  return sockPath;
}

/** Find a free port in the private/ephemeral range 49152–65535 by attempting to bind */
export function findFreePort(): number {
  for (let i = 0; i < 50; i++) {
    const port = 49152 + Math.floor(Math.random() * 16384);
    try {
      const l = Deno.listen({ port, hostname: "127.0.0.1" });
      l.close();
      return port;
    } catch { /* taken — try another */ }
  }
  throw new Error(
    "no free port found in 49152-65535 after 50 attempts — the ephemeral range looks exhausted. Set an explicit port via aio.run({ port }) or --port=N.",
  );
}
