/**
 * @module
 * HTTP client layer for am — aio manager CLI.
 * Trojan API, general HTTP, and control port resolution.
 */

import type { Result } from "./am-types.ts";
import { readPid } from "./am-utils.ts";

export const FETCH_TIMEOUT = 5000;

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
