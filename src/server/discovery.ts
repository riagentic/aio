/**
 * @module
 * LAN discovery for exposed aio apps — the "how does the client find my app?"
 * layer. An exposed server (`--expose`) answers UDP broadcast probes on a
 * fixed port; a client (the unified aio Electron client, `am discover`, or any
 * consumer) broadcasts one probe and collects every app on the subnet.
 *
 * Wire protocol (deliberately trivial, versioned):
 *   probe : "AIO_DISCOVER? v1"   (broadcast → AIO_DISCOVERY_PORT)
 *   reply : "AIO1 " + JSON.stringify(AioAppAd)   (unicast → prober)
 *
 * Uses `node:dgram` (stable in Deno — no `--unstable-net` needed), the same
 * UDP API the Electron client already speaks. Best-effort: on a bind/network
 * failure discovery silently degrades (the app still runs, it just isn't
 * auto-discovered) — callers always keep a manual "type an address" path.
 */
import dgram from "node:dgram";
import { Buffer } from "node:buffer";

/** Fixed UDP port apps answer discovery probes on. Override with the
 *  `AIO_DISCOVERY_PORT` env var (must match between server and client). */
export const AIO_DISCOVERY_PORT = (() => {
  const raw = safeEnv("AIO_DISCOVERY_PORT");
  const n = raw ? Number(raw) : NaN;
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : 8099;
})();

const PROBE = "AIO_DISCOVER? v1";
const REPLY_PREFIX = "AIO1 ";

function safeEnv(k: string): string | undefined {
  try {
    return Deno.env.get(k);
  } catch {
    return undefined;
  }
}

/** What a server advertises about itself. */
export interface AioAppAd {
  /** App id / name (from appId). */
  name: string;
  /** The app's real HTTP(S) port (not the discovery port). */
  port: number;
  /** Window title, if set. */
  title?: string;
  /** True when the app requires a token/auth to connect. */
  needsAuth: boolean;
  /** True when the app serves over HTTPS (`--expose` auto-TLS). */
  tls: boolean;
}

/** A discovered app, resolved to a reachable URL (host from the datagram). */
export interface DiscoveredApp extends AioAppAd {
  /** LAN IP the reply came from. */
  host: string;
  /** Ready-to-open URL: `<http|https>://<host>:<port>`. */
  url: string;
}

// Minimal shape of the message-sender info node:dgram hands us on each packet.
interface RInfo {
  address: string;
  port: number;
}

/** True when this runtime can do UDP discovery. `node:dgram` is stable, so
 *  this is always true in Deno — kept for API stability / call-site clarity. */
export function discoverySupported(): boolean {
  return typeof dgram.createSocket === "function";
}

/**
 * Start answering discovery probes on this host. Returns a `stop()`.
 *
 * On each probe the responder replies with EVERY exposed app currently on the
 * host — supplied fresh by `listApps()` (the aio server wires this to the lock
 * registry). This is the key to multi-app-per-host discovery: it doesn't
 * matter that many apps run on different ports, nor which one's socket the OS
 * hands the broadcast to — whoever answers reports the whole host, and the
 * client dedups. `reuseAddr` lets several apps share the port; even if only
 * one wins the bind, it answers for all of them via the lock registry.
 *
 * Best-effort — on any bind/socket failure it logs via `onNote` and returns a
 * no-op stopper; it never throws.
 */
export function startDiscoveryResponder(
  listApps: () => AioAppAd[],
  onNote?: (msg: string) => void,
): { stop: () => void } {
  let socket: dgram.Socket;
  try {
    socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
  } catch (e) {
    onNote?.(`discovery: could not create UDP socket — ${e}`);
    return { stop: () => {} };
  }
  // Bind errors (EADDRINUSE etc.) surface as an 'error' event, not a throw —
  // swallow them so a second app on the host degrades gracefully.
  socket.on("error", (e: unknown) => {
    onNote?.(`discovery: UDP ${AIO_DISCOVERY_PORT} unavailable — ${e}`);
    try {
      socket.close();
    } catch { /* already closed */ }
  });
  socket.on("message", (msg: Buffer, rinfo: RInfo) => {
    if (!msg.toString("utf8").startsWith("AIO_DISCOVER?")) return;
    // One datagram per app — the client collects and dedups by host:port.
    for (const ad of listApps()) {
      try {
        const reply = Buffer.from(REPLY_PREFIX + JSON.stringify(ad));
        socket.send(reply, rinfo.port, rinfo.address);
      } catch { /* client vanished */ }
    }
  });
  try {
    socket.bind(AIO_DISCOVERY_PORT);
  } catch (e) {
    onNote?.(`discovery: could not bind UDP ${AIO_DISCOVERY_PORT} — ${e}`);
    return { stop: () => {} };
  }
  return {
    stop: () => {
      try {
        socket.close();
      } catch { /* already closed */ }
    },
  };
}

/**
 * Broadcast one discovery probe and collect replies for `timeoutMs`.
 * Returns every distinct app found (deduped by host:port). Empty array when
 * UDP is unavailable or nothing answered — callers should always keep a
 * manual "type an address" path (UDP is blocked on many networks).
 */
export function discoverAioApps(
  opts: { timeoutMs?: number; port?: number } = {},
): Promise<DiscoveredApp[]> {
  const timeoutMs = opts.timeoutMs ?? 1200;
  const port = opts.port ?? AIO_DISCOVERY_PORT;
  const found = new Map<string, DiscoveredApp>();

  return new Promise<DiscoveredApp[]>((resolve) => {
    let socket: dgram.Socket;
    try {
      socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    } catch {
      return resolve([]);
    }
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      try {
        socket.close();
      } catch { /* already closed */ }
      resolve(
        [...found.values()].sort((a, b) => a.name.localeCompare(b.name)),
      );
    };
    socket.on("error", () => done());
    socket.on("message", (msg: Buffer, rinfo: RInfo) => {
      const text = msg.toString("utf8");
      if (!text.startsWith(REPLY_PREFIX)) return;
      let ad: AioAppAd;
      try {
        ad = JSON.parse(text.slice(REPLY_PREFIX.length));
      } catch {
        return;
      }
      if (typeof ad?.name !== "string" || typeof ad?.port !== "number") return;
      const host = rinfo.address;
      const key = `${host}:${ad.port}`;
      if (found.has(key)) return;
      found.set(key, {
        ...ad,
        host,
        url: `${ad.tls ? "https" : "http"}://${host}:${ad.port}`,
      });
    });
    socket.bind(0, () => {
      try {
        socket.setBroadcast(true);
      } catch { /* broadcast not permitted on this iface */ }
      try {
        socket.send(Buffer.from(PROBE), port, "255.255.255.255");
      } catch { /* broadcast blocked */ }
    });
    setTimeout(done, timeoutMs);
  });
}
