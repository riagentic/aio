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
import { readPid } from "./am-utils.ts";
import { isProcessAlive } from "../server/single-instance-lock.ts";
import {
  appKeyPath,
  controlKeyPath,
  readControlKey,
} from "../server/app-key.ts";
import { udsRequest } from "./am-uds.ts";

export const FETCH_TIMEOUT = 5000;

/** The socket this app answers control requests on, or undefined when it has
 *  none (a WS-transport app, or nothing running under that id).
 *
 *  THE transport decision for `am`, made once. It is read from the lock the
 *  app itself wrote — never guessed — so `am` follows the app onto whichever
 *  wire the app chose rather than assuming a port exists. A live pid is part
 *  of the answer: a leftover socket file from a crashed app must not silently
 *  become the target.
 *
 *  Order matters and is deliberate: the socket is tried FIRST when present,
 *  because an app on UDS may have no TCP port at all, and the port path's
 *  failure mode there is a connection-refused that reads like "your app is
 *  broken". */
function controlSocket(appId?: string): string | undefined {
  const pf = readPid(appId);
  if (!pf?.socketPath) return undefined;
  return isProcessAlive(pf.pid) ? pf.socketPath : undefined;
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
): Promise<Result | null> {
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

  // A transport failure is NOT an answer. The caller falls back to TCP on
  // null, so an app that has both wires keeps working if the socket is
  // unusable (a stale path, a permission change) — the socket is the
  // preference, never a dead end.
  if ("error" in r) return null;
  if (r.status < 200 || r.status >= 300) {
    const extra = credentialDiagnosis(r.status, creds, appId);
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
export function _resetInstanceVerify(): void {
  _verified.clear();
}

async function probeIdentity(ctrl: number): Promise<PortIdentity | null> {
  const key = String(ctrl);
  const cached = _verified.get(key);
  if (cached && Date.now() - cached.at < VERIFY_TTL_MS) return cached;
  try {
    const r = await fetch(`http://127.0.0.1:${ctrl}/__aio/health`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    if (!r.ok) {
      await r.body?.cancel();
      // Gated or odd — no identity, but "it wants a credential" is itself
      // information the credential resolver needs.
      const probe: PortIdentity = {
        gated: r.status === 401 || r.status === 403,
        at: Date.now(),
      };
      _verified.set(key, probe);
      return probe;
    }
    const h = await r.json() as { appId?: string };
    const probe: PortIdentity = {
      appId: typeof h.appId === "string" ? h.appId : undefined, // pre-alpha41
      gated: false,
      at: Date.now(),
    };
    _verified.set(key, probe);
    return probe;
  } catch {
    return null; // unreachable — never cached; the real call's error is honest
  }
}

export async function verifyInstance(
  ctrl: number,
  expectedAppId: string,
): Promise<{ ok: false; error: string } | null> {
  const probe = await probeIdentity(ctrl);
  const actual = probe?.appId;
  if (actual === undefined) return null; // gated / unreachable / pre-alpha41
  if (actual === expectedAppId) return null;
  return {
    ok: false,
    error: `port ${ctrl} answers as app "${actual}", not "${expectedAppId}" ` +
      `— refusing to touch a different app's instance (stale --port? another ` +
      `app on this port? stop it, or pass the port of the right instance)`,
  };
}

/** The ONE identity gate every am→app call passes through.
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
 *  the identity genuinely cannot be established, `verifyInstance` itself
 *  returns null (unreachable / pre-alpha41 server) and the real call's own
 *  error is the honest one. */
async function identityGate(
  ctrl: number,
  appId?: string,
): Promise<{ ok: false; error: string } | null> {
  return appId ? await verifyInstance(ctrl, appId) : null;
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
      const pf = readPid(appId);
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
  const pf = readPid(appId);
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
  const sock = controlSocket(appId);
  if (sock) {
    const r = await trojanOverUds(
      sock,
      route,
      { method: "GET" },
      timeout,
      appId,
    );
    if (r) return r;
  }
  const ctrl = resolveControlPort(port, appId);
  const mismatch = await identityGate(ctrl, appId);
  if (mismatch) return mismatch;
  const creds = localCreds(appId, {
    control: true,
    gated: (await probeIdentity(ctrl))?.gated ?? false,
  });
  try {
    const resp = await fetch(`http://127.0.0.1:${ctrl}/__aio/trojan/${route}`, {
      headers: creds.headers,
      signal: AbortSignal.timeout(timeout),
    });
    if (!resp.ok) {
      const body = await resp.text();
      const extra = credentialDiagnosis(resp.status, creds, appId);
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
): Promise<Result> {
  const sock = controlSocket(appId);
  if (sock) {
    const r = await trojanOverUds(
      sock,
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
      FETCH_TIMEOUT,
      appId,
    );
    if (r) return r;
  }
  const ctrl = resolveControlPort(port, appId);
  const mismatch = await identityGate(ctrl, appId);
  if (mismatch) return mismatch; // a MUTATION is gated at least as hard as a read
  const creds = localCreds(appId, {
    control: true,
    gated: (await probeIdentity(ctrl))?.gated ?? false,
  });
  try {
    const resp = await fetch(`http://127.0.0.1:${ctrl}/__aio/trojan/${route}`, {
      method: "POST",
      headers: {
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        "X-AIO": "1",
        ...creds.headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    if (!resp.ok) {
      const text = await resp.text();
      const extra = credentialDiagnosis(resp.status, creds, appId);
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
): Promise<Result<string>> {
  // The app's own routes answer on the socket too — same handler. Without this
  // `am state` would work on a socket-only app while `am health` reported it
  // unreachable: one app, two verdicts, which is worse than either.
  const sock = controlSocket(appId);
  if (sock) {
    // NO control credential, exactly as below: it authorizes the control
    // plane, not the app's front door.
    const creds = localCreds(appId, { control: false, gated: false });
    let r = await udsRequest(sock, path, {
      method: "GET",
      headers: creds.headers,
    }, FETCH_TIMEOUT);
    if (!("error" in r) && (r.status === 401 || r.status === 403)) {
      const keyed = localCreds(appId, { control: false, gated: true });
      if (keyed.headers["Authorization"]) {
        r = await udsRequest(sock, path, {
          method: "GET",
          headers: keyed.headers,
        }, FETCH_TIMEOUT);
      }
    }
    if (!("error" in r)) {
      return r.status >= 200 && r.status < 300
        ? { ok: true, data: r.body }
        : { ok: false, error: `${r.status} ${r.body}` };
    }
    // transport failure — fall through to TCP
  }
  const ctrl = resolveControlPort(port, appId);
  const mismatch = await identityGate(ctrl, appId);
  if (mismatch) return mismatch; // `/__aio/snapshot` dumps a whole app's data
  // NO control credential here: it authorizes the control plane, not the app's
  // own routes. `/__aio/health|vitals|metrics|snapshot` are the app's front
  // door and keep the app's own gate — only the shared key belongs on them.
  const creds = localCreds(appId, {
    control: false,
    gated: (await probeIdentity(ctrl))?.gated ?? false,
  });
  try {
    const resp = await fetch(`http://127.0.0.1:${ctrl}${path}`, {
      headers: creds.headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    if (!resp.ok) {
      return { ok: false, error: `${resp.status} ${await resp.text()}` };
    }
    return { ok: true, data: await resp.text() };
  } catch (e) {
    return fetchError(e, ctrl, appId) as Result<string>;
  }
}
