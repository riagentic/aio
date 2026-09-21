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
  certSubjectAltNames,
  generateRoot,
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

/** Returns all non-loopback IPv4 addresses on this machine for SAN entries */
function localIPs(): string[] {
  try {
    return Deno.networkInterfaces()
      .filter((i) => i.family === "IPv4" && !i.address.startsWith("127."))
      .map((i) => i.address);
  } catch {
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

/** Every name and address this machine can be reached at TODAY — the SAN set a
 *  leaf must carry to be usable. Loopback first: it is the one entry that is
 *  true on every machine forever, and the rest are a snapshot of a moment. */
export function currentSans(): { dns: string[]; ips: string[] } {
  return { dns: ["localhost"], ips: ["127.0.0.1", "::1", ...localIPs()] };
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
 *  the key and you still cannot forge a public website with it — that is a
 *  verified property, not a hope (`tests/tls-anchor-stability.test.ts`).
 *
 *  A name type left unconstrained is UNRESTRICTED, which is why DNS and IP are
 *  both listed rather than just the one that seemed to matter. */
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
  await Deno.writeTextFile(keyPath, keyPem);
  try {
    if (Deno.build.os !== "windows") await Deno.chmod(keyPath, 0o600);
  } catch { /* best-effort */ }
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
  await Deno.writeTextFile(keyPath, keyPem);
  try {
    if (Deno.build.os !== "windows") await Deno.chmod(keyPath, 0o600);
  } catch { /* best-effort */ }
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

  const want = currentSans();
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
