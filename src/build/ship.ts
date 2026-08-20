// ship.ts — `aio ship` core: a verifiable release manifest for a
// compiled binary. Ties together the reproducible artifact (SHA-256), the
// least-privilege capability manifest (what --allow-* it actually needs, never
// -A), and an optional Ed25519 signature over the digest. The auto-update
// CHANNEL (serving + fetching + swapping) is separate infra; this is the
// signable, verifiable artifact it would distribute.
import { readDenoJson } from "../server/deno-json.ts";
import { join } from "@std/path";
import { resolveAppDir, resolveEntry } from "./build-config.ts";
import {
  type Capabilities,
  permissionFlags,
  scanCapabilities,
} from "./capabilities.ts";

/** How an update client installs this artifact. The swap differs per target;
 *  everything before it (fetch → verify → stage) does not. `"source"` is a
 *  running-from-`deno task dev` tree — detect works, apply refuses. */
export type UpdateTarget =
  | "binary"
  | "appimage"
  | "electron-appimage"
  | "electron-zip"
  | "android"
  | "source";

/** What `ship` publishes next to a binary: identity, integrity (hash +
 *  signature), the capabilities scanned from source, the least-privilege flags
 *  to run it with, and the release coordinates an update client refuses on. */
export type ShipManifest = {
  /** Manifest format. `2` = channel-bound, signature covers the whole core.
   *  Version 1 (digest-only signature) is REFUSED — see verifyShipManifest. */
  manifestVersion: 2;
  name: string;
  version: string;
  /** SHA-256 of the binary, hex. */
  sha256: string;
  size: number;
  /** Capabilities the source declares → the least-privilege run flags. */
  capabilities: Capabilities;
  runFlags: string[];
  /** Release channel this artifact belongs to ("dev" | "test" | "prod" | …).
   *  Signed, and matched against what the client asked for: the realistic
   *  failure is a test build published to the prod path, and only a signed
   *  channel catches it. */
  channel: string;
  /** How to install it. */
  target: UpdateTarget;
  /** Who it runs on — a client refuses a manifest for another platform. */
  platform: { os: string; arch: string };
  /** Where the artifact is: absolute, or relative to the manifest's own URL. */
  url?: string;
  /** ISO timestamp of the release. */
  releasedAt: string;
  /** Shown in the update prompt — one line, or a link to the changelog. */
  notes?: string;
  /** Refuse to update FROM anything older than this (a forced-step release). */
  minFrom?: string;
  /** What this build can do with the data already on disk. An update is only
   *  ever OFFERED when this says the user's data survives it. */
  data?: DataContract;
  /** Ed25519 signature over `manifestCore()`, base64 (when signed). */
  signature?: string;
  /** The verifying public key (JWK), so a consumer can check the signature. */
  publicKey?: JsonWebKey;
};

/** One cell's persisted-schema promise in a published build. */
export type CellContract = {
  /** The schema version this build writes. */
  version: number;
  /** The OLDEST persisted version this build can migrate FROM.
   *
   *  Derived from what the cell actually declares, never guessed:
   *  - `onMigrate` present ⇒ `1` — that hook's existing contract is "called
   *    when the persisted version is older", so it claims every older version.
   *  - `version` bumped with NO `onMigrate` ⇒ equal to `version` — this build
   *    can only read data it wrote itself, so an older store is unreadable.
   *  - an explicit `migratesFrom` narrows the claim (support for ancient
   *    shapes was deliberately dropped).
   *
   *  The middle case is the one that matters: bumping a version and forgetting
   *  the migration stops being a data-loss incident at the user's next boot and
   *  becomes an update that is simply never offered to them. */
  migratesFrom: number;
};

/** The data-compatibility half of a release. Inside the signature, because a
 *  forged "yes, I can migrate your data" is a data-destruction primitive. */
export type DataContract = {
  /** aio's own persistence schema version — a store written by a newer
   *  persistence layer is not readable by an older one. */
  schema: number;
  /** cellId → what this build promises about that cell's persisted state. */
  cells: Record<string, CellContract>;
};

/** Canonical form of a data contract: cell ids sorted, so two builds that
 *  promise the same thing serialize — and therefore sign — identically. */
