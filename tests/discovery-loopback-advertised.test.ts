// What an exposed app ADVERTISES about its own authentication.
//
// The lock stamp read `!!users || !!token`. Those two miss `auth: true` and
// `resolveUser` — and with per-user auth no shared key is generated at all
// (app-key.ts declines), so both were falsy: a full-login app advertised
// itself on the LAN as needing no authentication. No ⚷ marker in
// `am discover`, no auth badge in the client, which then tried a direct
// connect. The exposure warning 87 lines above the stamp already reads
// `perUserAuth` for exactly this reason — one decider, two readers.
import { assertEquals } from "@std/assert";
import { startLifecycle } from "../src/server/aio-lifecycle.ts";
import type { Log } from "../src/diagnostics/logger.ts";

const silentLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Log;

type Stamp = { title: string; tls: boolean; needsAuth: boolean };

/** Start the lifecycle for an EXPOSED app and report what it stamped into its
 *  lock file for LAN discovery. */
function advertised(auth: {
  perUserAuth?: boolean;
  token?: string;
  users?: Record<string, { id: string; role: string }>;
}): Stamp | null {
  let stamped: Stamp | null = null;
  let stopDiscovery: (() => void) | null = null;
  startLifecycle({
    appId: "disc-probe",
    appVersion: "0.0.0",
    title: "Disc Probe",
    prod: false,
    electronDistDir: undefined,
    baseDir: Deno.cwd(),
    distDir: Deno.cwd(),
    expose: true, // discovery only runs for an exposed app
    // An in-process probe, not a process this lifecycle owns: no SIGHUP
    // listener, no parent watch — exactly what an embedding host gets.
    libraryMode: true,
    singletonMode: false,
    childWindows: false,
    client: "server-only",
    useElectron: false,
    isHeadless: true,
    transport: "ws",
    skipHttp: false,
    port: 0,
    token: auth.token,
    // deno-lint-ignore no-explicit-any
    users: auth.users as any,
    perUserAuth: auth.perUserAuth ?? false,
    tlsCert: null,
    shareUrl: "http://127.0.0.1:0",
    localUrl: "http://127.0.0.1:0",
    advertiseHost: "127.0.0.1",
    bindHost: "127.0.0.1",
    // deno-lint-ignore no-explicit-any
    server: { close: () => {} } as any,
    udsHandle: null,
    app: { dispatch: () => Promise.resolve(), getState: () => ({}) },
    onStart: undefined,
    fatalOnStart: undefined,
    scheduleManager: { start: () => {} },
    schedules: undefined,
    shouldPersist: false,
    persistMode: "none",
    asyncDb: null,
    db: undefined,
    maxConnections: undefined,
    cli: {},
    ui: {},
    keepServer: undefined,
    setElectronProc: () => {},
    setDiscoveryStop: (stop) => {
      stopDiscovery = stop;
    },
    appLock: {
      update: (partial) => {
        stamped = (partial as { discovery?: Stamp }).discovery ?? null;
      },
    },
    log: silentLog,
  });
  // The responder holds a UDP socket — close it before the test ends.
  (stopDiscovery as (() => void) | null)?.();
  return stamped;
}

Deno.test("discovery: an exposed app bound to loopback is NOT advertised on the LAN", () => {
  // The fixture above binds 127.0.0.1 — the boot banner for this shape says
  // "reachable from this machine only, other devices cannot connect", yet the
  // lock is stamped for discovery and every responder on the host answers LAN
  // probes with http://<lan-ip>:<port> — a URL that refuses.
  assertEquals(advertised({ token: "k" }), null);
});
