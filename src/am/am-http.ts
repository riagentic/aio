/**
 * @module
 * The client layer for am — aio manager CLI. Trojan API, general HTTP, and
 * control-target resolution.
 *
 * TWO transports, one surface: an app that binds a TCP port is reached with
 * `fetch`, and an app on a Unix socket is reached with a `ctl` frame
 * (`am-uds.ts`). Which one is not a choice made here — it is read from the
 * lock the app itself wrote, so `am` follows the app onto whichever wire the
 * app chose. Both arrive at the SAME server-side handler, so the answers, the
 * refusals and the auth gates are identical on either.
 */

import type { Result } from "./am-types.ts";
import { _discoveredAppTarget, liveLock } from "./am-utils.ts";
import { isProcessAlive } from "../server/single-instance-lock.ts";
import { CLIENT_REPLY_TIMEOUT_MS } from "../server/uds.ts";
import {
  appKeyPath,
  controlKeyPath,
  readControlKey,
} from "../server/app-key.ts";
import { udsRequest } from "./am-uds.ts";

/** `am`'s transport timeout. Strictly LONGER than the server's own wait for a
 *  client reply, so that when a client stalls the server's NAMED reason (which
 *  index, why) arrives instead of a bare "timeout connecting". The two used to
 *  be equal (5000/5000) and raced — the server always lost by a millisecond. */
export const FETCH_TIMEOUT = 8000;
if (FETCH_TIMEOUT <= CLIENT_REPLY_TIMEOUT_MS) {
  throw new Error(
    `am FETCH_TIMEOUT (${FETCH_TIMEOUT}ms) must exceed the server's ` +
      `CLIENT_REPLY_TIMEOUT_MS (${CLIENT_REPLY_TIMEOUT_MS}ms) — equal timeouts ` +
      `race and the server's reason never surfaces`,
  );
}

/** Resolve `--timeout=<ms>` against the floor above; a caller-chosen wait
 *  below the server's own wait would recreate the race, so it is refused. */
export function clientTimeout(flag?: number): number {
  if (flag === undefined) return FETCH_TIMEOUT;
  if (flag <= CLIENT_REPLY_TIMEOUT_MS) {
    throw new Error(
      `--timeout=${flag} is not above the server's client-reply wait ` +
        `(${CLIENT_REPLY_TIMEOUT_MS}ms); use at least ${
          CLIENT_REPLY_TIMEOUT_MS + 1
        }`,
    );
  }
  return flag;
}

/** Where an `am` command talks to its app — THE transport decision, made once
 *  and made here. Every control-plane call (`trojanGet`, `trojanPost`,
 *  `httpGet`, and so every `am` command that inspects or drives a running
 *  app) resolves its endpoint through this function; nothing else in `am`
 *  decides "port or socket".
 *
 *  It is read from the lock the app itself wrote — never guessed — so `am`
 *  follows the app onto whichever wire the app chose. The lock is found
 *  wherever the instance's home is (`liveLock`): a packaged Electron app runs
 *  UDS-only from its own `appDir`, and that is the SHIPPED shape, not a
 *  corner. A live pid is part of the answer: a leftover socket path from a
 *  crashed app must not silently become the target.
 *
 *  The socket wins whenever the lock names one, even when a `--port` was
 *  typed: an app on UDS may have no TCP port at all, and the port path's
 *  failure mode there is a connection-refused that reads like "your app is
 *  broken". `port` in the UDS branch is the lock's — `0` for a zero-port app,
 *  a real listener when the app has both wires — and it decides whether a
 *  failed socket call may fall through to TCP (see `overUds`). */
export type ControlEndpoint =
  | { kind: "tcp"; port: number }
  | { kind: "uds"; socketPath: string; pid: number; port: number };

export function controlEndpoint(
  appId: string | undefined,
  port: number,
): ControlEndpoint {
  const pf = liveLock(appId);
  if (pf?.socketPath && isProcessAlive(pf.pid)) {
    return {
      kind: "uds",
      socketPath: pf.socketPath,
      pid: pf.pid,
      port: pf.port,
    };
  }
  return { kind: "tcp", port: resolveControlPort(port, appId) };
}

