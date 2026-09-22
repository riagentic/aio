// x509.ts — the two certificates aio needs, written in DER, with no openssl.
//
// WHY THIS EXISTS. Automatic HTTPS used to shell out to `openssl` four times:
// generate the machine root, make a CSR, sign the leaf, read a cert's SANs.
// Linux and macOS ship an openssl; WINDOWS DOES NOT. So `--expose` on a stock
// Windows machine died with `NotFound: Failed to spawn 'openssl'` — a whole
// supported target with no automatic HTTPS, found by running the suite on a
// real Windows 11 VM. A binary that has to be on PATH is not a dependency a
// framework gets to have for a headline feature.
//
// WHY NOT A LIBRARY. Measured before choosing: `@peculiar/x509` does the job
// correctly, but costs a 19-package / 2.06 MB graph that pulls `tsyringe` and
// `reflect-metadata` into `src/server`, and +2.2 MB on each of the five
// binaries aio ships. `pkijs` is the same with more ceremony; `node-forge`
// cannot sign with ECDSA at all (RSA only); `@fidm/x509` is parse-only and
// unmaintained since 2019; JSR has nothing. This file is ~250 lines for two
// certificate shapes that never vary, and it adds 0 MB to a compiled binary.
//
// WHAT IS PROVEN, AND BY WHAT. A hand-written encoder is only worth trusting
// if something other than its author agrees with it, so three independent
// instruments do (tests/x509.test.ts):
//   1. `openssl x509 -text` prints the same extensions openssl itself wrote,
//      name constraints included, line for line;
//   2. `openssl verify -CAfile` builds and accepts the chain;
//   3. a REAL rustls handshake — Deno.serve with the chain, and a client that
//      trusts ONLY the generated root — completes and reads a body.
// Plus the one that proves the security property rather than the bytes: a leaf
// minted for `example.com` under this root is REFUSED with "permitted subtree
// violation". The name constraints bite; they are not merely present.
//
// WHAT THOSE THREE COULD NOT SEE, found by feeding the encoder what a real
// machine and a real thief would, and by asking verifiers that are neither
// openssl nor rustls (Java's CertPathValidator, Python's `cryptography`):
//   • a SAN the root may not name — a Tailscale 100.64/10 address, say —
//     invalidates the WHOLE certificate, localhost included. `tls.ts` now
//     filters the SAN set against the root's own subtrees and says so.
//   • name constraints bound WHICH addresses and nothing about FOR WHAT, and
//     rfc822Name/otherName are not constrained at all: with the key, openssl
//     accepted an S/MIME certificate for `ceo@bigbank.com` and a client
//     certificate carrying a Windows UPN. The root carries an extendedKeyUsage
//     AND rfc822Name/URI bases, because one of them is not enough: measured on
//     macOS 14.8.9, Security.framework does not apply a trust anchor's EKU and
//     accepted the `ceo@bigbank.com` certificate with the EKU alone. openssl
//     refuses it at depth 1 for the EKU, macOS at depth 0 for the base.
//   • `"999.888.777.666"` minted as 231.120.9.154 and `"1.2.3"` as a
//     three-byte iPAddress neither Java nor Python will read. Addresses are
//     now parsed strictly, or refused.
//   • openssl compares issuer and subject CANONICALLY, so it accepts a
//     re-encoded DN — only a rustls handshake against a PrintableString root
//     can prove the verbatim issuer copy below is load-bearing. One now does.
//
// AND THE LIMIT THAT REMAINS, measured: RFC 5280 §6.1 begins path validation
// AFTER the trust anchor, so a validator that follows it literally never reads
// the constraints in a self-signed root at all. Java's CertPathValidator is
// one — it accepts `DNS:www.google.com` under this root, and rejects the same
// leaf the moment the constraints sit on an intermediate. Closing that means
// issuing leaves from a name-constrained intermediate.
//
// Every other verifier aio ships against DOES read the anchor, measured with
// controls: openssl, rustls, NSS, Go, macOS Security.framework 14.8.9 and
// Windows CryptoAPI (Win11 26200) all refuse a forged public name under this
// root and all accept the legitimate `localhost` leaf. Java is the outlier,
// not the rule. Do NOT read the extendedKeyUsage as covering Java anyway: a
// forged SERVER certificate for a public name needs exactly serverAuth, so on
// a verifier that skips the anchor the EKU is no obstacle to the case that
// matters most.
//
// A WARNING ABOUT MEASURING THIS, which cost an hour and nearly shipped a
// false claim in the other direction: a chain built with the root in .NET's
// `ChainPolicy.ExtraStore` rather than a real trust store reports NO name
// constraint violation at all — not for the anchor and not even for an
// INTERMEDIATE. It does still report EKU violations, so the setup looks like
// it is working. The first Windows run this way "showed" CryptoAPI ignoring
// anchor constraints; a positive control (the same violation moved onto an
// intermediate) showed the instrument was blind. Install the root.
//
// SCOPE. An encoder for exactly two certificate shapes, plus a reader for one
// extension. Not a general X.509 library, and it must never grow into one —
// everything here is reachable from `tls.ts` and nothing else.

