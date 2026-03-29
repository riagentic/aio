// Path resolution utilities — extracted from aio.ts (AIO-52)
// Pure functions for resolving KV, SQLite, UDS, and data directory paths.

import { join } from "@std/path";
import { lockDir } from "./single-instance-lock.ts";
import { log } from "./logger.ts";

/** True when running inside a compiled binary (AppImage, deno compile) */
export function isCompiled(): boolean {
  return !!Deno.env.get("APPIMAGE") || !import.meta.url.startsWith("file:///");
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

/** Resolves persistent data dir — ~/.local/share/<appId>/ */
export function resolveDataDir(appId: string): string {
  const dataHome = Deno.env.get("XDG_DATA_HOME") ??
    join(homedir(), ".local", "share");
  const dir = join(dataHome, appId);
  Deno.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Resolves KV path — compiled: ~/.local/share/<appId>/data.kv, dev: Deno default */
export function resolveKvPath(appId: string): string | undefined {
  if (!isCompiled()) return undefined; // dev mode — let Deno pick
  return join(resolveDataDir(appId), "data.kv");
}

/** Resolves SQLite path — compiled: ~/.local/share/<appId>/data.db, dev: ./data.db */
export function resolveDbPath(appId: string): string {
  if (!isCompiled()) return join(Deno.cwd(), "data.db");
  return join(resolveDataDir(appId), "data.db");
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
  throw new Error("no free port found in 49152–65535 after 50 attempts");
}