/** The message for a socket that did not answer on an app that has NO other
 *  wire. Naming the constraint is the whole point: this used to surface as
 *  "app not running on port 0", and one field reporter went looking for a
 *  crash that had not happened. */
function udsUnreachable(
  ep: Extract<ControlEndpoint, { kind: "uds" }>,
  appId: string | undefined,
  reason: string,
): Result {
  return {
    ok: false,
    error: `"${appId ?? "this app"}" is running on a UDS socket with no TCP ` +
      `port (pid ${ep.pid}, ${ep.socketPath}), but the socket did not ` +
      `answer: ${reason}`,
  };
}

/** Run one trojan call over the socket and shape it like a `fetch` outcome, so
 *  the two transports converge before any caller sees them.
 *
 *  The shared key is offered only AFTER the app asks for it. Over TCP that
 *  question is answered by probing /__aio/health for a 401 (`gated`); there is
 *  no such probe here, and guessing wrong is worse on this wire than on that
 *  one — a UDS request carries no per-peer abuse key, so a failed credential
 *  lands in the SHARED `"*"` bucket (`server-auth.ts`) and an `am` loop with a
 *  stale `app.key` would spend everyone's auth budget, not its own.
 *
 *  So: ask unauthenticated, and let a 401/403 be the app SAYING it wants a
 *  credential. That costs one refused call on a keyed app and nothing on the
 *  rest, and unlike a probe it cannot be wrong about the app's mode. */
async function trojanOverUds(
  socketPath: string,
  route: string,
  init: {
    method: "GET" | "POST";
    headers?: Record<string, string>;
    body?: string;
  },
  timeout: number,
  appId?: string,
): Promise<Result | { transportError: string }> {
  const path = `/__aio/trojan/${route}`;
  const send = (c: LocalCreds) =>
    udsRequest(
      socketPath,
      path,
      { ...init, headers: { ...init.headers, ...c.headers } },
      timeout,
    );

  let creds = localCreds(appId, { control: true, gated: false });
  let r = await send(creds);
  if (!("error" in r) && (r.status === 401 || r.status === 403)) {
    const keyed = localCreds(appId, { control: true, gated: true });
    // Only worth a second trip if it actually adds a credential.
    if (keyed.headers["Authorization"] !== creds.headers["Authorization"]) {
      creds = keyed;
      r = await send(keyed);
    }
  }

  // A transport failure is NOT an answer. It is handed back BY NAME so the
  // caller can fall through to TCP when the app has both wires (a stale
  // path, a permission change — the socket is a preference, not a dead end),
  // and say exactly what failed when it has no other wire.
  if ("error" in r) return { transportError: r.error };
  if (r.status < 200 || r.status >= 300) {
    const extra = credentialDiagnosis(r.status, creds, appId) +
      prodDiagnosis(r.status, r.body);
    try {
      return { ok: false, error: (JSON.parse(r.body).error ?? r.body) + extra };
    } catch {
      return { ok: false, error: r.body + extra };
    }
  }
  try {
    return { ok: true, data: JSON.parse(r.body) };
  } catch (e) {
    return { ok: false, error: `malformed control reply: ${e}` };
  }
}

// Instance identity (a field report): `--port=N` used to trust
// that WHATEVER answers on N is the app the user means — a green e2e once
// wrote its test rows into the production leaderboard that way. Before the
// first trojan call to a port, the responder's /__aio/health appId is checked
// against the app am resolved from cwd/--app; a mismatch REFUSES instead of
// silently retargeting.
//
// The answer is cached per port, but only briefly: a one-shot `am` call is over
// in milliseconds, while amui holds the same module for hours, and a port
// outlives the app that had it. A permanent cache would eventually refuse the
// RIGHT app in the name of one that exited an hour ago — a refusal that
// misdiagnoses is worse than the extra health fetch it saves.
const VERIFY_TTL_MS = 2000;
/** One probe of "who answers on this port, and does it demand a credential".
 *  `gated` is what decides whether am presents the app's shared key: a keyed
 *  app gates EVERY route (health included), so a 401 here is the positive
 *  signal that the key is wanted — and its absence is the positive signal that
 *  presenting one would only burn the operator's own auth-fail budget. */