function canonicalData(d: DataContract | undefined): string {
  if (!d) return "";
  const cells = Object.entries(d.cells)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([id, c]) => [id, c.version, c.migratesFrom]);
  return JSON.stringify({ schema: d.schema, cells });
}

/** The canonical, deterministic serialization the signature covers.
 *
 *  Signing only the binary's digest (what v1 did) authenticated the BYTES but
 *  none of the coordinates: an attacker — or, far more likely, a careless
 *  publish — could move a genuine, correctly-signed `test` build onto the
 *  `prod` path, and every client would verify it and install it. Everything a
 *  client is allowed to refuse on must therefore be inside the signature.
 *
 *  Key order is the literal's insertion order, which `JSON.stringify`
 *  preserves — so this is stable across runtimes without a sort. */
export function manifestCore(m: ShipManifest): string {
  return JSON.stringify({
    v: m.manifestVersion,
    name: m.name,
    version: m.version,
    sha256: m.sha256,
    size: m.size,
    channel: m.channel,
    target: m.target,
    os: m.platform.os,
    arch: m.platform.arch,
    url: m.url ?? "",
    minFrom: m.minFrom ?? "",
    data: canonicalData(m.data),
  });
}

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

/** Sign a canonical string with a private JWK → base64 signature. */
async function signText(text: string, jwk: JsonWebKey): Promise<string> {
  const key = await crypto.subtle.importKey("jwk", jwk, ED, false, ["sign"]);
  const sig = await crypto.subtle.sign(
    ED,
    key,
    new TextEncoder().encode(text) as BufferSource,
  );
  return b64(new Uint8Array(sig));
}

/** Verify a base64 signature over a canonical string with a public JWK. */
async function verifyText(
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
  channel?: string;
  target?: UpdateTarget;
  platform?: { os: string; arch: string };
  url?: string;
  releasedAt?: string;
  notes?: string;
  minFrom?: string;
  data?: DataContract;
  /** The app configures `updates` — force the `net` capability on.
   *  A purely local app scans to `net: false`, and its least-privilege binary
   *  then CANNOT reach its own release host: the check fails in production
   *  only, silently, at the moment a user most needs the update. */
  updates?: boolean;
}): Promise<ShipManifest> {
  const sha256 = await sha256Hex(opts.binary);
  const scanned = scanCapabilities(opts.sources);
  const capabilities = opts.updates ? { ...scanned, net: true } : scanned;
  const manifest: ShipManifest = {
    manifestVersion: 2,
    name: opts.name,
    version: opts.version,
    sha256,
    size: opts.binary.length,
    capabilities,
    runFlags: permissionFlags(capabilities),
    channel: opts.channel ?? "prod",
    target: opts.target ?? "binary",
    platform: opts.platform ??
      { os: Deno.build.os, arch: Deno.build.arch },
    releasedAt: opts.releasedAt ?? new Date().toISOString(),
  };
  if (opts.url) manifest.url = opts.url;
  if (opts.notes) manifest.notes = opts.notes;
  if (opts.minFrom) manifest.minFrom = opts.minFrom;
  if (opts.data) manifest.data = opts.data;
  if (opts.sign) {
    manifest.signature = await signText(
      manifestCore(manifest),
      opts.sign.privateKey,
    );
    manifest.publicKey = opts.sign.publicKey;
  }
  return manifest;
}

/** What a client demands of a manifest before it will install it. Every field
 *  is inside the signature, so none of these can be edited in transit. */
export type ShipExpectations = {
  /** The channel the client asked for. A mismatch aborts. */
  channel?: string;
  /** The install strategy the client can actually perform. */
  target?: UpdateTarget;
  /** The platform the client runs on. */
  platform?: { os: string; arch: string };
  /** The TRUSTED public key (pinned, or TOFU'd on first install). Without it a
   *  signature proves nothing: anyone can sign their own manifest and ship the
   *  matching key beside it. */
  key?: JsonWebKey;
  /** Allow an unsigned manifest (a private LAN build). Loud by contract. */
  allowUnsigned?: boolean;
};

/** Two JWKs describe the same Ed25519 public key. Compares the curve point
 *  (`x`), not the whole object — JWKs differ in optional metadata (`key_ops`,
 *  `ext`, `alg`) while naming the same key, and a whole-object compare would
 *  reject a legitimate re-export. */
