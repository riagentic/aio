// Auto TLS — generates this machine's root and each app's leaf, cached on disk
// Used by aio.run() when --expose is active (zero-config HTTPS)
//
// The certificates are built in `x509.ts`, in Deno, with NO external binary.
// They used to come from four `openssl` invocations, which made automatic
// HTTPS impossible on Windows — it ships no openssl — so `--expose` there died
// with `NotFound: Failed to spawn 'openssl'`. Found by running the suite on a
// real Windows 11 VM. This file keeps the POLICY (what the root may vouch for,
// which addresses a leaf must carry, when a cached cert is stale); `x509.ts`
// is only the encoder.

import { join } from "@std/path";
import {
  certConstrainedNameTypes,
  certSubjectAltNames,
  dnsWithinSubtree,
  generateRoot,
  ipWithinSubtree,
  issueLeaf as mintLeaf,
} from "./x509.ts";
import { homedir, hostname } from "node:os";
import { log } from "../diagnostics/logger-api.ts";
import { appsDirEnv } from "./app-dirs.ts";

export type TlsCert = {
  cert: string;
  key: string;
  certPath: string;
  keyPath: string;
  selfSigned: boolean;
  /** The TRUST ANCHOR a client should pin — the app's own CA when this cert
   *  was issued from one, undefined for a user-supplied cert (whose chain the
   *  client already trusts) or a legacy self-signed leaf.
   *
   *  This is the file `am profile` hands out and `DENO_CERT` should point at.
   *  It matters because it is the thing that DOES NOT CHANGE: the leaf is
   *  re-issued whenever this machine's addresses change, and a client pinned
   *  to the leaf would break every time that happened. */
  caPath?: string;
};

/** All non-loopback IPv4 addresses on this machine, for SAN entries.
 *
 *  A failure here is not cosmetic: the answer decides which addresses the
 *  certificate names, and an empty list produces a loopback-only certificate
 *  that fails the handshake for every LAN client with a hostname mismatch and
 *  nothing anywhere saying why. `Deno.networkInterfaces` throws without
 *  `--allow-sys=networkInterfaces`, which is exactly the misconfiguration that
 *  must not be silent. */
function localIPs(): string[] {
  try {
    return Deno.networkInterfaces()
      .filter((i) => i.family === "IPv4" && !i.address.startsWith("127."))
      .map((i) => i.address);
  } catch (e) {
    log.warn(
      `tls: could not read this machine's network interfaces (${
        e instanceof Error ? e.message : String(e)
      }). The certificate will name loopback only, so clients reaching this ` +
        `app by its LAN address will fail the handshake. Grant ` +
        `--allow-sys=networkInterfaces, or pass --cert/--key.`,
    );
    return [];
  }
}

/** Fallback subject when no appId is supplied — the constant every aio app
 *  used to share (see `certCommonName`). */
export const DEFAULT_CERT_CN = "aio-local";

/** The cert's subject/issuer common name: `aio-<appId>`, never a shared
 *  constant.
 *
 *  Why it matters: a client picks a trust anchor by matching the ISSUER DN, so
 *  when every aio app on earth issued `CN = aio-local`, a stale cert in a trust
 *  store — or the second app in a two-app repo — shadowed the right one and
 *  rustls failed the handshake with `BadSignature`, which names nothing about
 *  the actual cause. A per-app DN makes the collision impossible.
 *
 *  Hostname verification reads subjectAltName, so the CN is identity only —
 *  browsers are unaffected by its value. */
export function certCommonName(appId?: string): string {
  const slug = (appId ?? "").trim().replace(/[^A-Za-z0-9._-]/g, "-").slice(
    0,
    48,
  );
  return slug ? `aio-${slug}` : DEFAULT_CERT_CN;
}

/** Every name and address this machine answers on today, before anything asks
 *  whether the local root is allowed to vouch for them. */
function machineSans(): { dns: string[]; ips: string[] } {
  return { dns: ["localhost"], ips: ["127.0.0.1", "::1", ...localIPs()] };
}

