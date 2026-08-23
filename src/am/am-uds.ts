/**
 * @module
 * The control plane over the Unix socket — `am`'s fourth-transport client.
 *
 * An app whose transport is UDS answers the control plane on its socket, not
 * on a TCP port (`uds.ts`, `case "ctl"`). This is the client half: one request,
 * one reply, correlated by id, speaking the SAME v2 envelope as every other
 * peer on that wire.
 *
 * Why HTTP-shaped frames rather than a socket-native control API: the server
 * turns the frame back into a `Request` and hands it to the handler the TCP
 * listener uses, so there is exactly one implementation of the trojan's routes
 * and one set of its auth gates. The credential headers below are the same
 * ones `am` sends over TCP, and they meet the same checks — the transport
 * stops being a thing that can decide what the operator is allowed to do.
 *
 * The socket is also a stronger door than the port it replaces: it lives in a
 * 0700 directory (`lockDir()`), so only the owning user can open it, where a
 * loopback port admits every local process and every browser tab on the box.
 */

import { dec, enc } from "../protocol/envelope.ts";
import type { CtlrPayload } from "../protocol/envelope.ts";
import { protoHello } from "../protocol/protocol-version.ts";
import { VERSION } from "../server/aio-cli.ts";

/** One control exchange's outcome. A transport failure is `error`; anything
 *  the app actually answered — including a 404 or a 401 — is a `status` plus a
 *  body, because a refusal from the app is an ANSWER and must not be reported
 *  as "the app is unreachable". */
export type UdsReply =
  | { status: number; body: string }
  | { error: string };

/** Read NDJSON lines off a connection until `onLine` says it is done, or the
 *  deadline passes. The server greets a new connection with several frames
 *  (proto, cfg, a full state snapshot, tt-state) before anything we asked for,
 *  so a control client MUST be a line reader, not a read-once caller — reading
 *  a single chunk got the greeting and declared the app broken. */
async function readUntil(
  conn: Deno.Conn,
  onLine: (line: string) => boolean,
  deadline: number,
): Promise<void> {
  const decoder = new TextDecoder();
  const buf = new Uint8Array(64 * 1024);
  let pending = "";
  while (Date.now() < deadline) {
    const n = await conn.read(buf);
    if (n === null) return; // peer closed
    pending += decoder.decode(buf.subarray(0, n), { stream: true });
    let nl: number;
    while ((nl = pending.indexOf("\n")) !== -1) {
      const line = pending.slice(0, nl);
      pending = pending.slice(nl + 1);
      if (line && onLine(line)) return;
    }
  }
}

/** Send one control request over `socketPath` and await its reply.
 *
 *  Every failure is NAMED. A control client that cannot reach an app is the
 *  moment someone is already confused about which app they are talking to, so
 *  "connect refused", "the app never answered", and "the app said no" must not
 *  collapse into one message. */
export async function udsRequest(
  socketPath: string,
  path: string,
  init: {
    method: "GET" | "POST";
    headers?: Record<string, string>;
    body?: string;
  },
  timeout: number,
): Promise<UdsReply> {
  let conn: Deno.Conn;
  try {
    conn = await Deno.connect({ transport: "unix", path: socketPath });
  } catch (e) {
    return {
      error: e instanceof Deno.errors.NotFound
        ? `no socket at ${socketPath} — the app is not running (or binds a TCP port instead)`
        : `cannot open ${socketPath}: ${e}`,
    };
  }
  try {
    const id = crypto.randomUUID();
    const deadline = Date.now() + timeout;
    // Hello first, like every other peer: a version-skewed `am` is told
    // `__proto-err:<reason>` instead of being left to misread the silence.
    await conn.write(
      new TextEncoder().encode(
        // Announce first: this peer is a control client, not a window. The
        // server drops it from the roster on this frame, so a control call
        // cannot be mistaken for a connected UI.
        enc("type", { kind: "control" }) + "\n" +
          enc("proto", protoHello(VERSION)) + "\n" +
          enc("ctl", {
            id,
            path,
            method: init.method,
            headers: init.headers ?? {},
            ...(init.body !== undefined ? { body: init.body } : {}),
          }) + "\n",
      ),
    );

    let reply: UdsReply | null = null;
    await readUntil(conn, (line) => {
      // The legacy version-mismatch shim is a bare string, not an envelope —
      // it is the one frame a refused peer must be able to read.
      if (line.startsWith("__proto-err:")) {
        reply = {
          error: `protocol mismatch with the running app — ${
            line.slice("__proto-err:".length)
          }. The app and this \`am\` are different aio versions.`,
        };
        return true;
      }
      const frame = dec(line);
      if (!frame) return false;
      switch (frame.t) {
        case "ctlr": {
          const d = frame.d as CtlrPayload | undefined;
          // Not our exchange — another control call may be in flight on this
          // socket, so the id, not the kind, is what ends the wait.
          if (!d || d.id !== id) return false;
          reply = { status: d.status, body: d.body ?? "" };
          return true;
        }
        default:
          // The greeting (proto, cfg, state, tt-state) and every UI frame
          // belong to the shell, not to us. Skipped, never a violation.
          return false;
      }
    }, deadline);

    return reply ?? {
      error:
        `the app at ${socketPath} accepted the connection but never answered ` +
        `the control request (waited ${timeout}ms)`,
    };
  } catch (e) {
    return { error: `control request over ${socketPath} failed: ${e}` };
  } finally {
    try {
      conn.close();
    } catch { /* already gone */ }
  }
}