/** A byte string DER-encoded. `Uint8Array<ArrayBuffer>` rather than plain
 *  `Uint8Array` because Deno 2.9's `BufferSource` will not accept the latter
 *  where WebCrypto wants bytes. */
type Bytes = Uint8Array<ArrayBuffer>;

const bytes = (n: number[]): Bytes => Uint8Array.from(n) as Bytes;

function cat(...xs: Uint8Array[]): Bytes {
  const out = new Uint8Array(xs.reduce((n, x) => n + x.length, 0)) as Bytes;
  let o = 0;
  for (const x of xs) {
    out.set(x, o);
    o += x.length;
  }
  return out;
}

// ── DER primitives ──────────────────────────────────────────────────────────

/** DER length: short form below 128, long form above. */
function derLen(n: number): Bytes {
  if (n < 0x80) return bytes([n]);
  const b: number[] = [];
  for (let v = n; v > 0; v >>>= 8) b.unshift(v & 0xff);
  return bytes([0x80 | b.length, ...b]);
}

const tlv = (tag: number, body: Uint8Array): Bytes =>
  cat(bytes([tag]), derLen(body.length), body);

const SEQ = (...xs: Uint8Array[]): Bytes => tlv(0x30, cat(...xs));
const SET = (...xs: Uint8Array[]): Bytes => tlv(0x31, cat(...xs));
const OCTET = (b: Uint8Array): Bytes => tlv(0x04, b);
const BOOL = (v: boolean): Bytes => tlv(0x01, bytes([v ? 0xff : 0x00]));
/** Context-specific CONSTRUCTED [n]. */
const CTX = (n: number, body: Uint8Array): Bytes => tlv(0xa0 | n, body);
/** Context-specific PRIMITIVE [n] — an IMPLICIT tag REPLACES the base tag, so
 *  a dNSName is `[2] <raw ascii>` and never a nested IA5String. Emitting the
 *  inner tag as well is the classic way to produce a cert that parses and
 *  then matches nothing. */
const CTXP = (n: number, body: Uint8Array): Bytes => tlv(0x80 | n, body);

/** INTEGER, with the sign handling DER demands: leading zero bytes are
 *  stripped, and exactly one 0x00 goes back in front when the top bit is set
 *  (otherwise the value reads as negative). Load-bearing for the ECDSA r/s
 *  pair, where roughly half of all signatures need the pad. */
function INT(v: Uint8Array | number): Bytes {
  let b: number[];
  if (typeof v === "number") {
    b = [];
    let n = v;
    do {
      b.unshift(n & 0xff);
      n >>>= 8;
    } while (n > 0);
  } else b = [...v];
  while (b.length > 1 && b[0] === 0 && !(b[1]! & 0x80)) b.shift();
  if (b[0]! & 0x80) b.unshift(0);
  return tlv(0x02, bytes(b));
}

function OID(dotted: string): Bytes {
  const p = dotted.split(".").map(Number);
  const b: number[] = [40 * p[0]! + p[1]!];
  for (const n of p.slice(2)) {
    const chunk: number[] = [n & 0x7f];
    let v = n >>> 7;
    while (v > 0) {
      chunk.unshift((v & 0x7f) | 0x80);
      v >>>= 7;
    }
    b.push(...chunk);
  }
  return tlv(0x06, bytes(b));
}

/** BIT STRING, with the unused-bits octet DER requires. */
const BITS = (b: Uint8Array, unused = 0): Bytes =>
  tlv(0x03, cat(bytes([unused]), b));

const UTF8 = (s: string): Bytes => tlv(0x0c, new TextEncoder().encode(s));

/** RFC 5280 §4.1.2.5: UTCTime (two-digit year) through 2049, GeneralizedTime
 *  (four-digit) from 2050.
 *
 *  Not hypothetical for aio: the machine root is valid for 3650 days, so any
 *  root created from January 2040 onward already ends past the boundary, and a
 *  hardcoded UTCTime would silently write a year in the 1900s — a certificate
 *  that expired decades ago, generated fresh. */