type PortIdentity = { appId?: string; gated: boolean; at: number };
const _verified = new Map<string, PortIdentity>();
/** Probes in flight, keyed by port. amui's `fetchDiag` fires five control
 *  reads at once with `Promise.all`; without this every one of them missed the
 *  (not-yet-written) cache and opened its own health probe, so a single panel
 *  refresh cost ten TCP connections instead of six. One probe per port at a
 *  time — the others await the same answer. */
const _inflight = new Map<string, Promise<PortIdentity>>();
export function _resetInstanceVerify(): void {
  _verified.clear();
  _inflight.clear();
}

/** One probe of "who answers on this port, and does it demand a credential".
 *
 *  ONE. This function used to be called TWICE per control call (the identity
 *  gate, then the credential resolver asking `gated`), and an UNREACHABLE probe
 *  was deliberately not cached, so neither call could reuse the other's answer.
 *  Against a port that accepts and never replies, one `am` command opened THREE
 *  TCP connections and waited three full timeouts: measured 24 005 ms with the
 *  default 8 s budget, 19 008 ms with `--timeout=3000` — because the two probes
 *  ignored the flag as well and always spent `FETCH_TIMEOUT`. Every `am`
 *  command paid it, and amui paid it on every tick of every panel.
 *
 *  So: the timeout is the caller's, and a negative verdict is cached for the
 *  same short TTL as a positive one. Caching it costs no honesty — the probe
 *  only decides *which credentials to present*; the REAL request still runs and
 *  still reports its own failure, which is the error the operator sees.
 *
 *  `gated` is what decides whether am presents the app's shared key: a keyed
 *  app gates EVERY route (health included), so a 401 here is the positive
 *  signal that the key is wanted — and its absence is the positive signal that
 *  presenting one would only burn the operator's own auth-fail budget. */
async function probeIdentity(
  ctrl: number,
  timeout = FETCH_TIMEOUT,
): Promise<PortIdentity> {
  const key = String(ctrl);
  const cached = _verified.get(key);
  if (cached && Date.now() - cached.at < VERIFY_TTL_MS) return cached;
  const pending = _inflight.get(key);
  if (pending) return await pending;
  const p = probeIdentityOnce(ctrl, timeout, key);
  _inflight.set(key, p);
  try {
    return await p;
  } finally {
    _inflight.delete(key);
  }
}

async function probeIdentityOnce(
  ctrl: number,
  timeout: number,
  key: string,
): Promise<PortIdentity> {
  const remember = (probe: PortIdentity) => {
    _verified.set(key, probe);
    return probe;
  };
  try {
    const r = await fetch(`http://127.0.0.1:${ctrl}/__aio/health`, {
      signal: AbortSignal.timeout(timeout),
    });
    if (!r.ok) {
      await r.body?.cancel();
      // Gated or odd — no identity, but "it wants a credential" is itself
      // information the credential resolver needs.
      return remember({
        gated: r.status === 401 || r.status === 403,
        at: Date.now(),
      });
    }
    const h = await r.json() as { appId?: string };
    return remember({
      appId: typeof h.appId === "string" ? h.appId : undefined, // pre-alpha41
      gated: false,
      at: Date.now(),
    });
  } catch {
    // UNREACHABLE — refused, hung, or timed out. CACHED, like every other
    // verdict: it only decides which credentials to present, and the real
    // request that follows still reports its own honest failure.
    return remember({ gated: false, at: Date.now() });
  }
}

/** The mismatch verdict for an ALREADY-TAKEN probe — no I/O, so the gate and
 *  the credential resolver share one round trip instead of racing for two. */
function identityMismatch(
  probe: PortIdentity,
  ctrl: number,
  expectedAppId: string,
): { ok: false; error: string } | null {
  const actual = probe.appId;
  if (actual === undefined) return null; // gated / unreachable / pre-alpha41
  if (actual === expectedAppId) return null;
  return {
    ok: false,
    error: `port ${ctrl} answers as app "${actual}", not "${expectedAppId}" ` +
      `— refusing to touch a different app's instance (stale --port? another ` +
      `app on this port? stop it, or pass the port of the right instance)`,
  };
}