function sameKey(a: JsonWebKey, b: JsonWebKey): boolean {
  return !!a.x && a.x === b.x && a.kty === b.kty && a.crv === b.crv;
}

/** Verify everything about a manifest EXCEPT the bytes it describes: format,
 *  release coordinates, and the signature over the core under a trusted key.
 *
 *  Split out because a client checks these the moment it fetches a manifest —
 *  long before it has spent a download finding out whether the release is even
 *  meant for it. `verifyShipManifest` is this plus the digest. */
export async function verifyManifestClaims(
  manifest: ShipManifest,
  expect: ShipExpectations = {},
): Promise<{ ok: boolean; reason: string }> {
  // A v1 manifest signed only the binary digest, leaving channel/target/
  // platform unauthenticated. Accepting one would hand back exactly the
  // guarantee this format exists to provide, so it is refused rather than
  // downgraded to.
  if (manifest.manifestVersion !== 2) {
    return {
      ok: false,
      reason:
        `manifest format ${manifest.manifestVersion ?? 1} predates channel ` +
        `binding — its signature does not cover the channel, target or ` +
        `platform. Re-publish with \`aio ship\`.`,
    };
  }
  if (expect.channel && manifest.channel !== expect.channel) {
    return {
      ok: false,
      reason:
        `channel mismatch — asked for "${expect.channel}", manifest is for ` +
        `"${manifest.channel}". A build was published to the wrong path.`,
    };
  }
  if (expect.target && manifest.target !== expect.target) {
    return {
      ok: false,
      reason:
        `target mismatch — this install is "${expect.target}", manifest is ` +
        `for "${manifest.target}"`,
    };
  }
  if (
    expect.platform &&
    (manifest.platform.os !== expect.platform.os ||
      manifest.platform.arch !== expect.platform.arch)
  ) {
    return {
      ok: false,
      reason:
        `platform mismatch — running ${expect.platform.os}/${expect.platform.arch}, ` +
        `manifest is for ${manifest.platform.os}/${manifest.platform.arch}`,
    };
  }
  if (!manifest.signature) {
    if (expect.key) {
      return {
        ok: false,
        reason: "manifest is unsigned but a trusted key is pinned — refusing " +
          "(an attacker can always remove a signature)",
      };
    }
    if (!expect.allowUnsigned) {
      return {
        ok: false,
        reason:
          "manifest is unsigned — pass --allow-unsigned to install it anyway",
      };
    }
    return {
      ok: true,
      reason: "claims accepted (UNSIGNED — not authenticated)",
    };
  }
  if (!manifest.publicKey) {
    return {
      ok: false,
      reason: "signed manifest has no public key to verify against",
    };
  }
  // The key must be one we already trust. Verifying against the key the
  // manifest carries proves only that the manifest is internally consistent —
  // which any forger can arrange.
  if (expect.key && !sameKey(manifest.publicKey, expect.key)) {
    return {
      ok: false,
      reason:
        "signed by an untrusted key — does not match the key pinned for this app",
    };
  }
  const good = await verifyText(
    manifestCore(manifest),
    manifest.signature,
    manifest.publicKey,
  );
  if (!good) return { ok: false, reason: "signature invalid" };
  return {
    ok: true,
    reason: expect.key
      ? "signature verified against the pinned key"
      : "signature verified (key trusted on first use)",
  };
}

/** Verify a binary against a ship manifest: the SHA-256 matches, the release
 *  coordinates are the ones the client asked for, and the signature over the
 *  manifest core verifies under a TRUSTED key. */
export async function verifyShipManifest(
  binary: Uint8Array,
  manifest: ShipManifest,
  expect: ShipExpectations = {},
): Promise<{ ok: boolean; reason: string }> {
  const claims = await verifyManifestClaims(manifest, expect);
  if (!claims.ok) return claims;
  const sha256 = await sha256Hex(binary);
  if (sha256 !== manifest.sha256) {
    return {
      ok: false,
      reason: "sha256 mismatch — binary does not match manifest",
    };
  }
  return { ok: true, reason: `sha256 + ${claims.reason}` };
}

// ── Orchestration: the one-command `aio ship` (batteries-included) ───────────

