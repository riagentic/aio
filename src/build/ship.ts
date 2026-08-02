// ship.ts — `aio ship` core: a verifiable release manifest for a
// compiled binary. Ties together the reproducible artifact (SHA-256), the
// least-privilege capability manifest (what --allow-* it actually needs, never
// -A), and an optional Ed25519 signature over the digest. The auto-update
// CHANNEL (serving + fetching + swapping) is separate infra; this is the
// signable, verifiable artifact it would distribute.
import { join } from "@std/path";
import {
  type Capabilities,
  permissionFlags,
  scanCapabilities,
} from "./capabilities.ts";

/** What `ship` publishes next to a binary: identity, integrity (hash +
 *  signature), the capabilities scanned from source, and the least-privilege
 *  flags to run it with. */
export type ShipManifest = {
  name: string;
  version: string;
  /** SHA-256 of the binary, hex. */
  sha256: string;
  size: number;
  /** Capabilities the source declares → the least-privilege run flags. */
  capabilities: Capabilities;
  runFlags: string[];
  /** Ed25519 signature over the SHA-256 digest, base64 (when signed). */
  signature?: string;
  /** The verifying public key (JWK), so a consumer can check the signature. */
  publicKey?: JsonWebKey;
};

const ED = { name: "Ed25519" } as const;

/** Lowercase hex SHA-256 of bytes. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Generate an Ed25519 signing keypair as exportable JWKs. Keep the private JWK
 *  secret (a key file / secret manager); publish only the public JWK. */
export async function generateSigningKey(): Promise<
  { publicKey: JsonWebKey; privateKey: JsonWebKey }
> {
  const kp = await crypto.subtle.generateKey(ED, true, [
    "sign",
    "verify",
  ]) as CryptoKeyPair;
  return {
    publicKey: await crypto.subtle.exportKey("jwk", kp.publicKey),
    privateKey: await crypto.subtle.exportKey("jwk", kp.privateKey),
  };
}

function b64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}
function unb64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

/** Sign a digest (hex) with a private JWK → base64 signature. */
async function signDigest(hex: string, jwk: JsonWebKey): Promise<string> {
  const key = await crypto.subtle.importKey("jwk", jwk, ED, false, ["sign"]);
  const sig = await crypto.subtle.sign(
    ED,
    key,
    new TextEncoder().encode(hex) as BufferSource,
  );
  return b64(new Uint8Array(sig));
}

/** Verify a base64 signature over a digest (hex) with a public JWK. */
async function verifyDigest(
  hex: string,
  sigB64: string,
  jwk: JsonWebKey,
): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey("jwk", jwk, ED, false, [
      "verify",
    ]);
    return await crypto.subtle.verify(
      ED,
      key,
      unb64(sigB64) as BufferSource,
      new TextEncoder().encode(hex) as BufferSource,
    );
  } catch {
    return false;
  }
}

/** Build a ship manifest for a compiled binary. Signs the digest when a private
 *  key JWK is supplied (with its public JWK for the consumer). */
export async function buildShipManifest(opts: {
  name: string;
  version: string;
  binary: Uint8Array;
  sources: { content: string }[];
  sign?: { privateKey: JsonWebKey; publicKey: JsonWebKey };
}): Promise<ShipManifest> {
  const sha256 = await sha256Hex(opts.binary);
  const capabilities = scanCapabilities(opts.sources);
  const manifest: ShipManifest = {
    name: opts.name,
    version: opts.version,
    sha256,
    size: opts.binary.length,
    capabilities,
    runFlags: permissionFlags(capabilities),
  };
  if (opts.sign) {
    manifest.signature = await signDigest(sha256, opts.sign.privateKey);
    manifest.publicKey = opts.sign.publicKey;
  }
  return manifest;
}

/** Verify a binary against a ship manifest: the SHA-256 matches AND (if signed)
 *  the signature over the digest verifies under the manifest's public key. */