export async function verifyInstance(
  ctrl: number,
  expectedAppId: string,
  timeout = FETCH_TIMEOUT,
): Promise<{ ok: false; error: string } | null> {
  return identityMismatch(
    await probeIdentity(ctrl, timeout),
    ctrl,
    expectedAppId,
  );
}

/** The ONE identity gate every am→app call passes through, and the ONE probe
 *  its credentials are resolved from.
 *
 *  It used to sit in `trojanGet` only: every READ was checked while every
 *  MUTATION — `shutdown`, `dispatch`, `sql`, `snapshot`, `tt`, `trigger` — went
 *  unchecked, so a stale `--port` could dispatch actions or run SQL against
 *  whatever app happened to hold that port. Exactly backwards: a write to the
 *  wrong instance is the one that cannot be undone.
 *
 *  There is no opt-out and none is needed — every call site knows the app it
 *  means: `--app`, the cwd's deno.json/entry, amui's process registry, or (for
 *  `am stop --port=N`) the appId read from that port's own /__aio/health. When
 *  the identity genuinely cannot be established, the gate returns no mismatch
 *  (unreachable / pre-alpha41 server) and the real call's own error is the
 *  honest one.
 *
 *  Returns the refusal, or the credentials the real request must carry. */
async function controlPreflight(
  ctrl: number,
  appId: string | undefined,
  opts: { control: boolean; timeout: number },
): Promise<
  { mismatch: { ok: false; error: string } } | {
    mismatch: null;
    creds: LocalCreds;
  }
> {
  const probe = await probeIdentity(ctrl, opts.timeout);
  // A port `resolvePort` picked BY DISCOVERY is not a stale port — it is the
  // one instance running, chosen deliberately and announced on stderr. Judging
  // it against the cwd-derived id made `am` refuse the app it had just said it
  // was using. A `--port` the user typed never reaches here through that path,
  // so a genuinely stale one is still refused.
  const discovered = _discoveredAppTarget();
  if (appId && !(discovered && probe.appId === discovered)) {
    const mismatch = identityMismatch(probe, ctrl, appId);
    if (mismatch) return { mismatch };
  }
  return {
    mismatch: null,
    creds: localCreds(appId, { control: opts.control, gated: probe.gated }),
  };
}

// ── Credentials ──────────────────────────────────────────────────────────────
//
// `am` has no app account to log in as, and it must not need one: it speaks for
// the person at the keyboard, who owns the app's files. So it presents what
// proves exactly that — the per-boot credential the app writes into its own
// 0700 data dir as 0600 (`<data>/control.key`) — in the `X-Aio-Control` header,
// and ONLY on `/__aio/trojan/*`, which is dev-only and same-machine-only. It is
// not an app identity: it opens the control plane and nothing else.
//
// The app's SHARED KEY (`<data>/app.key`) is a different credential for a
// different gate: in shared-key mode (`key:` + `--expose`) the key gates every
// route including the trojan, and reading it out of the data dir is the same
// act of ownership. It is presented as `Authorization: Bearer` — but ONLY when
// the app actually demands a credential at its front door (`gated`), because in
// per-user mode that header goes to `resolveUser`/`users` and a wrong value
// there is a FAILED LOGIN: an `am` loop with a stale `app.key` would spend the
// operator's per-IP auth budget and lock them out of their own app.
//
// Every request in this module goes to 127.0.0.1 by construction, so neither
// credential can leave the machine.

/** The credentials am can prove, plus the reason for each one it cannot. */
type LocalCreds = {
  headers: Record<string, string>;
  /** Why there is no control credential (for the failure message only). */
  controlError?: string;
  /** The path of the shared key presented, when one was. */
  appKeyPath?: string;
};