function Time(d: Date): Bytes {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  const y = d.getUTCFullYear();
  const rest = `${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${
    p(d.getUTCHours())
  }${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  return y < 2050
    ? tlv(0x17, new TextEncoder().encode(`${p(y % 100)}${rest}`))
    : tlv(0x18, new TextEncoder().encode(`${p(y, 4)}${rest}`));
}

// ── DER walking (for the reader half) ───────────────────────────────────────

function readLen(b: Uint8Array, i: number): { len: number; next: number } {
  const first = b[i]!;
  if (first < 0x80) return { len: first, next: i + 1 };
  const n = first & 0x7f;
  let v = 0;
  for (let k = 0; k < n; k++) v = (v << 8) | b[i + 1 + k]!;
  return { len: v, next: i + 1 + n };
}

/** `h` is where the TAG starts, `s` where the CONTENT starts, `e` where it
 *  ends. Keeping `h` is what lets a caller slice an element back out WITH its
 *  header — reconstructing that header from the content length instead is an
 *  encoder hiding inside a decoder, and it gets the long form wrong. */
type Node = { tag: number; h: number; s: number; e: number };

/** The direct children of a DER container. */
function children(b: Uint8Array, start: number, end: number): Node[] {
  const out: Node[] = [];
  let i = start;
  while (i < end - 1) {
    const tag = b[i]!;
    const { len, next } = readLen(b, i + 1);
    const e = next + len;
    if (e > end) break;
    out.push({ tag, h: i, s: next, e });
    i = e;
  }
  return out;
}

/** Every node, depth first. Constructed tags are descended into. */
function* walk(b: Uint8Array, start = 0, end = b.length): Generator<Node> {
  for (const n of children(b, start, end)) {
    yield n;
    if (n.tag & 0x20) yield* walk(b, n.s, n.e);
  }
}

// ── PEM ─────────────────────────────────────────────────────────────────────

export function toPem(der: Uint8Array, label: string): string {
  let b64 = "";
  for (let i = 0; i < der.length; i += 0x8000) {
    b64 += String.fromCharCode(...der.subarray(i, i + 0x8000));
  }
  return `-----BEGIN ${label}-----\n${
    btoa(b64).match(/.{1,64}/g)!.join("\n")
  }\n-----END ${label}-----\n`;
}

/** The FIRST block of `label` in a PEM file. A chain file's first certificate
 *  is the leaf, which is the one that carries the addresses — the same rule
 *  the openssl call this replaced depended on. */
export function fromPem(pem: string, label = "CERTIFICATE"): Bytes {
  const m = pem.match(
    new RegExp(`-----BEGIN ${label}-----([\\s\\S]*?)-----END ${label}-----`),
  );
  if (!m) throw new Error(`no ${label} block in PEM`);
  return Uint8Array.from(
    atob(m[1]!.replace(/\s+/g, "")),
    (c) => c.charCodeAt(0),
  ) as Bytes;
}

// ── names and addresses ─────────────────────────────────────────────────────

const OID_CN = "2.5.4.3";
const OID_O = "2.5.4.10";
const OID_ECDSA_SHA256 = "1.2.840.10045.4.3.2";
const SIG_ALG = SEQ(OID(OID_ECDSA_SHA256));

const rdn = (oid: string, value: string) => SET(SEQ(OID(oid), UTF8(value)));

/** A Name. openssl writes these as UTF8String too, so a leaf issued here under
 *  a root openssl generated earlier carries a byte-identical issuer DN — which
 *  is what lets a client match the two. */
export function distinguishedName(cn: string, org?: string): Bytes {
  return org ? SEQ(rdn(OID_CN, cn), rdn(OID_O, org)) : SEQ(rdn(OID_CN, cn));
}

/** An address that cannot be encoded is an ERROR, never a best guess.
 *
 *  The permissive version of this shipped: `"999.888.777.666"` became
 *  `231.120.9.154` (`Number` then a Uint8Array truncation), `"1.2.3"` became a
 *  THREE-byte iPAddress that Java and Python both refuse to read back, and
 *  `"1:2:3:4:5:6:7:8:9:10"` silently lost its last two groups. Every one of
 *  those minted a certificate openssl parses happily — a certificate naming an
 *  address nobody asked for, which is the worst possible answer to "what is
 *  this server called". */
function ipv4(s: string): Bytes {
  const p = s.split(".");
  if (p.length !== 4) throw new Error(`not an IPv4 address: ${s}`);
  return bytes(p.map((g) => {
    if (!/^\d{1,3}$/.test(g)) throw new Error(`not an IPv4 address: ${s}`);
    const n = Number(g);
    if (n > 255) throw new Error(`not an IPv4 address: ${s}`);
    return n;
  }));
}

function ipv6(s: string): Bytes {
  const halves = s.split("::");
  if (halves.length > 2) throw new Error(`not an IPv6 address: ${s}`);
  const [head, tail] = halves;
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  // `::` must actually elide at least one group, and the whole thing must come
  // to exactly eight. Checked BEFORE the fill, so an over-long address is
  // "not an IPv6 address" rather than a RangeError from `Array(-1)`.
  const elided = halves.length === 2 ? 8 - h.length - t.length : 0;
  if (halves.length === 2 ? elided < 1 : h.length !== 8) {
    throw new Error(`not an IPv6 address: ${s}`);
  }
  // An IPv4 dotted tail (`::ffff:1.2.3.4`) is refused rather than misread as a
  // hex group, which is what the permissive parser did.
  const groups = [...h, ...Array(elided).fill("0"), ...t];
  const out = new Uint8Array(16) as Bytes;
  groups.forEach((g, i) => {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) {
      throw new Error(`not an IPv6 address: ${s}`);
    }
    const v = parseInt(g, 16);
    out[i * 2] = v >> 8;
    out[i * 2 + 1] = v & 0xff;
  });
  return out;
}

const ipBytes = (s: string): Bytes => s.includes(":") ? ipv6(s) : ipv4(s);

/** Is `ip` inside the name-constraint subtree `[base, mask]`?
 *
 *  Lives HERE, beside the encoder that turns an address into bytes, because a
 *  second address parser is a second answer: the caller that decides which
 *  addresses a leaf may carry and the encoder that writes them must agree
 *  byte for byte or the certificate is refused as a whole. */
export function ipWithinSubtree(
  ip: string,
  [base, mask]: readonly [string, string],
): boolean {
  let a: Bytes, b: Bytes, m: Bytes;
  try {
    a = ipBytes(ip);
    b = ipBytes(base);
    m = ipBytes(mask);
  } catch {
    return false; // an address that will not encode is in no subtree
  }
  if (a.length !== b.length || b.length !== m.length) return false;
  return a.every((x, i) => (x & m[i]!) === (b[i]! & m[i]!));
}

/** RFC 5280 §4.2.1.10 dNSName matching, plus the leading-dot spelling openssl
 *  and NSS both read as "this domain and anything under it". */
export function dnsWithinSubtree(name: string, base: string): boolean {
  const n = name.toLowerCase(), b = base.toLowerCase();
  return b === "" ||
    (b.startsWith(".")
      ? n.length > b.length && n.endsWith(b)
      : n === b || n.endsWith(`.${b}`));
}

/** GeneralName [2] dNSName and [7] iPAddress.
 *
 *  The same [7] tag means two different things by LENGTH: in a SAN it is the
 *  address alone (4 or 16 bytes); in a name constraint it is address followed
 *  by mask (8 or 32). Length is the only discriminator, so the two are built
 *  by different callers on purpose. */
const gnDns = (d: string) => CTXP(2, new TextEncoder().encode(d));
const gnIp = (ip: string) => CTXP(7, ipBytes(ip));

/** GeneralName [1] rfc822Name and [6] uniformResourceIdentifier — used ONLY as
 *  name-constraint bases here, never in a SAN. Same IA5String-as-raw-bytes
 *  encoding as [2]. */
const gnEmail = (e: string) => CTXP(1, new TextEncoder().encode(e));
const gnUri = (u: string) => CTXP(6, new TextEncoder().encode(u));

// ── extensions ──────────────────────────────────────────────────────────────

const ext = (oid: string, critical: boolean, value: Uint8Array) =>
  critical
    ? SEQ(OID(oid), BOOL(true), OCTET(value))
    : SEQ(OID(oid), OCTET(value));

/** `cA` is DEFAULT FALSE, so DER must OMIT it for a leaf: CA:FALSE is an
 *  EMPTY sequence, never `SEQUENCE { BOOLEAN FALSE }`. */
const basicConstraints = (ca: boolean, pathLen?: number) =>
  ext(
    "2.5.29.19",
    true,
    !ca
      ? SEQ()
      : pathLen === undefined
      ? SEQ(BOOL(true))
      : SEQ(BOOL(true), INT(pathLen)),
  );

export const KU_digitalSignature = 0;
export const KU_keyEncipherment = 2;
export const KU_keyCertSign = 5;
export const KU_cRLSign = 6;

/** KeyUsage. Bit 0 is the MSB of the first byte, trailing zero bits are not
 *  encoded, and the unused-bits count must be exact. */
function keyUsage(...bits: number[]): Bytes {
  const nBytes = Math.floor(Math.max(...bits) / 8) + 1;
  const b = new Uint8Array(nBytes) as Bytes;
  for (const bit of bits) b[bit >> 3]! |= 0x80 >> (bit & 7);
  let last = nBytes - 1;
  while (last > 0 && b[last] === 0) last--;
  const trimmed = b.subarray(0, last + 1);
  let unused = 0;
  while (unused < 8 && !(trimmed[last]! & (1 << unused))) unused++;
  return ext("2.5.29.15", true, BITS(trimmed, unused));
}

const extendedKeyUsageServerAuth = () =>
  ext("2.5.29.37", false, SEQ(OID("1.3.6.1.5.5.7.3.1")));

/** The subjectPublicKey BIT STRING's bits, found by walking the SPKI rather
 *  than by counting backwards from its end — the key's length is not a
 *  constant anyone here should be relying on. */
function publicKeyBits(spki: Uint8Array): Bytes {
  const top = children(spki, 0, spki.length)[0];
  if (!top) throw new Error("malformed SPKI");
  const bitStr = children(spki, top.s, top.e).find((n) => n.tag === 0x03);
  if (!bitStr) throw new Error("no subjectPublicKey in SPKI");
  // `slice`, not `subarray`: WebCrypto wants a buffer it owns the whole of.
  return spki.slice(bitStr.s + 1, bitStr.e) as Bytes; // past the unused-bits octet
}

/** RFC 5280 method (1): SHA-1 over the public key bits. */
async function subjectKeyIdentifier(spki: Uint8Array): Promise<Bytes> {
  const h = new Uint8Array(
    await crypto.subtle.digest("SHA-1", publicKeyBits(spki)),
  ) as Bytes;
  return ext("2.5.29.14", false, OCTET(h));
}

/** `GeneralNames ::= SEQUENCE SIZE (1..MAX)`, so an empty one is not a SAN
 *  with no addresses — it is a malformed extension. openssl reads it without
 *  complaint; Java answers `No data available in passed DER encoded value` and
 *  Python hands back `[]`, so a leaf that named nothing would fail later, on
 *  someone else's machine, as a hostname mismatch nobody can explain. */
const subjectAltName = (dns: string[], ips: string[]) => {
  if (dns.length + ips.length === 0) {
    throw new Error("a server certificate must name at least one address");
  }
  return ext("2.5.29.17", false, SEQ(...dns.map(gnDns), ...ips.map(gnIp)));
};

/** Permitted subtrees. A name type left UNCONSTRAINED is unrestricted, which
 *  is why callers list DNS and IP both.
 *
 *  The other name forms — rfc822Name, otherName, uniformResourceIdentifier,
 *  directoryName — stay unconstrained, and there is no portable way to write
 *  "exclude all of these": an empty excluded base means "everything" to Go and
 *  "nothing" to openssl (measured: an empty excluded rfc822Name printed as
 *  `email:` and stopped nothing), and a directoryName subtree in a CRITICAL
 *  extension is a name type Go refuses to process at all, which would make
 *  every chain unverifiable there. What bounds them instead is the
 *  extendedKeyUsage on the root: none of those forms is usable for serverAuth,
 *  so a certificate built around one is refused on purpose grounds. */
function nameConstraints(
  dns: string[],
  ipMasks: readonly (readonly [string, string])[],
) {
  if (dns.length === 0 && ipMasks.length === 0) {
    // permittedSubtrees MUST have at least one GeneralSubtree (RFC 5280
    // §4.2.1.10). An empty SEQUENCE here is a malformed extension that some
    // verifiers reject outright and others quietly ignore — the worst pair,
    // since "ignored" means the root is UNCONSTRAINED while looking safe.
    throw new Error(
      "x509: name constraints with no permitted subtree would be a malformed " +
        "extension, and a verifier that ignores it treats the root as " +
        "unconstrained. Pass at least one DNS or IP base.",
    );
  }
  const subtrees = [
    ...dns.map((d) => SEQ(gnDns(d))),
    ...ipMasks.map(([addr, mask]) =>
      SEQ(CTXP(7, cat(ipBytes(addr), ipBytes(mask))))
    ),
    // A name type left out of permittedSubtrees is UNRESTRICTED, and these two
    // are the ones a stolen root key would reach for. `.invalid` is reserved
    // by RFC 2606 and can never be a real address or host, so permitting only
    // that is the narrowest legal way to say "none".
    //
    // These are NOT redundant with the serverAuth extendedKeyUsage on the
    // root, which is what it looked like until it was measured. macOS
    // Security.framework does NOT enforce EKU nesting at a trust anchor: with
    // the EKU alone and no email base, `security verify-cert -p smime`
    // ACCEPTED a certificate for `ceo@bigbank.com` signed by this root
    // (macOS 14.8.9, controlled against a no-EKU root that also accepted it,
    // so the EKU was doing nothing). With this base present the same verifier
    // refuses it, while a legitimate `localhost` server leaf under the same
    // root still verifies. openssl refuses it either way — at depth 1 for the
    // EKU, at depth 0 for this. Two independent locks, because the verifiers
    // that ship disagree about which one they check.
    SEQ(gnEmail(".invalid")),
    SEQ(gnUri(".invalid")),
  ];
  return ext("2.5.29.30", true, SEQ(CTX(0, cat(...subtrees))));
}

// ── keys and signing ────────────────────────────────────────────────────────

const EC_P256 = { name: "ECDSA", namedCurve: "P-256" } as const;
const EC_SHA256 = { name: "ECDSA", hash: "SHA-256" } as const;

async function generateKeyPair() {
  const kp = await crypto.subtle.generateKey(EC_P256, true, [
    "sign",
    "verify",
  ]) as CryptoKeyPair;
  return {
    priv: kp.privateKey,
    spki: new Uint8Array(
      await crypto.subtle.exportKey("spki", kp.publicKey),
    ) as Bytes,
    pkcs8: new Uint8Array(
      await crypto.subtle.exportKey("pkcs8", kp.privateKey),
    ) as Bytes,
  };
}

/** Import a PKCS#8 private key from PEM — including one openssl wrote on an
 *  earlier version, which is why this must keep working. */
export function importPrivateKeyPem(pem: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "pkcs8",
    fromPem(pem, "PRIVATE KEY"),
    EC_P256,
    false,
    ["sign"],
  );
}

/** WebCrypto returns ECDSA signatures as raw r‖s (P1363); X.509 wants
 *  SEQUENCE { r INTEGER, s INTEGER }. */
function ecdsaP1363ToDer(raw: Uint8Array): Bytes {
  const half = raw.length / 2;
  return SEQ(INT(raw.subarray(0, half)), INT(raw.subarray(half)));
}

/** 16 random bytes with the top bit clear: positive without a pad byte, and
 *  wide enough that two certificates never collide in a trust store — a
 *  constant serial makes a re-issued leaf indistinguishable from the one it
 *  replaced, and some stores keep the first. */
function serialNumber(): Bytes {
  const b = crypto.getRandomValues(new Uint8Array(16)) as Bytes;
  b[0]! &= 0x7f;
  if (b[0] === 0) b[0] = 1;
  return b;
}

async function buildCert(opts: {
  subject: Uint8Array;
  issuer: Uint8Array;
  spki: Uint8Array;
  signWith: CryptoKey;
  days: number;
  exts: Uint8Array[];
}): Promise<Bytes> {
  const now = Date.now();
  // A minute of backdating: clocks between a server and its clients disagree,
  // and a certificate that is not valid yet fails exactly like a broken one.
  const notBefore = new Date(now - 60_000);
  const notAfter = new Date(now + opts.days * 86_400_000);
  const tbs = SEQ(
    CTX(0, INT(2)), // version: v3
    INT(serialNumber()),
    SIG_ALG,
    opts.issuer,
    SEQ(Time(notBefore), Time(notAfter)),
    opts.subject,
    opts.spki,
    CTX(3, SEQ(...opts.exts)),
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign(EC_SHA256, opts.signWith, tbs),
  );
  return SEQ(tbs, SIG_ALG, BITS(ecdsaP1363ToDer(sig)));
}

// ── the two certificates aio needs ──────────────────────────────────────────

export type Pem = { certPem: string; keyPem: string };

/** This machine's local root: a CA that may sign for loopback and private
 *  addresses and nothing else. */
export async function generateRoot(opts: {
  commonName: string;
  org: string;
  days: number;
  permittedDns: string[];
  permittedIpMasks: readonly (readonly [string, string])[];
}): Promise<Pem> {
  const k = await generateKeyPair();
  const dn = distinguishedName(opts.commonName, opts.org);
  const der = await buildCert({
    subject: dn,
    issuer: dn, // self-signed
    spki: k.spki,
    signWith: k.priv,
    days: opts.days,
    exts: [
      basicConstraints(true, 0),
      keyUsage(KU_keyCertSign, KU_cRLSign),
      await subjectKeyIdentifier(k.spki),
      nameConstraints(opts.permittedDns, opts.permittedIpMasks),
      // The name constraints answer "WHICH addresses" and say nothing about
      // "FOR WHAT". Without this line a root a person was asked to install
      // machine-wide also vouches for code signing, S/MIME and client auth —
      // and those name forms are not constrained at all, so with the key in
      // hand `openssl verify -purpose smimesign` accepted a certificate for
      // `ceo@bigbank.com`, and `-purpose sslclient` one carrying a Windows UPN
      // `admin@corp.example`. Measured, not reasoned: with serverAuth here
      // both are refused at depth 1 (the root itself is unsuitable), while the
      // rustls handshake and `openssl verify` of a real leaf are unchanged.
      // This line alone is NOT enough. The earlier claim here that "Windows
      // CryptoAPI and macOS Security.framework enforce the same nesting" was
      // written from documentation, and half of it is false. Measured, each
      // against a control root carrying no EKU:
      //
      //   Windows CryptoAPI (Win11 26200): DOES apply it. The S/MIME leaf is
      //     NotValidForUsage; the control is accepted.
      //   macOS Security.framework 14.8.9: DOES NOT. `security verify-cert
      //     -p smime` accepted a `ceo@bigbank.com` certificate signed by this
      //     root, identically to the control — the extension did nothing.
      //   openssl: refuses at depth 1, "unsuitable certificate purpose".
      //
      // So macOS is covered by the rfc822Name/URI bases above and not by this
      // line, and the two together are why neither gap is open on any
      // verifier that reads the anchor at all. aio needs no other purpose.
      extendedKeyUsageServerAuth(),
    ],
  });
  return {
    certPem: toPem(der, "CERTIFICATE"),
    keyPem: toPem(k.pkcs8, "PRIVATE KEY"),
  };
}