/** Collect .ts/.tsx source contents under a dir (for capability scanning).
 *  A missing/unreadable dir THROWS: an unreadable source tree means the
 *  capability claim was never measured, and a manifest is a claim. */
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
  } catch (e) {
    throw new Error(
      `[ship] cannot read the source tree at ${dir}: ${e}. ` +
        `A ship manifest states which permissions the binary needs — it is ` +
        `never signed off sources nobody could read. Pass --src=DIR.`,
    );
  }
  return out;
}

/** Infer the install strategy from the artifact itself. The extension decides
 *  the mechanism (rename an AppImage, unpack a zip); deno.json's build target
 *  only distinguishes an Electron AppImage from a plain one, and they differ in
 *  what gets relaunched. */
function inferTarget(
  fileName: string,
  buildCfg: Record<string, unknown>,
): UpdateTarget {
  const electron = buildCfg.target === "electron" ||
    (Array.isArray(buildCfg.targets) && buildCfg.targets.includes("electron"));
  if (/\.AppImage$/i.test(fileName)) {
    return electron ? "electron-appimage" : "appimage";
  }
  if (/\.zip$/i.test(fileName)) return "electron-zip";
  if (/\.apk$/i.test(fileName)) return "android";
  return "binary";
}

/** Ask the binary what it promises about persisted data.
 *
 *  Runs `<binary> --aio-data-contract`, which prints the contract derived from
 *  the cells the build actually contains. Measured rather than guessed: a
 *  source scan could not tell an `onMigrate` that exists from one that was
 *  deleted last week, and this manifest is what clients trust with their data.
 *
 *  A failure is loud and non-fatal. Publishing without a contract is allowed —
 *  some binaries cannot be executed on the machine that ships them — but it has
 *  a real consequence, so it is stated rather than logged at debug. */
async function probeDataContract(
  binaryPath: string,
): Promise<DataContract | undefined> {
  try {
    const cmd = new Deno.Command(binaryPath, {
      args: ["--aio-data-contract"],
      stdout: "piped",
      stderr: "null",
    });
    const out = await cmd.output();
    if (!out.success) throw new Error(`exit ${out.code}`);
    const parsed = JSON.parse(new TextDecoder().decode(out.stdout));
    if (!parsed || typeof parsed !== "object" || !("cells" in parsed)) {
      throw new Error("no contract in output");
    }
    return parsed as DataContract;
  } catch (e) {
    console.warn(
      `[ship] \u26a0 could not read the data contract from ${binaryPath} ` +
        `(${e instanceof Error ? e.message : e}).\n` +
        `       The manifest will not say what this build does with existing ` +
        `data, and every install that HAS data will refuse the update rather ` +
        `than risk it. Pass --data=<file> with the JSON from ` +
        `\`<binary> --aio-data-contract\`, or ship on a machine that can run it.`,
    );
    return undefined;
  }
}