function localCreds(
  appId: string | undefined,
  opts: { control: boolean; gated: boolean },
): LocalCreds {
  const headers: Record<string, string> = {};
  if (!appId) {
    return {
      headers,
      controlError:
        "am could not resolve this app's id, so it cannot find the app's data " +
        "dir — pass --app=<id>",
    };
  }
  let controlError: string | undefined;
  if (opts.control) {
    const r = readControlKey(appId);
    if (r.error !== undefined) controlError = r.error;
    else headers["X-Aio-Control"] = r.key;
  }
  let keyPath: string | undefined;
  if (opts.gated) {
    try {
      const p = appKeyPath(appId);
      const key = Deno.readTextFileSync(p).trim();
      if (key) {
        headers["Authorization"] = `Bearer ${key}`;
        keyPath = p;
      }
    } catch { /* no shared key on disk — the 401 below explains the rest */ }
  }
  return { headers, controlError, appKeyPath: keyPath };
}

/** Turn a control-plane refusal into something the operator can act on.
 *  A bare 401 with no path forward is what makes people disable auth in dev. */
function credentialDiagnosis(
  status: number,
  creds: LocalCreds,
  appId: string | undefined,
): string {
  if (status !== 401 && status !== 403) return "";
  const lines: string[] = [];
  if (creds.controlError) {
    lines.push(
      `am authenticates to the control plane as the machine owner, using the ` +
        `app's own control credential — but ${creds.controlError}.`,
    );
  } else if (creds.headers["X-Aio-Control"]) {
    lines.push(
      `am presented ${
        appId ? controlKeyPath(appId) : "this app's control credential"
      } and the app refused it — it is minted fresh at every boot, so this app ` +
        `is either older than the file, running from a different data dir ` +
        `(AIO_APPS_DIR / appDir), or a production build (which has no control ` +
        `plane at all).`,
    );
  }
  if (creds.appKeyPath) {
    lines.push(
      `It also presented the shared key from ${creds.appKeyPath}, which was ` +
        `refused — if this app now runs per-user auth, that file is stale; ` +
        `delete it.`,
    );
  }
  return lines.length ? "\n\n" + lines.join("\n") : "";
}

/** The other half of `credentialDiagnosis`: a 404 from the control plane.
 *
 *  `/__aio/trojan/*` is DEV-ONLY — a production build does not mount it, so the
 *  server's generic 404 handler answers and `am state` printed the whole
 *  explanation as `{"error":"Not Found"}`. The operator surface simply vanished
 *  against a compiled binary while `am status` kept working, with nothing
 *  anywhere saying why. Names the reason AND what does work in prod. */
function prodDiagnosis(status: number, body: string): string {
  if (status !== 404) return "";
  // The dev server answers 404 for a genuinely unknown trojan ROUTE too (an
  // `am` newer than the app it is talking to). That one names the route; the
  // prod case is the framework's bare "Not Found" / the trojan's own backstop.
  if (!/not found|trojan is disabled/i.test(body)) return "";
  return "\n\nThe control API (/__aio/trojan/*) is DEV-ONLY: a production " +
    "build never mounts it, so state, dispatch, sql, surface, trigger, " +
    "timeline and snapshot have nothing to talk to.\n" +
    // MEASURED against a compiled binary, not assumed: `am errors` reads
    // `/__aio/error`, which is `!prod`-gated, and `am metrics` goes through the
    // trojan too — both were listed here as working in production and both
    // answer 404 there. A list of what works has to be a list of what works.
    "Against a production app, these work: am status, am health, am logs, " +
    "am data, am installed, am pin.\n" +
    "To inspect or drive state, run the app in dev (deno task dev) and point " +
    "am at it — or, if this app IS a dev build, it was started with " +
    "--prod/NODE_ENV=production.";
}

/** What is actually listening on a port — the honest answer for a message that
 *  would otherwise guess. `tls` is the `--expose` shape: https on the main port,
 *  with the plain-HTTP trojan control port recorded only in the lock file. */
export type PortProbe =
  | { kind: "aio"; appId: string }
  | { kind: "http" } // answers plain HTTP, but not as an aio app
  | { kind: "tls" } // a TLS listener — not reachable over plain HTTP
  | { kind: "listening" } // socket accepts, speaks neither
  | { kind: "closed" }; // nothing there

/** Ask a port what it is: identity first (`/__aio/health` appId), then protocol.
 *  Used by `am stop --port=N` so the port IDENTIFIES the app instead of the
 *  command assuming the cwd's app and shutting down the wrong one — or nothing. */