export async function verifyShipManifest(
  binary: Uint8Array,
  manifest: ShipManifest,
): Promise<{ ok: boolean; reason: string }> {
  const sha256 = await sha256Hex(binary);
  if (sha256 !== manifest.sha256) {
    return {
      ok: false,
      reason: "sha256 mismatch — binary does not match manifest",
    };
  }
  if (manifest.signature) {
    if (!manifest.publicKey) {
      return {
        ok: false,
        reason: "signed manifest has no public key to verify against",
      };
    }
    const good = await verifyDigest(
      sha256,
      manifest.signature,
      manifest.publicKey,
    );
    if (!good) return { ok: false, reason: "signature invalid" };
    return { ok: true, reason: "sha256 + signature verified" };
  }
  return { ok: true, reason: "sha256 verified (unsigned)" };
}

// ── Orchestration: the one-command `aio ship` (batteries-included) ───────────

/** Collect .ts/.tsx source contents under a dir (for capability scanning). */
async function collectSources(
  dir: string,
): Promise<{ content: string }[]> {
  const out: { content: string }[] = [];
  const walk = async (d: string): Promise<void> => {
    for await (const e of Deno.readDir(d)) {
      // `join`, not string concatenation: everything else in the codebase
      // builds paths with @std/path, and hardcoding "/" produced mixed
      // separators on Windows (`src\sub/file.ts`) that only worked by
      // accident of Deno's normalisation.
      const p = join(d, e.name);
      if (e.isDirectory) {
        if (e.name === "node_modules" || e.name.startsWith(".")) continue;
        await walk(p);
      } else if (/\.tsx?$/.test(e.name) && !e.name.endsWith(".test.ts")) {
        out.push({ content: await Deno.readTextFile(p) });
      }
    }
  };
  try {
    await walk(dir);
  } catch { /* missing dir → no sources → empty caps */ }
  return out;
}

/** `aio ship`: read a compiled binary, scan the source for its least-privilege
 *  capabilities, optionally sign the digest, and write a `ship.json` manifest
 *  next to it — one command from a built binary to a verifiable, signed release
 *  artifact + the exact `--allow-*` run line (never -A). Returns the manifest. */
export async function shipApp(opts: {
  binaryPath: string;
  sourceDir?: string;
  name?: string;
  version?: string;
  /** Path to a JSON `{ privateKey, publicKey }` (JWKs) — generateSigningKey(). */
  keyPath?: string;
  /** Manifest output path (default: `<binaryPath>.ship.json`). */
  out?: string;
}): Promise<ShipManifest> {
  const binary = await Deno.readFile(opts.binaryPath);
  const sources = await collectSources(opts.sourceDir ?? "src");
  let sign: { privateKey: JsonWebKey; publicKey: JsonWebKey } | undefined;
  if (opts.keyPath) {
    sign = JSON.parse(await Deno.readTextFile(opts.keyPath)) as {
      privateKey: JsonWebKey;
      publicKey: JsonWebKey;
    };
  }
  const manifest = await buildShipManifest({
    name: opts.name ?? opts.binaryPath.replace(/.*\//, ""),
    version: opts.version ?? "0.0.0",
    binary,
    sources,
    sign,
  });
  const outPath = opts.out ?? opts.binaryPath + ".ship.json";
  await Deno.writeTextFile(outPath, JSON.stringify(manifest, null, 2));
  return manifest;
}

if (import.meta.main) {
  const args = Deno.args;
  const bin = args.find((a) => !a.startsWith("--"));
  if (bin === "keygen") {
    // `ship keygen` → print a fresh signing keypair (redirect to a key file).
    console.log(JSON.stringify(await generateSigningKey(), null, 2));
    Deno.exit(0);
  }
  if (!bin) {
    console.error(
      "usage: ship <binary> [--src=DIR] [--name=N] [--version=V] [--key=key.json] [--out=ship.json]\n" +
        "       ship keygen   # print a fresh Ed25519 signing keypair",
    );
    Deno.exit(1);
  }
  const flag = (k: string) =>
    args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
  const m = await shipApp({
    binaryPath: bin,
    sourceDir: flag("src"),
    name: flag("name"),
    version: flag("version"),
    keyPath: flag("key"),
    out: flag("out"),
  });
  console.log(
    `ship: ${m.name} ${m.version}\n  sha256 ${m.sha256}\n  run:   ${
      m.runFlags.length ? m.runFlags.join(" ") : "(no perms)"
    }\n  ${m.signature ? "signed (Ed25519)" : "unsigned"}`,
  );
}