/** Split what this machine answers on into what the root MAY name and what it
 *  may not.
 *
 *  This is not a tidiness filter, it is the difference between a working app
 *  and a dead one. A SAN outside the root's permittedSubtrees does not fail
 *  only for that address: RFC 5280 path validation rejects the WHOLE
 *  certificate, so one address the root cannot speak for takes `localhost`
 *  down with it. Measured — a leaf carrying `localhost, 127.0.0.1,
 *  100.64.7.9`:
 *
 *      error 47 at 0 depth lookup: permitted subtree violation
 *
 *  `localIPs()` hands over every non-loopback IPv4 this machine has, and the
 *  permitted set is loopback plus RFC1918 plus link-local. A Tailscale address
 *  (100.64/10 — the canonical reason to run `--expose` at all), a CGNAT lease,
 *  a cloud VM's public address: each of them silently produced a certificate
 *  no correct client would accept for ANY name, on an app nobody had touched.
 *  Four instruments passed it because all four only ever fed it addresses the
 *  root was already allowed to name. */
export function splitByRootSubtrees(
  s: { dns: string[]; ips: string[] },
): { sans: { dns: string[]; ips: string[] }; dropped: string[] } {
  const okDns = (d: string) =>
    ROOT_PERMITTED_DNS.some((b) => dnsWithinSubtree(d, b));
  const okIp = (i: string) =>
    ROOT_PERMITTED_IPS.some((sub) => ipWithinSubtree(i, sub));
  return {
    sans: { dns: s.dns.filter(okDns), ips: s.ips.filter(okIp) },
    dropped: [
      ...s.dns.filter((d) => !okDns(d)),
      ...s.ips.filter((i) => !okIp(i)),
    ],
  };
}

/** Every name and address this machine can be reached at TODAY *and* the local
 *  root is permitted to name — the SAN set a leaf must carry to be usable.
 *  Loopback first: it is the one entry that is true on every machine forever,
 *  and the rest are a snapshot of a moment.
 *
 *  Pure, and filtered: the warning about what was dropped belongs to the one
 *  caller that issues a certificate, not to every caller that asks a
 *  question. */
export function currentSans(): { dns: string[]; ips: string[] } {
  return splitByRootSubtrees(machineSans()).sans;
}

/** The SANs a cert on disk actually carries, or null when it carries none.
 *
 *  Parsed here rather than shelled out to `openssl x509 -ext subjectAltName`.
 *  That call was the subtlest of the four: it caught a missing openssl and
 *  returned `null`, which the caller reads as "this certificate names no
 *  addresses" — so on Windows every boot declared the cached cert stale for
 *  the wrong reason and then died re-issuing. One answer now means one thing.
 *
 *  The reader returns IPv6 in the fully expanded spelling openssl printed too
 *  (`0:0:0:0:0:0:0:1`), so `normIp`/`sansCover` see exactly what they always
 *  saw and no cached certificate becomes stale on upgrade. */
export function certSans(
  certPath: string,
): Promise<{ dns: string[]; ips: string[] } | null> {
  return Deno.readTextFile(certPath).then(certSubjectAltNames);
}

/** One spelling for one address.
 *
 *  openssl writes `::1` into a certificate and prints it back as
 *  `0:0:0:0:0:0:0:1`. Comparing the two as strings says they differ, which
 *  would mark EVERY certificate stale the moment it was written — re-issuing
 *  on every boot and breaking every client's pin daily. That is a worse
 *  failure than the staleness this comparison exists to catch, and it is
 *  invisible unless the round trip is actually tested.
 *
 *  IPv4 passes through; IPv6 is expanded to its full eight groups so both
 *  spellings land on the same string. */
export function normIp(ip: string): string {
  const v = ip.trim().toLowerCase();
  if (!v.includes(":")) return v;
  const [head, tail] = v.split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const groups = tail === undefined
    ? h
    : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t];
  return groups
    .map((g) => (parseInt(g || "0", 16) || 0).toString(16))
    .join(":");
}

/** True when `cert` still covers every address this machine answers on.
 *
 *  THE staleness question, asked on every boot. A cert is generated once and
 *  then cached forever, so its SAN list is a snapshot of the network this
 *  machine was on that day. Move to another network, take a new DHCP lease,
 *  bring up a VPN — and the cached cert no longer names the address clients
 *  now use, so the handshake fails on an app whose code nobody touched. That
 *  is TLS causing a problem the app would not have had without it, which is
 *  the one thing automatic TLS is not allowed to do. */
export function sansCover(
  have: { dns: string[]; ips: string[] } | null,
  want: { dns: string[]; ips: string[] },
): boolean {
  if (!have) return false;
  const hDns = new Set(have.dns.map((d) => d.toLowerCase()));
  const hIps = new Set(have.ips.map(normIp));
  return want.dns.every((d) => hDns.has(d.toLowerCase())) &&
    want.ips.every((i) => hIps.has(normIp(i)));
}

