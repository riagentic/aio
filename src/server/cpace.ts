// cpace.ts — CPace (draft-irtf-cfrg-cpace-21, suite CPACE-X25519-SHA512) and
// the aio pairing exchange built on it (`pairing: { pake: true }`).
//
// ONE implementation for both ends that run JavaScript: the server imports
// `cpace`, and the Electron client's main process embeds `cpaceSuite`'s
// source text (`electron-client-script.ts`). It is therefore ONE
// self-contained function — no imports, no reference to anything outside it
// but the platform (`crypto.subtle`, `crypto.getRandomValues`, `BigInt`,
// `TextEncoder`), so a minified build's renaming cannot break the copy. The
// Android client is a separate Kotlin port (android-template Cpace.kt); all
// three are held to the draft's Appendix B.1 vectors and to one shared
// application-layer vector (tests/pairing-pake.test.ts).
//
// X25519, SHA-512, HMAC, HKDF and AES-GCM are WebCrypto (Deno, and Node's
// `crypto.subtle` in Electron). Only Elligator2 — which no platform exposes —
// is written out, with BigInt, exactly as the draft's Appendix A.5.
//
// The aio exchange (client = initiator A, server = responder B; a party only
// ever plays its one role, which is the draft's §10.1.2 loopback defence):
//   fp   = SHA-256(DER of the TLS leaf certificate) — the one the client SEES,
//          the one the server SERVES; empty over plain http
//   PRS  = the pairing code (UTF-8)   CI = lv_cat("aio-pair-v1", fp)
//   sid  = 16 random bytes from the client   ADa = ""   ADb = the server's fp
//   1. C → S { cpace, sid, Ya }             S → C { cpace, id, Yb, ADb }
//   2. C → S { cpace, id, Ta }              S → C { Tb, box }
//   mac_key = SHA-512("CPaceMac" ‖ sid ‖ ISK)               (draft §10.4)
//   Ta = HMAC-SHA512(mac_key, lv_cat(Ya, ADa)), Tb likewise over (Yb, ADb)
//   box = iv ‖ AES-256-GCM(HKDF-SHA256(ISK, sid, "aio-pair-v1 profile"),
//         the profile JSON)
// A certificate the two sides see differently puts a different CI into each
// generator, so the keys differ and Ta fails: a relay presenting its own
// certificate learns nothing and gets one online guess per exchange, against
// the same budgets a plain `{ pin }` guess spends.

