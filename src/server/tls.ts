// Auto TLS — generates a self-signed cert via openssl, cached on disk
// Used by aio.run() when --expose is active (zero-config HTTPS)

import { join } from "@std/path";

export type TlsCert = {
  cert: string;
  key: string;
  certPath: string;
  keyPath: string;
  selfSigned: boolean;
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

/** Generate self-signed ECDSA P-256 cert via openssl (available on Linux/macOS always, Windows via Git Bash) */
async function generateWithOpenssl(
  certPath: string,
  keyPath: string,
  appId?: string,
): Promise<void> {
  const ips = localIPs();
  const ipLines = ["127.0.0.1", "::1", ...ips].map((ip, i) =>
    `IP.${i + 1} = ${ip}`
  ).join("\n");
  const tmpCfg = await Deno.makeTempFile({ suffix: ".cnf" });
  try {
    await Deno.writeTextFile(
      tmpCfg,
      [
        "[req]",
        "distinguished_name = dn",
        "x509_extensions = v3",
        "prompt = no",
        "[dn]",
        `CN = ${certCommonName(appId)}`,
        "[v3]",
        // CA:FALSE is load-bearing, not boilerplate: rustls REJECTS a
        // self-signed leaf carrying CA:TRUE as `CaUsedAsEndEntity`. A
        // CA:FALSE self-signed cert works correctly when pinned as its own
        // trust anchor, which is exactly how `am profile` hands it out.
        "basicConstraints = critical,CA:FALSE",
        "keyUsage = critical,digitalSignature,keyEncipherment",
        "extendedKeyUsage = serverAuth",
        "subjectKeyIdentifier = hash",
        // Pins WHICH key signed this cert, so a client with several aio certs
        // in its store cannot pair this cert with another app's anchor.
        "authorityKeyIdentifier = keyid:always",
        "subjectAltName = @sans",
        "[sans]",
        "DNS.1 = localhost",
        ipLines,
      ].join("\n"),
    );
    const r = await new Deno.Command("openssl", {
      args: [
        "req",
        "-x509",
        "-newkey",
        "ec",
        "-pkeyopt",
        "ec_paramgen_curve:P-256",
        "-keyout",
        keyPath,
        "-out",
        certPath,
        "-days",
        "3650",
        "-nodes",
        "-config",
        tmpCfg,
      ],
      stdout: "null",
      stderr: "piped",
    }).output();
    if (!r.success) {
      throw new Error(
        `openssl failed: ${new TextDecoder().decode(r.stderr).trim()}`,
      );
    }
  } finally {
    await Deno.remove(tmpCfg).catch(() => {});
  }
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
  const certPath = join(certDir, "tls-cert.pem");
  const keyPath = join(certDir, "tls-key.pem");

  // Load existing cert if present
  try {
    const cert = await Deno.readTextFile(certPath);
    const key = await Deno.readTextFile(keyPath);
    return { cert, key, certPath, keyPath, selfSigned: true };
  } catch { /* generate */ }

  await generateWithOpenssl(certPath, keyPath, appId);
  const cert = await Deno.readTextFile(certPath);
  const key = await Deno.readTextFile(keyPath);
  return { cert, key, certPath, keyPath, selfSigned: true };
}