/** A private key hits the disk owner-only on the FIRST write, never
 *  world-readable-then-fixed.
 *
 *  `writeTextFile` + `chmod` leaves the key at 0644 (umask permitting) for the
 *  whole interval between the two calls — small, but it is the framework's
 *  most sensitive file and the window is free to close. `mode` is applied when
 *  the file is opened, and it also applies on a rewrite, so a key left loose by
 *  an older version is tightened the next time it is reissued. Windows has no
 *  mode bits; the chmod stays as the belt to this pair of braces, and its
 *  failure is reported rather than swallowed. */
async function writePrivateKey(path: string, pem: string): Promise<void> {
  await Deno.writeTextFile(path, pem, { mode: 0o600 });
  if (Deno.build.os === "windows") return;
  try {
    await Deno.chmod(path, 0o600);
  } catch (e) {
    log.warn(
      `tls: could not restrict ${path} to owner-only (${
        e instanceof Error ? e.message : String(e)
      }). Anyone who can read that file can impersonate this app.`,
    );
  }
}

/** Leaf then issuer, in that order — the chain a TLS server presents. ONE
 *  spelling, because a chain assembled two ways is two chains. */
function joinChain(leaf: string, ca: string): string {
  return leaf.trimEnd() + "\n" + ca.trimEnd() + "\n";
}

/** WHERE the machine-wide aio root lives — one per user, shared by every aio
 *  app they run.
 *
 *  It scopes with `AIO_APPS_DIR` for the same reason app data does: a test
 *  suite or a sandbox that relocates the data root must get its OWN root CA,
 *  not reach into the developer's real trust material and not require the
 *  developer to trust a CA a test invented. */
export function aioRootDir(): string {
  const root = appsDirEnv(); // normalized: one data root, one CA
  return root ? join(root, ".aio-ca") : join(homedir(), ".aio", "ca");
}

/** The root's two files. Public cert first — it is the ONLY one that ever
 *  leaves this machine. */
export function aioRootPaths(): { certPath: string; keyPath: string } {
  const dir = aioRootDir();
  return {
    certPath: join(dir, "aio-root.pem"),
    keyPath: join(dir, "aio-root-key.pem"),
  };
}

/** The name constraints the root is issued under — the reason installing it is
 *  a reasonable thing to ask of a person.
 *
 *  An unconstrained CA in a trust store can vouch for ANY site on the internet;
 *  that is what made Superfish and eDellRoot catastrophic rather than merely
 *  untidy. These constraints are marked CRITICAL and cover both name types a
 *  server certificate can carry, so this root can only ever speak for loopback,
 *  `.local`, and the RFC1918 ranges an aio app is actually reachable on. Steal
 *  the key and openssl, rustls, NSS and Go all refuse the forgery — measured,
 *  not hoped (`tests/tls-anchor-stability.test.ts`, `tests/x509.test.ts`).
 *
 *  KNOWN LIMIT, measured with a verifier none of those tests used: RFC 5280
 *  §6.1 starts path validation AFTER the trust anchor and does not process the
 *  anchor's own extensions, so a validator that follows it to the letter never
 *  sees these constraints. Java's `CertPathValidator` is one — it accepts a
 *  `DNS:www.google.com` leaf issued under this root and rejects the same leaf
 *  the moment the constraints sit on an intermediate instead. Closing that
 *  needs a name-constrained issuing intermediate between the root and the
 *  leaves.
 *
 *  Be precise about what the root's extendedKeyUsage does and does not buy
 *  here, because it reads as more than it is. On an anchor-skipping verifier
 *  it bounds a stolen key to TLS SERVER certificates — no S/MIME, no UPN, no
 *  code signing, which is the eDellRoot class. It does NOT stop the case that
 *  matters most: a forged `www.google.com` server certificate needs exactly
 *  `serverAuth`, so the EKU is no obstacle to it at all. For that one the
 *  intermediate is the only fix, and the residual until then is real — an
 *  attacker who can read `~/.aio/ca` can MITM a Java-based client on a machine
 *  that installed this root. That they can read that directory already means
 *  they can read the home directory, which is the larger problem; that is why
 *  the intermediate is scheduled rather than rushed (`todo.md`), not why it is
 *  unnecessary. Every other verifier is now measured from its own OS, each
 *  against a control: openssl, rustls, NSS and Go, macOS Security.framework
 *  14.8.9, and Windows CryptoAPI on Win11 26200 all refuse a forged public
 *  name under this root and all accept the legitimate `localhost` leaf. Java
 *  is the outlier, not the rule. Android/Conscrypt is the one still untested.
 *
 *  macOS differs in the other half: it does NOT apply a trust anchor's
 *  extendedKeyUsage (Windows and openssl do), which is why the root also
 *  carries rfc822Name and URI bases in its permittedSubtrees — see
 *  `nameConstraints` in `x509.ts`. Two locks, because the verifiers that ship
 *  disagree about which one they read.
 *
 *  A name type left unconstrained is UNRESTRICTED, which is why DNS and IP are
 *  both listed rather than just the one that seemed to matter — and why the
 *  root carries an extendedKeyUsage as well, since name constraints say
 *  nothing about what a certificate may be USED for. */
