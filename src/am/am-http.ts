/**
 * @module
 * HTTP client layer for am — aio manager CLI.
 * Trojan API, general HTTP, and control port resolution.
 */

import type { Result } from "./am-types.ts";
import { readPid } from "./am-utils.ts";
import {
  appKeyPath,
  controlKeyPath,
  readControlKey,
} from "../server/app-key.ts";

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
    return fetchError(e, ctrl) as Result<string>;
  }
}
