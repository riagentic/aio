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
// silently retargeting. Verified once per (port, appId) per am process.
const _verified = new Map<string, string>();
export function _resetInstanceVerify(): void {
  _verified.clear();
}
export async function verifyInstance(
  ctrl: number,
  expectedAppId: string,
): Promise<Result | null> {
  const key = String(ctrl);
  let actual = _verified.get(key);
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
      _verified.set(key, actual);
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
  if (appId) {
    const mismatch = await verifyInstance(ctrl, appId);
    if (mismatch) return mismatch;
  }
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
