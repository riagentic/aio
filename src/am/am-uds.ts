/**
 * @module
 * The control plane over the local socket (a Unix socket; a named pipe on
 * windows) — `am`'s fourth-transport client.
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

export { type UdsReply, udsRequest } from "../server/local-request.ts";
