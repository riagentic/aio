// profile.ts — build an app's `.aioapp` discovery profile from local files.
// This is the "one file, use forever" the aio client imports: name, address,
// TLS cert to pin, and the auth key. Read from disk (lock + app.key + cert),
// so it works without hitting the app's (auth-gated) control port.
import { join } from "@std/path";
import { readLock } from "./single-instance-lock.ts";
import { appKeyPath } from "./app-key.ts";
import { appDirs } from "./app-dirs.ts";

/** The `.aioapp` profile shape. */
export interface AioProfile {
  aio: 1;
  name: string;
  title?: string;
  host?: string;
  port: number;
  tls: boolean;
  cert: string | null; // the self-signed cert PEM to pin (null when no TLS)
  key: string | null; // auth key (null = no framework auth: open / app-level)
}

/** First non-loopback IPv4 — the address a client on the LAN would use. */
function lanIP(): string | undefined {
  try {
    return Deno.networkInterfaces()
      .filter((i) => i.family === "IPv4" && !i.address.startsWith("127."))
      .map((i) => i.address)[0];
  } catch {
    return undefined;
  }
}

function readFirst(paths: string[]): string | null {
  for (const p of paths) {
    try {
      const t = Deno.readTextFileSync(p);
      if (t) return t;
    } catch { /* next */ }
  }
  return null;
}

/**
 * Build the profile for `appId` from local files. Returns null when the app
 * isn't running (no lock). `cwd` only locates the PRE-alpha38 cert dir
 * (`./.aio-tls/`), consulted after the current `<data>/tls/`.
 */
export function buildLocalProfile(
  appId: string,
  cwd = Deno.cwd(),
): AioProfile | null {
  const lock = readLock(appId);
  if (!lock) return null;
  const tls = !!lock.discovery?.tls;
  const cert = tls
    // Current location first: a leftover `./.aio-tls/` from an older version
    // would otherwise shadow the cert the server is actually serving, and the
    // client would fail hostname verification against a stale SAN list.
    ? readFirst([
      join(appDirs(appId).tls, "tls-cert.pem"),
      join(cwd, ".aio-tls", "tls-cert.pem"),
    ])
    : null;
  const key = readFirst([appKeyPath(appId)]);
  return {
    aio: 1,
    name: appId,
    title: lock.discovery?.title,
    host: lanIP(),
    port: lock.port,
    tls,
    cert,
    key: key?.trim() || null,
  };
}
