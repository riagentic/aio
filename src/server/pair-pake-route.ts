// pair-pake-route.ts — `/__aio/pair` for `pairing: { pake: true }`: the
// CPace exchange (cpace.ts) over HTTP, and the refusals that keep the two
// modes apart. server.ts calls `pakePairRoute` with the parsed body before
// its plain `{ pin }` path; a null answer means "not mine, go on".
import { cpace } from "./cpace.ts";
import {
  PAKE_OFFER_TTL_MS,
  pakeConfirm,
  pakeOffer,
  PIN_TTL_MS,
  pinSentInClear,
} from "./pairing.ts";

export interface PakeRouteDeps {
  /** `pairing: { pake: true }` is on. */
  pake: boolean;
  /** The app's shared key — the pairing scope. */
  token: string;
  /** The PEM the server serves (leaf first), when it serves TLS. */
  cert?: string;
  /** The pairing reply's profile JSON — the plain path's own builder. */
  profile: () => string;
  clientKey: string | undefined;
  budgetExceeded: (clientKey: string | undefined) => boolean;
  recordFail: (clientKey: string | undefined, why: string) => void;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      // The success reply carries the sealed key: no cache may hold it.
      "Cache-Control": "no-store",
    },
  });

const _fps = new Map<string, Promise<Uint8Array>>();
/** SHA-256 of the leaf this server presents on `url`'s connection — empty
 *  over plain http, where nothing is presented. */
function servedFp(url: URL, cert: string | undefined): Promise<Uint8Array> {
  if (url.protocol !== "https:" || !cert) {
    return Promise.resolve(new Uint8Array(0));
  }
  let fp = _fps.get(cert);
  if (!fp) {
    const m = /-----BEGIN CERTIFICATE-----([^-]+)-----END CERTIFICATE-----/
      .exec(cert);
    const der = m ? cpace.unb64(m[1]!.replace(/\s+/g, "")) : null;
    if (!der) {
      throw new Error(
        "pairing: { pake: true } — the served certificate has no PEM " +
          "CERTIFICATE block to bind the exchange to",
      );
    }
    fp = cpace.fingerprint(der);
    _fps.set(cert, fp);
  }
  return fp;
}

/** The answer to one parsed `/__aio/pair` body, or null for the plain
 *  `{ pin }` path (PAKE off and no CPace body). */
export async function pakePairRoute(
  body: Record<string, unknown> | null,
  url: URL,
  d: PakeRouteDeps,
): Promise<Response | null> {
  const isCpace = body?.cpace !== undefined;
  if (!d.pake) {
    if (!isCpace) return null;
    // Spends nothing: the client asked a question this app does not answer.
    return json(400, {
      error: "this app does not pair by PAKE (pairing: { pake: true } is " +
        "not set) — its pairing codes have 6 digits",
      pake: false,
    });
  }
  if (!isCpace) {
    // An old client sent the code in the clear: burned if it was the code
    // (pairing.ts `pinSentInClear`) — the same answer either way.
    if (body?.pin !== undefined) {
      if (d.budgetExceeded(d.clientKey)) {
        return new Response("Too Many Requests", { status: 429 });
      }
      if (!pinSentInClear(body.pin, d.clientKey, d.token)) {
        d.recordFail(d.clientKey, "pairing code sent in the clear");
      }
    }
    return json(400, {
      error: "this app pairs by PAKE only (pairing: { pake: true }) and " +
        "never accepts the code itself — this aio client is too old to " +
        "pair with it and sent the code in the clear, so a code it sent is " +
        "burned: update the client, then run `am pair` for a new code",
      pake: true,
    });
  }
  if (d.budgetExceeded(d.clientKey)) {
    return new Response("Too Many Requests", { status: 429 });
  }
  if (body!.cpace !== cpace.SUITE) {
    return json(400, {
      error: `unknown PAKE suite ${JSON.stringify(body!.cpace)} — this app ` +
        `speaks ${cpace.SUITE}`,
      pake: true,
    });
  }
  const b = body!;
  if (b.id === undefined) {
    const sid = cpace.unb64(b.sid, 16);
    const ya = cpace.unb64(b.Ya, 32);
    if (!sid || !ya) {
      return json(400, {
        error: "PAKE message 1 is { cpace, sid, Ya }: sid 16 bytes and Ya " +
          "32 bytes, base64",
      });
    }
    const offer = await pakeOffer(
      sid,
      ya,
      await servedFp(url, d.cert),
      d.clientKey,
      d.token,
    );
    // No active code, this address out of guesses, or a Ya no key can come
    // from. Metered like the plain path's refusal of the same cases, so an
    // address that keeps asking reaches the same 429.
    if (!offer) {
      d.recordFail(d.clientKey, "no usable pairing code");
      return json(401, {
        error: "invalid or expired pairing code",
        hint: `no pairing code is active for this client — codes expire ` +
          `after ${Math.round(PIN_TTL_MS / 60_000)} minutes and are ` +
          `single-use: run \`am pair\` to mint one without restarting the app`,
      });
    }
    return json(200, {
      cpace: cpace.SUITE,
      id: offer.id,
      Yb: cpace.b64(offer.Yb),
      ADb: cpace.b64(offer.ADb),
    });
  }
  const ta = cpace.unb64(b.Ta, 64);
  if (!ta || typeof b.id !== "string") {
    return json(400, {
      error: "PAKE message 2 is { cpace, id, Ta }: Ta 64 bytes, base64",
    });
  }
  const r = pakeConfirm(b.id, ta, d.clientKey, d.token);
  if (r.ok) {
    return json(200, {
      Tb: cpace.b64(r.tb),
      box: cpace.b64(await cpace.seal(r.isk, r.sid, d.profile())),
    });
  }
  if (!r.wrong) {
    return json(401, {
      error: `this PAKE exchange is unknown or expired (${
        Math.round(PAKE_OFFER_TTL_MS / 1000)
      }s) — start pairing again`,
    });
  }
  // The same ledger, the same words, as a wrong plain code.
  d.recordFail(d.clientKey, "wrong pairing code");
  return json(401, {
    error: "invalid or expired pairing code",
    hint: "the code is wrong, OR the certificate this client sees is not " +
      "the one the app serves (a TLS proxy, or something answering in its " +
      `place) — codes are single-use and expire after ${
        Math.round(PIN_TTL_MS / 60_000)
      } minutes: run \`am pair\` to mint a new one`,
  });
}
