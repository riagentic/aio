/**
 * @module
 * HTTP client layer for am — aio manager CLI.
 * Trojan API, general HTTP, and control port resolution.
 */

import type { Result } from "./am-types.ts";
import { readPid } from "./am-utils.ts";

export const FETCH_TIMEOUT = 5000;

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
const _verified = new Map<string, { appId: string; at: number }>();
export function _resetInstanceVerify(): void {
  _verified.clear();
}
export async function verifyInstance(
  ctrl: number,
  expectedAppId: string,
): Promise<{ ok: false; error: string } | null> {
  const key = String(ctrl);
  const cached = _verified.get(key);
  let actual = (cached && Date.now() - cached.at < VERIFY_TTL_MS)
    ? cached.appId
    : undefined;
  if (actual === undefined) {
    try {
      const r = await fetch(`http://127.0.0.1:${ctrl}/__aio/health`, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT),
      });
      if (!r.ok) {
        await r.body?.cancel();
        return null; // gated or odd — the real call will surface it
      }
      const h = await r.json() as { appId?: string };
      if (typeof h.appId !== "string") return null; // pre-alpha41 server
      actual = h.appId;
      _verified.set(key, { appId: actual, at: Date.now() });
    } catch {
      return null; // unreachable — the real call's error is the honest one
    }
  }
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
export function fetchError(e: unknown, port: number): Result {
  if (e instanceof TypeError && String(e).includes("onnect")) {
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
  const ctrl = resolveControlPort(port, appId);
  const mismatch = await identityGate(ctrl, appId);
  if (mismatch) return mismatch;
  try {
    const resp = await fetch(`http://127.0.0.1:${ctrl}/__aio/trojan/${route}`, {
      signal: AbortSignal.timeout(timeout),
    });
    if (!resp.ok) {
      const body = await resp.text();
      try {
        return { ok: false, error: JSON.parse(body).error ?? body };
      } catch {
        return { ok: false, error: body };
      }
    }
    return { ok: true, data: await resp.json() };
  } catch (e) {
    return fetchError(e, ctrl);
  }
}

/** POST request to trojan API endpoint */
export async function trojanPost(
  port: number,
  route: string,
  body?: unknown,
  appId?: string,
): Promise<Result> {
  const ctrl = resolveControlPort(port, appId);
  const mismatch = await identityGate(ctrl, appId);
  if (mismatch) return mismatch; // a MUTATION is gated at least as hard as a read
  try {
    const resp = await fetch(`http://127.0.0.1:${ctrl}/__aio/trojan/${route}`, {
      method: "POST",
      headers: {
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        "X-AIO": "1",
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    if (!resp.ok) {
      const text = await resp.text();
      try {
        return { ok: false, error: JSON.parse(text).error ?? text };
      } catch {
        return { ok: false, error: text };
      }
    }
    return { ok: true, data: await resp.json() };
  } catch (e) {
    return fetchError(e, ctrl);
  }
}

/** General HTTP GET — returns response body as text */
export async function httpGet(
  port: number,
  path: string,
  appId?: string,
): Promise<Result<string>> {
  const ctrl = resolveControlPort(port, appId);
  const mismatch = await identityGate(ctrl, appId);
  if (mismatch) return mismatch; // `/__aio/snapshot` dumps a whole app's data
  try {
    const resp = await fetch(`http://127.0.0.1:${ctrl}${path}`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    if (!resp.ok) {
      return { ok: false, error: `${resp.status} ${await resp.text()}` };
    }
    return { ok: true, data: await resp.text() };
  } catch (e) {
    return fetchError(e, ctrl) as Result<string>;
  }
}