export const ROOT_PERMITTED_DNS = ["localhost", ".local", ".localhost"];
export const ROOT_PERMITTED_IPS: readonly (readonly [string, string])[] = [
  ["127.0.0.0", "255.0.0.0"],
  ["10.0.0.0", "255.0.0.0"],
  ["192.168.0.0", "255.255.0.0"],
  ["172.16.0.0", "255.240.0.0"],
  ["169.254.0.0", "255.255.0.0"],
  ["::1", "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff"],
  ["fc00::", "fe00::"],
  ["fe80::", "ffc0::"],
];

/** The machine-wide aio root: generated once, reused by every aio app, and the
 *  ONE certificate a person ever has to install.
 *
 *  This is the whole answer to "why does my browser complain about my own
 *  app". Trust it once (`am trust`) and every aio app on this machine is
 *  trusted forever — including apps that do not exist yet, and across every
 *  network change, because the root names no address at all.
 *
 *  Its private key is generated HERE and never leaves this machine. A root
 *  shipped inside the framework would give every attacker on the planet the
 *  ability to mint a green padlock for your apps; a root you generated is worth
 *  exactly as much as your own filesystem. */
/** Said once per ROOT, not once per process and not once per app boot.
 *
 *  Per root rather than a single flag because two different roots are two
 *  different facts, and a single flag would mean the second one is never
 *  reported. Several cells in one process share one root, so this still
 *  collapses the four boots of a four-cell app into one line. Bounded by how
 *  many CA directories a process touches, which is one. */
const _saidUnderConstrained = new Set<string>();

/** A root already on disk may be older than the constraints it should carry,
 *  and `loadOrCreateAioRoot` reuses one VERBATIM forever — there is no "the
 *  root looks out of date" path, deliberately, because regenerating it would
 *  break every browser that trusted the old one without asking first.
 *
 *  So the machine cannot fix itself here; it can only refuse to be quiet. A
 *  root written before the rfc822Name/URI bases existed constrains DNS and IP
 *  only, and every other name type is therefore UNRESTRICTED: with that key a
 *  thief mints an S/MIME certificate for any address on any verifier that
 *  skips the anchor's extendedKeyUsage, which macOS does (measured, 14.8.9).
 *
 *  The person is told exactly what to delete and what to re-run, because the
 *  fix costs them a `am trust` and nothing else. */
function warnIfRootUnderConstrained(certPem: string, certPath: string): void {
  if (_saidUnderConstrained.has(certPath)) return;
  let types: ReturnType<typeof certConstrainedNameTypes>;
  try {
    types = certConstrainedNameTypes(certPem);
  } catch (e) {
    // A root this cannot parse is a root whose constraints are UNKNOWN, and
    // unknown is reported, never assumed fine.
    _saidUnderConstrained.add(certPath);
    log.warn(
      `tls: could not read the name constraints on the aio root at ` +
        `${certPath} (${e instanceof Error ? e.message : String(e)}), so ` +
        `what a thief with its key could mint is unknown. Delete it and ` +
        `re-run \`am trust\` to get a root this version wrote.`,
    );
    return;
  }
  if (types === null) {
    _saidUnderConstrained.add(certPath);
    log.warn(
      `tls: ⚠ the aio root at ${certPath} carries NO name constraints. It ` +
        `is installed machine-wide, so with its private key an attacker can ` +
        `mint a trusted certificate for ANY site — this is the Superfish ` +
        `shape. Delete ${certPath} and its key, then re-run \`am trust\`; ` +
        `the replacement can only speak for loopback, .local and private ` +
        `addresses.`,
    );
    return;
  }
  const missing = [
    !types.email ? "email addresses (rfc822Name)" : null,
    !types.uri ? "URIs" : null,
  ].filter((x): x is string => x !== null);
  if (missing.length === 0) return;
  _saidUnderConstrained.add(certPath);
  log.warn(
    `tls: ⚠ the aio root at ${certPath} predates this version and does not ` +
      `constrain ${missing.join(" or ")}. A name type left out of ` +
      `permittedSubtrees is UNRESTRICTED, so with this root's private key a ` +
      `thief can mint certificates for those names — and macOS does not ` +
      `apply a trust anchor's extendedKeyUsage, so that is the only thing ` +
      `stopping them there (measured, macOS 14.8.9). Your apps keep working ` +
      `either way. To close it: delete ${certPath} and its key, then re-run ` +
      `\`am trust\` — every aio app re-issues its leaf automatically, and ` +
      `you re-trust one new root.`,
  );
}