/** A server leaf, signed by the root, naming the addresses this machine
 *  answers on right now. */
export async function issueLeaf(opts: {
  commonName: string;
  dns: string[];
  ips: string[];
  days: number;
  caCertPem: string;
  caKeyPem: string;
}): Promise<Pem> {
  const k = await generateKeyPair();
  const caKey = await importPrivateKeyPem(opts.caKeyPem);
  const der = await buildCert({
    subject: distinguishedName(opts.commonName),
    // The issuer DN is copied from the CA certificate VERBATIM rather than
    // re-encoded from a string. A root openssl generated on an earlier version
    // is still on disk on every machine that ever ran one, and a DN that
    // re-encodes even slightly differently is a chain no client can build.
    issuer: certSubjectDer(opts.caCertPem),
    spki: k.spki,
    signWith: caKey,
    days: opts.days,
    exts: [
      basicConstraints(false),
      keyUsage(KU_digitalSignature, KU_keyEncipherment),
      extendedKeyUsageServerAuth(),
      subjectAltName(opts.dns, opts.ips),
      await authorityKeyIdentifier(opts.caCertPem),
    ],
  });
  return {
    certPem: toPem(der, "CERTIFICATE"),
    keyPem: toPem(k.pkcs8, "PRIVATE KEY"),
  };
}

