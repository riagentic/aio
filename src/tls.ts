// Auto TLS — generates a self-signed cert via openssl, cached on disk
// Used by aio.run() when --expose is active (zero-config HTTPS)

import { join } from '@std/path'

export type TlsCert = { cert: string; key: string; certPath: string; keyPath: string; selfSigned: boolean }

/** Returns all non-loopback IPv4 addresses on this machine for SAN entries */
function localIPs(): string[] {
  try {
    return Deno.networkInterfaces()
      .filter(i => i.family === 'IPv4' && !i.address.startsWith('127.'))
      .map(i => i.address)
  } catch { return [] }
}

/** Generate self-signed ECDSA P-256 cert via openssl (available on Linux/macOS always, Windows via Git Bash) */
async function generateWithOpenssl(certPath: string, keyPath: string): Promise<void> {
  const ips = localIPs()
  const ipLines = ['127.0.0.1', '::1', ...ips].map((ip, i) => `IP.${i + 1} = ${ip}`).join('\n')
  const tmpCfg = await Deno.makeTempFile({ suffix: '.cnf' })
  try {
    await Deno.writeTextFile(tmpCfg, [
      '[req]',
      'distinguished_name = dn',
      'x509_extensions = v3',
      'prompt = no',
      '[dn]',
      'CN = aio-local',
      '[v3]',
      'keyUsage = critical,digitalSignature,keyEncipherment',
      'extendedKeyUsage = serverAuth',
      'subjectAltName = @sans',
      '[sans]',
      'DNS.1 = localhost',
      ipLines,
    ].join('\n'))
    const r = await new Deno.Command('openssl', {
      args: [
        'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256',
        '-keyout', keyPath, '-out', certPath,
        '-days', '3650', '-nodes', '-config', tmpCfg,
      ],
      stdout: 'null', stderr: 'piped',
    }).output()
    if (!r.success) {
      throw new Error(`openssl failed: ${new TextDecoder().decode(r.stderr).trim()}`)
    }
  } finally {
    await Deno.remove(tmpCfg).catch(() => {})
  }
}

/** Load existing cert from dir or generate a new self-signed one.
 *  Cert persists across restarts — deleted cert triggers regeneration. */
export async function loadOrCreateCert(
  certDir: string,
  customCert?: string,
  customKey?: string,
): Promise<TlsCert> {
  // User-provided cert takes precedence
  if (customCert && customKey) {
    return {
      cert: await Deno.readTextFile(customCert),
      key: await Deno.readTextFile(customKey),
      certPath: customCert,
      keyPath: customKey,
      selfSigned: false,
    }
  }

  Deno.mkdirSync(certDir, { recursive: true })
  const certPath = join(certDir, 'tls-cert.pem')
  const keyPath  = join(certDir, 'tls-key.pem')

  // Load existing cert if present
  try {
    const cert = await Deno.readTextFile(certPath)
    const key  = await Deno.readTextFile(keyPath)
    return { cert, key, certPath, keyPath, selfSigned: true }
  } catch { /* generate */ }

  await generateWithOpenssl(certPath, keyPath)
  const cert = await Deno.readTextFile(certPath)
  const key  = await Deno.readTextFile(keyPath)
  return { cert, key, certPath, keyPath, selfSigned: true }
}