export async function loadOrCreateAioRoot(): Promise<
  { certPath: string; keyPath: string; cert: string; created: boolean }
> {
  const { certPath, keyPath } = aioRootPaths();
  const dir = aioRootDir();
  Deno.mkdirSync(dir, { recursive: true });
  try {
    if (Deno.build.os !== "windows") Deno.chmodSync(dir, 0o700);
  } catch { /* best-effort */ }

  try {
    const cert = await Deno.readTextFile(certPath);
    await Deno.stat(keyPath);
    warnIfRootUnderConstrained(cert, certPath);
    return { certPath, keyPath, cert, created: false };
  } catch { /* generate below */ }

  // Names the SOFTWARE, not one app — this is what the user sees in their
  // browser's certificate manager, and it must be recognisable enough to
  // remove on purpose later.
  const { certPem, keyPem } = await generateRoot({
    commonName: `aio local root (${hostname()})`,
    org: "aio",
    days: 3650,
    permittedDns: ROOT_PERMITTED_DNS,
    permittedIpMasks: ROOT_PERMITTED_IPS,
  });
  await Deno.writeTextFile(certPath, certPem);
  await writePrivateKey(keyPath, keyPem);
  return {
    certPath,
    keyPath,
    cert: await Deno.readTextFile(certPath),
    created: true,
  };
}

/** Issue (or re-issue) the server leaf from the app's CA, carrying whatever
 *  addresses this machine answers on right now. Cheap by design: it is expected
 *  to run again whenever the network changes, and no client notices. */
async function issueLeaf(
  certPath: string,
  keyPath: string,
  caCertPath: string,
  caKeyPath: string,
  appId?: string,
): Promise<void> {
  const { dns, ips } = currentSans();
  const { certPem, keyPem } = await mintLeaf({
    commonName: certCommonName(appId),
    dns,
    ips,
    days: 825,
    // The CA files as they are ON DISK — which on an upgraded machine are the
    // ones openssl wrote. The issuer DN is copied out of that certificate
    // verbatim, so a root from either era signs a chain a client can build.
    caCertPem: await Deno.readTextFile(caCertPath),
    caKeyPem: await Deno.readTextFile(caKeyPath),
  });
  await Deno.writeTextFile(certPath, certPem);
  await writePrivateKey(keyPath, keyPem);
}

/** Load existing cert from dir or generate a new self-signed one.
 *  Cert persists across restarts — deleted cert triggers regeneration.
 *
 *  A cert already on disk is reused VERBATIM, old `CN = aio-local` included:
 *  clients that pinned it keep working, and only newly generated certs carry
 *  the per-app DN. Delete `tls-cert.pem`/`tls-key.pem` to re-issue. */