// ── the reader half ─────────────────────────────────────────────────────────

/** The `subject` field of a certificate, as the exact bytes it was encoded
 *  with. TBSCertificate's sixth element when a [0] version is present. */
export function certSubjectDer(certPem: string): Bytes {
  const der = fromPem(certPem);
  const cert = children(der, 0, der.length)[0];
  if (!cert) throw new Error("malformed certificate");
  const tbs = children(der, cert.s, cert.e)[0];
  if (!tbs) throw new Error("malformed certificate: no tbsCertificate");
  const f = children(der, tbs.s, tbs.e);
  // [0] version (optional), serial, sigAlg, issuer, validity, subject, …
  const i = f[0]?.tag === 0xa0 ? 5 : 4;
  const subject = f[i];
  if (!subject) throw new Error("malformed certificate: no subject");
  if (subject.tag !== 0x30) {
    throw new Error(
      `malformed certificate: subject is tag 0x${
        subject.tag.toString(16)
      }, not a SEQUENCE`,
    );
  }
  return der.slice(subject.h, subject.e) as Bytes;
}

const SAN_OID = [0x55, 0x1d, 0x11]; // 2.5.29.17
const NC_OID = [0x55, 0x1d, 0x1e]; // 2.5.29.30
const SKI_OID = [0x55, 0x1d, 0x0e]; // 2.5.29.14