/** The app's own deno.json (the `ship` CLI runs at the project root), or {}. */
async function projectConfig(root: string): Promise<Record<string, unknown>> {
  try {
    const parsed = (await readDenoJson(root))?.config ?? {};
    return parsed && typeof parsed === "object"
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
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
  /** Release channel — default `deno.json`'s `build.channel`, else "prod". */
  channel?: string;
  /** Install strategy — default inferred from the artifact's extension. */
  target?: UpdateTarget;
  /** Artifact URL, absolute or relative to the manifest. Default: the file name,
   *  so a manifest published beside its artifact resolves without configuration. */
  url?: string;
  /** One line (or a link) shown in the update prompt. */
  notes?: string;
  /** Refuse to update FROM anything older than this. */
  minFrom?: string;
  /** Path to a data contract JSON (from `<binary> --aio-data-contract`).
   *  Default: probe the binary itself. */
  dataPath?: string;
}): Promise<ShipManifest> {
  const binary = await Deno.readFile(opts.binaryPath);
  // The sources to scan come from THE app-dir decider (the entry's directory),
  // not a hardcoded "src". An app whose entry is `apps/web/main.ts` has no
  // `src/` at all, and the missing dir was swallowed into an EMPTY capability
  // set: the manifest then reported every capability false and `run: (no
  // perms)` — a signed, verifiable claim of least privilege that was never
  // measured. It is now derived, and an empty scan is refused.
  const root = Deno.cwd();
  const cfg = await projectConfig(root);
  const sourceDir = opts.sourceDir ?? resolveAppDir(root, resolveEntry(cfg));
  const sources = await collectSources(sourceDir);
  if (sources.length === 0) {
    throw new Error(
      `[ship] no .ts/.tsx sources under ${sourceDir} — refusing to sign a ` +
        `capability claim that was never measured. Point at the app's ` +
        `sources with --src=DIR (or set "entry" in deno.json).`,
    );
  }
  // The version is part of the artifact's IDENTITY. Defaulting to "0.0.0" made
  // every unlabelled release claim the same confident wrong number.
  const version = opts.version ??
    (typeof cfg.version === "string" && cfg.version.trim()
      ? cfg.version.trim()
      : undefined);
  if (!version) {
    throw new Error(
      `[ship] no version to publish — set "version" in ${
        join(root, "deno.json")
      } or pass --version=X.Y.Z. A manifest that says 0.0.0 identifies nothing.`,
    );
  }
  let sign: { privateKey: JsonWebKey; publicKey: JsonWebKey } | undefined;
  if (opts.keyPath) {
    sign = JSON.parse(await Deno.readTextFile(opts.keyPath)) as {
      privateKey: JsonWebKey;
      publicKey: JsonWebKey;
    };
  }
  const fileName = opts.binaryPath.replace(/.*[\\/]/, "");
  const buildCfg = (cfg.build ?? {}) as Record<string, unknown>;
  const manifest = await buildShipManifest({
    name: opts.name ?? fileName,
    version,
    binary,
    sources,
    sign,
    channel: opts.channel ??
      (typeof buildCfg.channel === "string" ? buildCfg.channel : undefined),
    target: opts.target ?? inferTarget(fileName, buildCfg),
    // Default the URL to the artifact's own file name: a manifest published
    // beside its artifact then resolves with nothing to configure, which is
    // the layout the docs recommend and the one CI produces by accident.
    url: opts.url ?? fileName,
    notes: opts.notes,
    minFrom: opts.minFrom,
    data: opts.dataPath
      ? JSON.parse(await Deno.readTextFile(opts.dataPath)) as DataContract
      : await probeDataContract(opts.binaryPath),
  });
  const outPath = opts.out ?? opts.binaryPath + ".ship.json";
  await Deno.writeTextFile(outPath, JSON.stringify(manifest, null, 2));
  return manifest;
}

/** A GitHub Actions workflow that builds, signs and publishes releases into the
 *  exact channel layout an aio updater already reads.
 *
 *  Emitted rather than integrated. Talking to a forge's API from the framework
 *  would buy a dependency on somebody else's moving target for something a
 *  workflow file does natively — and the layout, not the transport, is the part
 *  aio actually owns. The result is a file you can read, edit and keep. */
export function githubWorkflow(opts: {
  name: string;
  /** Channel each ref publishes to. A tag is a release; a branch is not. */
  channel?: string;
}): string {
  const channel = opts.channel ?? "prod";
  return `# Generated by \`aio ship --github\`. Edit freely — it is yours now.
#
# Publishes into the layout an aio app already knows how to read:
#   <base>/${channel}/<os>-<arch>.json   the signed manifest
#   <base>/${channel}/<artifact>         the binary / AppImage / zip
#
# Point your app at the base URL and it takes it from there:
#   aio.run({ updates: "https://github.com/OWNER/REPO/releases/latest/download" })
#
# One secret is required: AIO_SIGNING_KEY — the JSON from \`aio ship keygen\`.
# Keep the private half in the secret and nowhere else; the public half travels
# inside every manifest, which is how clients pin it on first install.
name: release

on:
  push:
    tags: ["v*"]
  workflow_dispatch:

permissions:
  contents: write

jobs:
  build:
    strategy:
      # fail-fast off: one platform's build breaking should not hide whether
      # the others are fine — that is the whole reason to build a matrix.
      fail-fast: false
      matrix:
        include:
          - os: ubuntu-latest
          - os: macos-latest
          - os: windows-latest
    runs-on: \${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: denoland/setup-deno@v2
        with:
          deno-version: v2.x

      - name: Build
        run: deno task compile

      - name: Sign and publish the manifest
        shell: bash
        env:
          AIO_SIGNING_KEY: \${{ secrets.AIO_SIGNING_KEY }}
        run: |
          set -euo pipefail
          printf '%s' "$AIO_SIGNING_KEY" > /tmp/aio-key.json
          # The artifact is found by TIME, never by name: the framework owns
          # its naming rules and a second copy of them here would go stale.
          artifact=$(find . -maxdepth 3 -type f -newer deno.json \\
            \\( -perm -u+x -o -name '*.AppImage' -o -name '*.zip' \\) \\
            ! -path '*/node_modules/*' ! -name '*.ts' ! -name '*.json' \\
            | head -n1)
          test -n "$artifact" || { echo "no artifact produced"; exit 1; }
          deno run -A jsr:@riagentic/aio/ship "$artifact" \\
            --channel=${channel} --key=/tmp/aio-key.json
          rm -f /tmp/aio-key.json
          mkdir -p out/${channel}
          cp "$artifact" out/${channel}/
          cp "$artifact".ship.json \\
            "out/${channel}/$(deno eval 'console.log(Deno.build.os + "-" + Deno.build.arch)').json"

      - uses: actions/upload-artifact@v4
        with:
          name: release-\${{ matrix.os }}
          path: out/

  publish:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - uses: actions/download-artifact@v4
        with:
          path: staged
      - name: Collect every platform into one channel directory
        run: |
          mkdir -p out
          cp -r staged/*/* out/
          find out -type f | sort
      - uses: softprops/action-gh-release@v2
        with:
          files: out/${channel}/*
          # The updater reads a stable base URL, so a release must not be a
          # draft — a draft has no public download path and the app would only
          # ever see "no updates available".
          draft: false
`;
}