export async function probePort(port: number): Promise<PortProbe> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/__aio/health`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    if (!r.ok) {
      await r.body?.cancel();
      return { kind: "http" };
    }
    const h = await r.json().catch(() => null) as { appId?: string } | null;
    return (h && typeof h.appId === "string")
      ? { kind: "aio", appId: h.appId }
      : { kind: "http" };
  } catch {
    /* not plain HTTP — find out what IS there, rather than guessing */
  }
  try {
    const conn = await Deno.connect({ hostname: "127.0.0.1", port });
    conn.close();
  } catch {
    return { kind: "closed" }; // refused: nothing is listening
  }
  try {
    const r = await fetch(`https://127.0.0.1:${port}/__aio/health`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    await r.body?.cancel();
    return { kind: "tls" };
  } catch (e) {
    // A certificate complaint is still proof of a completed TLS handshake.
    return /cert|tls|ssl|invaliddata|handshake/i.test(String(e))
      ? { kind: "tls" }
      : { kind: "listening" };
  }
}

/** Map a fetch error to a Result with a descriptive message */
export function fetchError(e: unknown, port: number, appId?: string): Result {
  if (e instanceof TypeError && String(e).includes("onnect")) {
    // "app not running" sent one field reporter looking for a crash that did
    // not happen: their compiled app was alive on its Unix socket, with no
    // TCP listener for this probe to reach. When the lock says exactly that,
    // say exactly that.
    //
    // Reaching HERE with a socket in the lock now means something narrower
    // than it used to: the control plane IS served over the socket, so `am`
    // would have gone that way (`controlSocket`). Landing on the TCP path
    // anyway means the socket was rejected — the app is a PROD build, where
    // the trojan does not exist on any wire by design.
    if (appId) {
      const pf = liveLock(appId);
      if (pf?.socketPath && isProcessAlive(pf.pid)) {
        return {
          ok: false,
          error: `app "${appId}" is running over UDS with no TCP port ` +
            `(pid ${pf.pid}). Its socket is ${pf.socketPath}, but the ` +
            `control plane answered nothing there — a production build has ` +
            `no trojan on any transport. \`am status\` still works; run a dev ` +
            `build to inspect state.`,
        };
      }
    }
    return { ok: false, error: `app not running on port ${port}` };
  }
  if (e instanceof DOMException && e.name === "TimeoutError") {
    return { ok: false, error: `timeout connecting to port ${port}` };
  }
  return { ok: false, error: String(e) };
}

/** Returns the plain-HTTP control port: trojanPort (when TLS active) or main port */
export function resolveControlPort(
  mainPort: number,
  appId?: string,
): number {
  const pf = liveLock(appId);
  return (pf?.port === mainPort && pf.trojanPort) ? pf.trojanPort : mainPort;
}

/** GET request to trojan API endpoint */
export async function trojanGet(
  port: number,
  route: string,
  appId?: string,
  timeout = FETCH_TIMEOUT,
): Promise<Result> {
  // The app's own wire first. An app on UDS may bind no TCP port at all, and
  // the identity gate below is a PORT concern — a socket is named by the app's
  // own lock, so there is no "who answers on this number" question to ask.
  const ep = controlEndpoint(appId, port);
  if (ep.kind === "uds") {
    const r = await trojanOverUds(
      ep.socketPath,
      route,
      { method: "GET" },
      timeout,
      appId,
    );
    if (!("transportError" in r)) return r;
    if (ep.port <= 0) return udsUnreachable(ep, appId, r.transportError);
  }
  const ctrl = ep.port;
  const pre = await controlPreflight(ctrl, appId, {
    control: true,
    timeout,
  });
  if (pre.mismatch) return pre.mismatch;
  const creds = pre.creds;
  try {
    const resp = await fetch(`http://127.0.0.1:${ctrl}/__aio/trojan/${route}`, {
      headers: creds.headers,
      signal: AbortSignal.timeout(timeout),
    });
    if (!resp.ok) {
      const body = await resp.text();
      const extra = credentialDiagnosis(resp.status, creds, appId) +
        prodDiagnosis(resp.status, body);
      try {
        return { ok: false, error: (JSON.parse(body).error ?? body) + extra };
      } catch {
        return { ok: false, error: body + extra };
      }
    }
    return { ok: true, data: await resp.json() };
  } catch (e) {
    return fetchError(e, ctrl, appId);
  }
}