/** The contents of the extension with this OID, or null when absent.
 *
 *  Returns what is INSIDE the extension's OCTET STRING wrapper, which is where
 *  every extension's real value lives. One finder for both readers below: an
 *  extension located two different ways is two different readers. */
function findExtension(der: Uint8Array, oid: number[]): Uint8Array | null {
  const nodes = [...walk(der)];
  for (let k = 0; k < nodes.length; k++) {
    const n = nodes[k]!;
    if (n.tag !== 0x06 || n.e - n.s !== oid.length) continue;
    let hit = true;
    for (let j = 0; j < oid.length; j++) {
      if (der[n.s + j] !== oid[j]) {
        hit = false;
        break;
      }
    }
    if (!hit) continue;
    const oct = nodes.slice(k + 1).find((x) => x.tag === 0x04);
    if (!oct) return null;
    return der.subarray(oct.s, oct.e);
  }
  return null;
}

function ipToString(b: Uint8Array): string {
  if (b.length === 4) return [...b].join(".");
  if (b.length === 16) {
    const g: string[] = [];
    for (let i = 0; i < 16; i += 2) {
      g.push((((b[i]! << 8) | b[i + 1]!) >>> 0).toString(16));
    }
    // The fully expanded spelling, which is what openssl printed too — so
    // `normIp`/`sansCover` see exactly what they always saw.
    return g.join(":");
  }
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** The subjectAltName of the FIRST certificate in `certPem`, or null when it
 *  carries none. Replaces `openssl x509 -ext subjectAltName`. */
/** Which GeneralName TYPES a root's permittedSubtrees actually covers.
 *
 *  A name type left out of permittedSubtrees is UNRESTRICTED — so this is the
 *  question "what can a thief with this key still mint?", asked of a root that
 *  is already on disk. Roots written before the rfc822Name/URI bases were
 *  added cover DNS and IP only, and `tls.ts` reuses a root VERBATIM forever,
 *  so nothing would otherwise ever notice.
 *
 *  Returns null when the certificate carries no name constraints at all, which
 *  is a different and worse answer than "covers nothing". */
export function certConstrainedNameTypes(
  certPem: string,
): { dns: boolean; ip: boolean; email: boolean; uri: boolean } | null {
  const der = fromPem(certPem);
  const inner = findExtension(der, NC_OID);
  if (!inner) return null;
  // NameConstraints ::= SEQUENCE { permittedSubtrees [0] GeneralSubtrees ... }
  const top = children(inner, 0, inner.length)[0];
  if (!top) return null;
  const permitted = children(inner, top.s, top.e).find((n) => n.tag === 0xa0);
  if (!permitted) return null;
  const out = { dns: false, ip: false, email: false, uri: false };
  for (const sub of children(inner, permitted.s, permitted.e)) {
    // Each GeneralSubtree is a SEQUENCE whose first element is the base.
    const base = children(inner, sub.s, sub.e)[0];
    if (!base) continue;
    if (base.tag === 0x82) out.dns = true;
    else if (base.tag === 0x87) out.ip = true;
    else if (base.tag === 0x81) out.email = true;
    else if (base.tag === 0x86) out.uri = true;
  }
  return out;
}

export function certSubjectAltNames(
  certPem: string,
): { dns: string[]; ips: string[] } | null {
  const der = fromPem(certPem);
  const inner = findExtension(der, SAN_OID);
  if (!inner) return null;
  const seq = children(inner, 0, inner.length)[0];
  if (!seq) return null;
  const dns: string[] = [];
  const ips: string[] = [];
  for (const gn of children(inner, seq.s, seq.e)) {
    const body = inner.subarray(gn.s, gn.e);
    if (gn.tag === 0x82) dns.push(new TextDecoder().decode(body));
    else if (gn.tag === 0x87) ips.push(ipToString(body));
  }
  return dns.length || ips.length ? { dns, ips } : null;
}

/** The key identifier that identifies `caCertPem` as an ISSUER.
 *
 *  Prefers the CA's own subjectKeyIdentifier, because AKI is defined as a copy
 *  of it and a root openssl generated has one; falls back to computing it the
 *  same way when a CA has none. */
async function authorityKeyId(caCertPem: string): Promise<Bytes> {
  const der = fromPem(caCertPem);
  const ski = findExtension(der, SKI_OID);
  if (ski) {
    // extnValue is an OCTET STRING wrapping KeyIdentifier, itself an OCTET
    // STRING — so the bytes are one layer further in.
    const inner = children(ski, 0, ski.length)[0];
    if (inner && inner.tag === 0x04) {
      return ski.slice(inner.s, inner.e) as Bytes;
    }
  }
  const cert = children(der, 0, der.length)[0]!;
  const tbs = children(der, cert.s, cert.e)[0]!;
  const f = children(der, tbs.s, tbs.e);
  const spkiNode = f[f[0]?.tag === 0xa0 ? 6 : 5];
  if (!spkiNode) throw new Error("malformed CA certificate: no public key");
  const spki = der.slice(spkiNode.h, spkiNode.e);
  return new Uint8Array(
    await crypto.subtle.digest("SHA-1", publicKeyBits(spki)),
  ) as Bytes;
}

/** authorityKeyIdentifier — which openssl's `x509 -req -CA` adds implicitly,
 *  so a leaf without one is NOT what this replaced. A client uses it to pick
 *  which anchor to try, and `tests/tls.test.ts` pins its presence. */
async function authorityKeyIdentifier(caCertPem: string): Promise<Bytes> {
  return ext("2.5.29.35", false, SEQ(CTXP(0, await authorityKeyId(caCertPem))));
}