export async function loadOrCreateCert(
  certDir: string,
  customCert?: string,
  customKey?: string,
  /** App identity woven into the cert's subject/issuer DN (`certCommonName`).
   *  Optional and last so existing callers keep compiling; omitting it keeps
   *  the legacy shared `aio-local` name. */
  appId?: string,
): Promise<TlsCert> {
  // User-provided cert takes precedence
  if (customCert && customKey) {
    return {
      cert: await Deno.readTextFile(customCert),
      key: await Deno.readTextFile(customKey),
      certPath: customCert,
      keyPath: customKey,
      selfSigned: false,
    };
  }

  Deno.mkdirSync(certDir, { recursive: true });
  try {
    // The directory holding a private key is owner-only, independently of the
    // parent it happens to sit under.
    if (Deno.build.os !== "windows") Deno.chmodSync(certDir, 0o700);
  } catch { /* best-effort */ }
  const certPath = join(certDir, "tls-cert.pem");
  const keyPath = join(certDir, "tls-key.pem");
  // THE anchor: one root for every aio app this user runs, not one per app.
  // Per-app roots would have made "trust this app" a chore repeated forever —
  // a fresh dialog for every app and every new checkout — which is the exact
  // friction this design exists to remove. One root, one install, every app.
  const { certPath: caCertPath, keyPath: caKeyPath } = aioRootPaths();

  const { sans: want, dropped } = splitByRootSubtrees(machineSans());
  if (dropped.length) {
    // LOUD, once per boot, at the only place that decides what a certificate
    // will say. Silently dropping the address the user is actually dialling is
    // the same failure as silently poisoning the certificate — this names what
    // was left out, why, and the one thing that fixes it.
    log.warn(
      `tls: this machine answers on ${dropped.join(", ")}, which the local ` +
        `aio root is NOT permitted to vouch for (it may only name localhost, ` +
        `.local and private addresses — that restriction is what makes ` +
        `installing it safe). Those addresses are left out of the ` +
        `certificate: including even one of them would make the certificate ` +
        `invalid for EVERY name in it, localhost included. To serve HTTPS on ` +
        `${dropped[0]}, pass a certificate for it with --cert/--key.`,
    );
  }
  const haveCA = await Deno.stat(caCertPath).then(() => true).catch(() =>
    false
  );

  // ── A cert from a previous boot ────────────────────────────────────────
  //
  // Reused ONLY while it still covers the addresses this machine answers on.
  // The old rule was "reuse verbatim, always", which is correct right up until
  // the machine changes network — and then it is a handshake failure with no
  // cause anyone can see, on an app nobody edited.
  let existing: string | null = null;
  try {
    existing = await Deno.readTextFile(certPath);
  } catch { /* none yet */ }

  if (existing !== null) {
    const fresh = sansCover(await certSans(certPath), want);
    if (fresh) {
      const key = await Deno.readTextFile(keyPath);
      // The file on disk IS the chain, so this is byte-identical to what a
      // first boot serves. It used to return the bare leaf while a freshly
      // issued cert was served as leaf+root — a difference no single-boot test
      // can see, and one that changes what a client must already hold.
      return {
        cert: existing,
        key,
        certPath,
        keyPath,
        selfSigned: true,
        ...(haveCA ? { caPath: caCertPath } : {}),
      };
    }
    // Stale. A LEGACY leaf (no CA beside it) cannot be refreshed without
    // changing the anchor every pinned client holds, so say so rather than
    // silently invalidating their pin: the app is already unreachable at its
    // new address, and the fix is one line.
    if (!haveCA) {
      log.warn(
        `tls: the cached certificate does not cover this machine's current ` +
          `addresses (${want.ips.join(", ")}) — it was issued on a different ` +
          `network. Re-issuing under this machine's aio root. Clients that ` +
          `pinned the OLD certificate must re-pair once (they will pin ` +
          `${caCertPath}, which does not change again — not for a new ` +
          `network, not for a new app).`,
      );
    }
  }

  // ── Issue ──────────────────────────────────────────────────────────────
  const root = await loadOrCreateAioRoot();
  if (root.created) {
    log.info(
      `tls: created this machine's aio root at ${root.certPath}. Run ` +
        `\`am trust\` once and every aio app on this machine is trusted by ` +
        `your browser — including apps you have not written yet.`,
    );
  }
  await issueLeaf(certPath, keyPath, caCertPath, caKeyPath, appId);

  // The chain is written to `tls-cert.pem` itself, not assembled in memory.
  //
  // That file is what every client already treats as "the certificate to
  // trust" — `am profile` exports it, `DENO_CERT` points at it, the aio client
  // takes it as `--cert=`. When the leaf was self-signed it worked as its own
  // trust anchor; now that it is issued by a root, a client pinning the leaf
  // alone has an anchor it cannot build a chain to, and the handshake simply
  // hangs. Putting the root in the same file keeps every one of those callers
  // correct without knowing anything changed: the leaf proves the address, the
  // root is the anchor, and one path still means "trust this".
  //
  // `certSans` stays honest — the reader takes the FIRST certificate in a
  // file, which is the leaf.
  const leaf = await Deno.readTextFile(certPath);
  const ca = await Deno.readTextFile(caCertPath);
  const chain = joinChain(leaf, ca);
  await Deno.writeTextFile(certPath, chain);

  return {
    cert: chain,
    key: await Deno.readTextFile(keyPath),
    certPath,
    keyPath,
    caPath: caCertPath,
    selfSigned: true,
  };
}
