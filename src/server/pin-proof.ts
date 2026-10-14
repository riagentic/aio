// pin-proof — the app proves it holds its shared key, on the certificate it
// is presenting, without the key crossing the wire.
//
// A paired client keeps two things: the app's key, and a pin on the app's
// certificate. When the paired address presents a certificate the pin does
// not cover, the client cannot tell a server that regenerated its
// certificate from something answering in its place — and by default it
// warned and sent the key anyway (refusing would lock every paired client
// out of a legitimately re-keyed server).
//
// The key itself is what a re-keyed server still has and an impostor does
// not. So, before the key is sent:
//
//   client → { nonce, tag }      tag   = HMAC(key, "…:c:" + nonce)
//   server → { proof, cert }     proof = HMAC(key, "…:s:" + nonce + ":" + cert)
//
// `cert` is the certificate file the server serves (leaf, then its root —
// what a pairing reply carries), and the client accepts the proof only for
// the certificate it SEES on that connection. A relay cannot help: the real
// server's proof names the real certificate, and the one in the middle is
// presenting another. The server answers only a caller whose `tag` shows it
// already holds the key, so the endpoint hands nobody material to guess a
// weak key against (a wrong tag is metered like a wrong key).
import { _timingSafeEqual } from "./server-auth.ts";

const LABEL = "aio-pin-proof-v1";
/** Client nonces: hex, 16–64 bytes. Hex keeps the `:` separators unambiguous. */
const NONCE = /^[0-9a-f]{32,128}$/;

async function hmacHex(key: string, msg: string): Promise<string> {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey(
    "raw",
    enc.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", k, enc.encode(msg)),
  );
  return Array.from(sig, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** What the CLIENT sends beside its nonce: it holds the key. */
export function pinProofTag(key: string, nonce: string): Promise<string> {
  return hmacHex(key, `${LABEL}:c:${nonce}`);
}

/** What the SERVER answers: it holds the key, and `cert` is its certificate
 *  (compared with whitespace removed — PEM line breaks carry nothing). */
export function pinProofFor(
  key: string,
  nonce: string,
  cert: string,
): Promise<string> {
  return hmacHex(key, `${LABEL}:s:${nonce}:${cert.replace(/\s+/g, "")}`);
}

/** The server's answer to one request body, or why not. Pure but for the
 *  HMACs. `wrong` — a well-formed request whose tag is not this key's: the
 *  caller meters it like a wrong key. */
export async function answerPinProof(
  body: unknown,
  key: string,
  cert: string,
): Promise<
  | { ok: true; proof: string; cert: string }
  | { ok: false; wrong: boolean; error: string }
> {
  const { nonce, tag } = (body ?? {}) as { nonce?: unknown; tag?: unknown };
  if (typeof nonce !== "string" || !NONCE.test(nonce)) {
    return {
      ok: false,
      wrong: false,
      error: "nonce must be 32–128 lowercase hex characters",
    };
  }
  if (typeof tag !== "string") {
    return { ok: false, wrong: false, error: "tag must be a string" };
  }
  if (!_timingSafeEqual(tag, await pinProofTag(key, nonce))) {
    return { ok: false, wrong: true, error: "the tag is not this app's key's" };
  }
  return { ok: true, proof: await pinProofFor(key, nonce, cert), cert };
}