if (import.meta.main) {
  const args = Deno.args;
  const bin = args.find((a) => !a.startsWith("--"));
  if (bin === "github" || args.includes("--github")) {
    const channel = args.find((a) => a.startsWith("--channel="))?.slice(10) ??
      "prod";
    const name = args.find((a) => a.startsWith("--name="))?.slice(7) ?? "app";
    const out = ".github/workflows/release.yml";
    await Deno.mkdir(".github/workflows", { recursive: true });
    await Deno.writeTextFile(out, githubWorkflow({ name, channel }));
    console.log(
      `ship: wrote ${out} (channel "${channel}")\n` +
        `  1. aio ship keygen > release-key.json\n` +
        `  2. put its CONTENTS in the repo secret AIO_SIGNING_KEY\n` +
        `  3. keep release-key.json somewhere safe and out of git —\n` +
        `     losing it means no future release can be signed by the key your\n` +
        `     users already pinned, and every install will refuse the update\n` +
        `  4. point the app at the release base URL:\n` +
        `     updates: "https://github.com/OWNER/REPO/releases/latest/download"`,
    );
    Deno.exit(0);
  }
  if (bin === "keygen") {
    // `ship keygen` → print a fresh signing keypair (redirect to a key file).
    console.log(JSON.stringify(await generateSigningKey(), null, 2));
    Deno.exit(0);
  }
  if (!bin) {
    console.error(
      "usage: ship <binary> [--src=DIR] [--name=N] [--version=V] [--key=key.json]\n" +
        "            [--channel=dev|test|prod] [--target=T] [--url=U] [--notes=…]\n" +
        "            [--min-from=X.Y.Z] [--data=contract.json] [--out=ship.json]\n" +
        "       ship keygen   # print a fresh Ed25519 signing keypair\n" +
        "       ship github [--channel=prod]   # write a release workflow",
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
    channel: flag("channel"),
    target: flag("target") as UpdateTarget | undefined,
    url: flag("url"),
    notes: flag("notes"),
    minFrom: flag("min-from"),
    dataPath: flag("data"),
  });
  console.log(
    `ship: ${m.name} ${m.version}\n` +
      `  channel  ${m.channel}\n` +
      `  target   ${m.target} (${m.platform.os}/${m.platform.arch})\n` +
      `  data     ${
        m.data
          ? `${
            Object.keys(m.data.cells).length
          } cell(s), schema v${m.data.schema}`
          : "NOT DECLARED — installs holding data will refuse this release"
      }\n` +
      `  sha256   ${m.sha256}\n` +
      `  run:     ${
        m.runFlags.length ? m.runFlags.join(" ") : "(no perms)"
      }\n` +
      `  ${
        m.signature
          ? "signed (Ed25519) — channel, target and platform are inside the signature"
          : "UNSIGNED — clients must pass --allow-unsigned to install this"
      }`,
  );
}