/** POST request to trojan API endpoint */
export async function trojanPost(
  port: number,
  route: string,
  body?: unknown,
  appId?: string,
  timeout = FETCH_TIMEOUT,
): Promise<Result> {
  const ep = controlEndpoint(appId, port);
  if (ep.kind === "uds") {
    const r = await trojanOverUds(
      ep.socketPath,
      route,
      {
        method: "POST",
        headers: {
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          // The CSRF header rides along unchanged: the server runs this
          // through the same handler, so it meets the same check.
          "X-AIO": "1",
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      },
      timeout,
      appId,
    );
    if (!("transportError" in r)) return r;
    if (ep.port <= 0) return udsUnreachable(ep, appId, r.transportError);
  }
  const ctrl = ep.port;
  // a MUTATION is gated at least as hard as a read
  const pre = await controlPreflight(ctrl, appId, {
    control: true,
    timeout,
  });
  if (pre.mismatch) return pre.mismatch;
  const creds = pre.creds;
  try {
    const resp = await fetch(`http://127.0.0.1:${ctrl}/__aio/trojan/${route}`, {
      method: "POST",
      headers: {
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        "X-AIO": "1",
        ...creds.headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeout),
    });
    if (!resp.ok) {
      const text = await resp.text();
      const extra = credentialDiagnosis(resp.status, creds, appId) +
        prodDiagnosis(resp.status, text);
      try {
        return { ok: false, error: (JSON.parse(text).error ?? text) + extra };
      } catch {
        return { ok: false, error: text + extra };
      }
    }
    return { ok: true, data: await resp.json() };
  } catch (e) {
    return fetchError(e, ctrl, appId);
  }
}

/** General HTTP GET — returns response body as text */
export async function httpGet(
  port: number,
  path: string,
  appId?: string,
  timeout = FETCH_TIMEOUT,
): Promise<Result<string>> {
  // The app's own routes answer on the socket too — same handler. Without this
  // `am state` would work on a socket-only app while `am health` reported it
  // unreachable: one app, two verdicts, which is worse than either.
  const ep = controlEndpoint(appId, port);
  if (ep.kind === "uds") {
    const sock = ep.socketPath;
    // NO control credential, exactly as below: it authorizes the control
    // plane, not the app's front door.
    const creds = localCreds(appId, { control: false, gated: false });
    let r = await udsRequest(sock, path, {
      method: "GET",
      headers: creds.headers,
    }, timeout);
    if (!("error" in r) && (r.status === 401 || r.status === 403)) {
      const keyed = localCreds(appId, { control: false, gated: true });
      if (keyed.headers["Authorization"]) {
        r = await udsRequest(sock, path, {
          method: "GET",
          headers: keyed.headers,
        }, timeout);
      }
    }
    if (!("error" in r)) {
      return r.status >= 200 && r.status < 300
        ? { ok: true, data: r.body }
        : { ok: false, error: `${r.status} ${r.body}` };
    }
    // transport failure — fall through to TCP only when there IS one
    if (ep.port <= 0) {
      return udsUnreachable(ep, appId, r.error) as Result<string>;
    }
  }
  const ctrl = ep.port;
  // NO control credential here: it authorizes the control plane, not the app's
  // own routes. `/__aio/health|vitals|metrics|snapshot` are the app's front
  // door and keep the app's own gate — only the shared key belongs on them.
  const pre = await controlPreflight(ctrl, appId, {
    control: false,
    timeout,
  });
  // `/__aio/snapshot` dumps a whole app's data
  if (pre.mismatch) return pre.mismatch;
  const creds = pre.creds;
  try {
    const resp = await fetch(`http://127.0.0.1:${ctrl}${path}`, {
      headers: creds.headers,
      signal: AbortSignal.timeout(timeout),
    });
    if (!resp.ok) {
      return { ok: false, error: `${resp.status} ${await resp.text()}` };
    }
    return { ok: true, data: await resp.text() };
  } catch (e) {
    return fetchError(e, ctrl, appId) as Result<string>;
  }
}