/** The CPace suite + aio's application layer. Self-contained — see header. */
export function cpaceSuite() {
  const SUITE = "CPACE-X25519-SHA512";
  const te = new TextEncoder();
  const subtle = crypto.subtle;
  const P = (1n << 255n) - 19n;
  const A = 486662n;
  const Z = 2n; // Curve25519's non-square (draft Appendix A.5)

  const cat = (...parts: Uint8Array[]): Uint8Array => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  };
  /** LEB128 length, then the bytes (draft A.1.1). */
  const prependLen = (data: Uint8Array): Uint8Array => {
    const len: number[] = [];
    let n = data.length;
    do {
      len.push(n < 128 ? n : (n & 0x7f) + 0x80);
      n = n >> 7;
    } while (n !== 0);
    return cat(new Uint8Array(len), data);
  };
  const lvCat = (...args: Uint8Array[]): Uint8Array =>
    cat(...args.map(prependLen));
  const generatorString = (
    dsi: Uint8Array,
    prs: Uint8Array,
    ci: Uint8Array,
    sid: Uint8Array,
    sInBytes: number,
  ): Uint8Array => {
    const zpad = Math.max(
      0,
      sInBytes - 1 - prependLen(prs).length - prependLen(dsi).length,
    );
    return lvCat(dsi, prs, new Uint8Array(zpad), ci, sid);
  };
  const transcriptIr = (
    ya: Uint8Array,
    ada: Uint8Array,
    yb: Uint8Array,
    adb: Uint8Array,
  ): Uint8Array => cat(lvCat(ya, ada), lvCat(yb, adb));

  const leToN = (b: Uint8Array): bigint => {
    let n = 0n;
    for (let i = b.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(b[i]!);
    return n;
  };
  const nToLe = (n: bigint): Uint8Array => {
    const out = new Uint8Array(32);
    for (let i = 0; i < 32; i++, n >>= 8n) out[i] = Number(n & 0xffn);
    return out;
  };
  const mod = (n: bigint): bigint => ((n % P) + P) % P;
  const pow = (b: bigint, e: bigint): bigint => {
    let r = 1n;
    b = mod(b);
    for (; e > 0n; e >>= 1n, b = (b * b) % P) if (e & 1n) r = (r * b) % P;
    return r;
  };
  /** RFC 7748 decodeUCoordinate for 255 bits: bit #255 is ignored. */
  const decodeU = (b: Uint8Array): bigint => {
    const c = b.slice(0, 32);
    c[31]! &= 0x7f;
    return leToN(c);
  };
  /** draft Appendix A.5 elligator2(r, q, A, 255). */
  const elligator2 = (r: bigint): Uint8Array => {
    const v = mod(-A * pow(1n + Z * r * r, P - 2n));
    const eps = pow(v * v * v + A * v * v + v, (P - 1n) / 2n);
    const x = mod(eps * v - (1n - eps) * A * pow(2n, P - 2n));
    return nToLe(x);
  };

  const sha = async (alg: string, b: Uint8Array): Promise<Uint8Array> =>
    new Uint8Array(await subtle.digest(alg, b as BufferSource));
  const sha512 = (b: Uint8Array) => sha("SHA-512", b);

  const calculateGenerator = async (
    prs: Uint8Array,
    ci: Uint8Array,
    sid: Uint8Array,
  ): Promise<Uint8Array> => {
    const h = await sha512(
      generatorString(te.encode("CPace255"), prs, ci, sid, 128),
    );
    return elligator2(decodeU(h.slice(0, 32)));
  };
  const PKCS8 = Uint8Array.from([
    0x30,
    0x2e,
    0x02,
    0x01,
    0x00,
    0x30,
    0x05,
    0x06,
    0x03,
    0x2b,
    0x65,
    0x6e,
    0x04,
    0x22,
    0x04,
    0x20,
  ]);
  /** G_X25519.scalar_mult_vfy: X25519(y, u), or G.I (32 zero bytes) when
   *  the result is the neutral element. WebCrypto REFUSES an all-zero
   *  shared secret (it throws), so a refusal is reported as G.I — which
   *  every caller then treats as the abort it is. A u it cannot even import
   *  is an abort for the same reason: nothing can be derived from it. */
  const scalarMultVfy = async (
    y: Uint8Array,
    u: Uint8Array,
  ): Promise<Uint8Array> => {
    try {
      const priv = await subtle.importKey(
        "pkcs8",
        cat(PKCS8, y) as BufferSource,
        { name: "X25519" },
        false,
        ["deriveBits"],
      );
      const pub = await subtle.importKey(
        "raw",
        u as BufferSource,
        { name: "X25519" },
        false,
        [],
      );
      return new Uint8Array(
        await subtle.deriveBits(
          { name: "X25519", public: pub } as unknown as AlgorithmIdentifier,
          priv,
          256,
        ),
      );
    } catch (_neutral) {
      // aio-ok: the refusal IS the answer — G.I, the abort case
      return new Uint8Array(32);
    }
  };
  const isNeutral = (k: Uint8Array): boolean => k.every((b) => b === 0);
  const isk = (
    sid: Uint8Array,
    k: Uint8Array,
    ya: Uint8Array,
    ada: Uint8Array,
    yb: Uint8Array,
    adb: Uint8Array,
  ): Promise<Uint8Array> =>
    sha512(
      cat(
        lvCat(te.encode("CPace255_ISK"), sid, k),
        transcriptIr(ya, ada, yb, adb),
      ),
    );

  // ── aio's application layer ───────────────────────────────────────────
  const hmac512 = async (
    key: Uint8Array,
    msg: Uint8Array,
  ): Promise<Uint8Array> => {
    const k = await subtle.importKey(
      "raw",
      key as BufferSource,
      { name: "HMAC", hash: "SHA-512" },
      false,
      ["sign"],
    );
    return new Uint8Array(await subtle.sign("HMAC", k, msg as BufferSource));
  };
  const random = (n: number): Uint8Array =>
    crypto.getRandomValues(new Uint8Array(n));
  const channel = (fp: Uint8Array): Uint8Array =>
    lvCat(te.encode("aio-pair-v1"), fp);
  const boxKey = async (isk_: Uint8Array, sid: Uint8Array) => {
    const ikm = await subtle.importKey(
      "raw",
      isk_ as BufferSource,
      "HKDF",
      false,
      ["deriveKey"],
    );
    return subtle.deriveKey(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: sid as BufferSource,
        info: te.encode("aio-pair-v1 profile"),
      },
      ikm,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
  };
  /** Constant-time byte equality (lengths are public). */
  const same = (a: Uint8Array, b: Uint8Array): boolean => {
    if (a.length !== b.length) return false;
    let d = 0;
    for (let i = 0; i < a.length; i++) d |= a[i]! ^ b[i]!;
    return d === 0;
  };
  const b64 = (b: Uint8Array): string => btoa(String.fromCharCode(...b));
  /** Base64 → bytes; null for anything that is not base64 of `len` bytes. */
  const unb64 = (s: unknown, len?: number): Uint8Array | null => {
    if (typeof s !== "string" || s.length > 8192) return null;
    try {
      const b = Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
      return len === undefined || b.length === len ? b : null;
    } catch (_notBase64) {
      // aio-ok: not base64 is the null this returns
      return null;
    }
  };
  /** Both sides, once K is known: ISK and the two confirmation tags. */
  const keys = async (
    sid: Uint8Array,
    k: Uint8Array,
    ya: Uint8Array,
    ada: Uint8Array,
    yb: Uint8Array,
    adb: Uint8Array,
  ) => {
    const i = await isk(sid, k, ya, ada, yb, adb);
    const mac = await sha512(cat(te.encode("CPaceMac"), sid, i));
    return {
      isk: i,
      ta: await hmac512(mac, lvCat(ya, ada)),
      tb: await hmac512(mac, lvCat(yb, adb)),
    };
  };

  /** Initiator (the client), message 1. `y` is for tests (the vectors). */
  const start = async (
    pin: string,
    fp: Uint8Array,
    y: Uint8Array = random(32),
    sid: Uint8Array = random(16),
  ) => {
    const g = await calculateGenerator(te.encode(pin), channel(fp), sid);
    return { sid, y, Ya: await scalarMultVfy(y, g) };
  };
  /** Responder (the server): answer message 1. null = abort (a K of G.I —
   *  a low-order or malformed Ya). */
  const respond = async (
    pin: string,
    fp: Uint8Array,
    sid: Uint8Array,
    ya: Uint8Array,
    y: Uint8Array = random(32),
  ) => {
    const g = await calculateGenerator(te.encode(pin), channel(fp), sid);
    const yb = await scalarMultVfy(y, g);
    const k = await scalarMultVfy(y, ya);
    if (isNeutral(k)) return null;
    return {
      Yb: yb,
      ADb: fp,
      ...await keys(sid, k, ya, new Uint8Array(0), yb, fp),
    };
  };
  /** Initiator, on message 2's answer. null = abort. */
  const finish = async (
    st: { sid: Uint8Array; y: Uint8Array; Ya: Uint8Array },
    yb: Uint8Array,
    adb: Uint8Array,
  ) => {
    const k = await scalarMultVfy(st.y, yb);
    if (isNeutral(k)) return null;
    return keys(st.sid, k, st.Ya, new Uint8Array(0), yb, adb);
  };
  const seal = async (
    isk_: Uint8Array,
    sid: Uint8Array,
    plain: string,
    iv: Uint8Array = random(12),
  ): Promise<Uint8Array> =>
    cat(
      iv,
      new Uint8Array(
        await subtle.encrypt(
          { name: "AES-GCM", iv: iv as BufferSource },
          await boxKey(isk_, sid),
          te.encode(plain),
        ),
      ),
    );
  /** The profile text, or null when the box does not open under this key. */
  const open = async (
    isk_: Uint8Array,
    sid: Uint8Array,
    box: Uint8Array,
  ): Promise<string | null> => {
    try {
      return new TextDecoder().decode(
        await subtle.decrypt(
          { name: "AES-GCM", iv: box.slice(0, 12) as BufferSource },
          await boxKey(isk_, sid),
          box.slice(12) as BufferSource,
        ),
      );
    } catch (_tampered) {
      // aio-ok: a box that does not open is the null returned
      return null;
    }
  };
  /** SHA-256 of a certificate's DER — the fp both sides put in CI. */
  const fingerprint = (der: Uint8Array): Promise<Uint8Array> =>
    der.length ? sha("SHA-256", der) : Promise.resolve(new Uint8Array(0));

  return {
    SUITE,
    prependLen,
    lvCat,
    generatorString,
    transcriptIr,
    calculateGenerator,
    scalarMultVfy,
    isk,
    start,
    respond,
    finish,
    seal,
    open,
    same,
    fingerprint,
    b64,
    unb64,
  };
}

/** The suite, for the server (and tests). */
export const cpace: ReturnType<typeof cpaceSuite> = cpaceSuite();

/** A pairing code for a `pairing: { pake: true }` app has 8 digits, a plain
 *  one 6. The LENGTH is the signal a client reads to know it must pair by
 *  PAKE and never fall back to sending the code: a person carries it from the
 *  app's screen to the client, so nothing on the network can change it — a
 *  server-sent "I speak PAKE" could be forged by the very relay it guards
 *  against. */
export const PAKE_PIN_DIGITS = 8;
