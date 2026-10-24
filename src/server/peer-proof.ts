// Peer identity — "this connection comes from aio app X", proven, not claimed.
//
// The proof is an HMAC under the CALLER's local control credential
// (`<data>/control.key`: per boot, owner-only, removed at shutdown — app-key.ts)
// over (caller appId, caller pid, TARGET appId, TARGET pid). The callee checks
// it by reading the caller's credential from disk — which only the same OS
// user can. The credential itself never crosses the wire.
//
//   - another local OS user, or a remote client: cannot read the credential,
//     so cannot make a proof.
//   - the proof names the callee AND its boot (pid): it cannot be replayed to
//     a third app, nor to the callee's next boot — a listener that squats the
//     port while the callee is down gets a proof no later boot accepts (and
//     the caller sends none at all once the callee's lock is gone).
//   - a dead or restarted caller: its credential is gone or new, and its pid
//     no longer matches a started lock — the proof dies with the boot.
// Same-user code is trusted by construction (it can read the app's data), so
// nothing here pretends to defend against it.
import { readControlKey } from "./app-key.ts";
import { _timingSafeEqual } from "./server-auth.ts";
import { instances } from "./single-instance-lock.ts";
import type { BlobStore } from "./blobs.ts";
import type { AioUser } from "./aio-types.ts";

/** The request header carrying the proof. */
export const PEER_HEADER = "x-aio-peer";

/** Who is calling, once proven. */
export type PeerIdentity = { app: string; pid: number };

const APP_ID = /^[\w.-]{1,200}$/;

async function tag(
  key: string,
  app: string,
  pid: number,
  target: string,
  targetPid: number,
): Promise<string> {
  const k = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    k,
    new TextEncoder().encode(
      `aio-peer/v1\n${app}\n${pid}\n${target}\n${targetPid}`,
    ),
  );
  return Array.from(
    new Uint8Array(mac),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}

/** The header value proving `app` (this process, `pid`) to the boot of
 *  `target` whose pid is `targetPid`, or the reason there is none (no
 *  credential minted for `app` in `home`). */
export async function signPeer(
  app: string,
  home: string | undefined,
  target: string,
  targetPid: number,
  pid = Deno.pid,
): Promise<{ header: string } | { error: string }> {
  if (!APP_ID.test(app) || !APP_ID.test(target)) {
    return { error: `not an appId: ${JSON.stringify(app)} → ${target}` };
  }
  const k = readControlKey(app, home);
  if (k.error !== undefined) return { error: k.error };
  const mac = await tag(k.key, app, pid, target, targetPid);
  return { header: `v1 ${app} ${pid} ${mac}` };
}

/** Verify a `PEER_HEADER` value addressed to `self` — THIS boot (`selfPid`).
 *  The identity, or why it was refused — never a guess. */
export async function verifyPeer(
  header: string,
  self: string,
  selfPid = Deno.pid,
): Promise<{ ok: true; peer: PeerIdentity } | { ok: false; why: string }> {
  const [v, app, pidS, mac, ...rest] = header.trim().split(" ");
  const pid = Number(pidS);
  if (
    v !== "v1" || !app || !APP_ID.test(app) || !Number.isSafeInteger(pid) ||
    pid <= 0 || !mac || !/^[0-9a-f]{64}$/.test(mac) || rest.length > 0
  ) return { ok: false, why: "malformed peer proof" };
  const live = instances(app).find((i) =>
    i.pid === pid && i.alive && i.status === "started"
  );
  if (!live) {
    return {
      ok: false,
      why: `no started instance of "${app}" with pid ${pid}`,
    };
  }
  const k = readControlKey(app, live.home);
  if (k.error !== undefined) return { ok: false, why: k.error };
  return _timingSafeEqual(mac, await tag(k.key, app, pid, self, selfPid))
    ? { ok: true, peer: { app, pid } }
    : { ok: false, why: "peer proof does not verify" };
}

/** THE peer decider, for every door that takes a proof (the HTTP/WS
 *  handshake header, the local socket's identity hello): verify `header` for
 *  THIS boot of `self`, then ask the app's `resolvePeer` who that peer is. A
 *  proof that does not verify is refused — never quietly anonymous; `user:
 *  null` is "proven, but this app admits no identity for it". */
export async function provePeer(
  header: string,
  self: string,
  resolve: (p: PeerIdentity) => AioUser | null | Promise<AioUser | null>,
): Promise<
  { ok: true; peer: PeerIdentity; user: AioUser | null } | {
    ok: false;
    why: string;
  }
> {
  const v = await verifyPeer(header, self);
  if (!v.ok) return v;
  return { ok: true, peer: v.peer, user: (await resolve(v.peer)) ?? null };
}

/** Where a proven peer uploads bytes (`peer().upload`): POST, the body is the
 *  bytes, `?name=` optional. The ONLY write door into the blob store that aio
 *  opens itself, and only past `resolvePeer` — every other upload is an app
 *  route the app wrote. */
export const PEER_UPLOAD_PATH = "/__aio/blobs";

/** sha256("") — the id every empty blob has. */
const EMPTY_BLOB_ID =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/** Store a proven peer's upload, streamed (hashed and spooled chunk by chunk
 *  — a multi-GB body costs one chunk of memory). Answers `{ id, size, name }`.
 *  An app with no blob store, a method other than POST and an empty body are
 *  said, with their status. */
export async function peerUpload(
  req: Request,
  url: URL,
  blobs: BlobStore | undefined,
): Promise<Response> {
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { Allow: "POST" },
    });
  }
  if (!blobs) return json(404, { error: "this app has no blob store" });
  const empty = () => json(400, { error: "empty body — nothing stored" });
  if (!req.body) return empty();
  // An empty body is known only once read: its id is sha256("") — an empty
  // blob the app itself stored has that id too, so it is removed only when
  // this upload is what created it.
  const had = await blobs.info(EMPTY_BLOB_ID);
  const name = url.searchParams.get("name") ?? undefined;
  const info = await blobs.put(req.body, { ...(name ? { name } : {}) });
  if (info.size === 0) {
    if (!had) await blobs.delete(info.id);
    return empty();
  }
  return json(200, info);
}
