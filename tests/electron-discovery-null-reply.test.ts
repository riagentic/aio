// Where a discovery sweep sends its probe.
//
// 255.255.255.255 leaves by ONE interface — the one the routing table gives
// it. Measured on a workstation with a VPN up: that was the VPN, a listener
// on another LAN machine never saw the probe, and `am discover` and the
// client's connect page both said "nothing found" about a network they had
// not asked. Both senders now also probe each interface's own broadcast
// address; this file pins the pure part (interfaces → addresses), that the
// two copies of it agree, and that both senders use it.
import { assertEquals } from "@std/assert";
import { Buffer } from "node:buffer";
import { createRequire } from "node:module";
import { electronClientScript } from "../src/electron/electron-client-script.ts";
import { NO_USER_DATA } from "./no-user-data.ts";

type Iface = { family: string | number; address: string; netmask?: string };
const v4 = (address: string, netmask?: string): Iface => ({
  family: "IPv4",
  address,
  netmask,
});
type Send = { to: string; port: number };
/** The generated client main, with `electron` and `dgram` as stand-ins and
 *  `os` reporting `ifaces` (in Node's shape: name → entries). */
function client(
  ifaces: Iface[],
  refuse: (to: string) => boolean = () => false,
) {
  const nodeRequire = createRequire(import.meta.url);
  const sent: Send[] = [];
  const on: Record<string, (...a: unknown[]) => void> = {};
  const errors: string[] = [];
  const noop = () => {};
  const req = (name: string) => {
    if (name === "electron") {
      return {
        app: {
          on: noop,
          getPath: () => NO_USER_DATA,
          setDesktopName: () => {}, // its window class (electron-shell-parity.test.ts)
          quit: noop,
          whenReady: () => new Promise(noop),
        },
        BrowserWindow: class {},
        Menu: { setApplicationMenu: noop },
        nativeImage: { createFromBuffer: () => ({}) },
        session: { defaultSession: { setCertificateVerifyProc: noop } },
      };
    }
    if (name === "os") return { networkInterfaces: () => ({ a: ifaces }) };
    if (name === "dgram") {
      return {
        createSocket: () => ({
          on: (n: string, f: (...a: unknown[]) => void) => on[n] = f,
          bind: (f: () => void) => f(),
          setBroadcast: noop,
          close: noop,
          send(
            _p: unknown,
            port: number,
            to: string,
            cb: (e: unknown) => void,
          ) {
            sent.push({ to, port });
            cb(refuse(to) ? new Error("send ENETUNREACH") : null);
          },
        }),
      };
    }
    return nodeRequire("node:" + name);
  };
  const proc = {
    env: {},
    argv: [],
    platform: "linux",
    stdout: { on: noop },
    stderr: { on: noop },
    on: noop,
  };
  const con = {
    log: noop,
    warn: noop,
    // The stub's profile cannot be written: the client says print() falls
    // back (its preload) — true, and not what these tests count.
    error: (...a: unknown[]) => {
      const m = a.map(String).join(" ");
      if (!m.includes("its preload could not be written")) errors.push(m);
    },
  };
  const api = new Function(
    "require",
    "process",
    "console",
    "setInterval",
    electronClientScript(null) + "\nreturn { broadcastTargets, discoverApps };",
  )(req, proc, con, () => 0) as {
    broadcastTargets: (i: Iface[]) => string[];
    discoverApps: (ms: number, cb: (apps: unknown[]) => void) => void;
  };
  const sweep = () => new Promise<unknown[]>((res) => api.discoverApps(5, res));
  return { api, sent, errors, sweep, on };
}

Deno.test("aio-client: a LAN reply 'AIO1 null' must not throw out of the dgram message handler", async () => {
  const c = client([v4("192.168.88.7", "255.255.255.0")]);
  const apps = new Promise<unknown[]>((res) => c.api.discoverApps(20, res));
  // Any host on the segment can answer the broadcast probe with this. In the
  // real Electron main, a throw from a dgram 'message' listener is an
  // uncaughtException (the main-process error dialog). The server-side twin
  // (discovery.ts) reads `ad?.name` and ignores it.
  let threw: unknown = null;
  try {
    c.on.message!(Buffer.from("AIO1 null"), {
      address: "192.168.88.9",
      port: 8099,
    });
  } catch (e) {
    threw = e;
  }
  await apps;
  assertEquals(threw, null, `handler threw: ${threw}`);
});
