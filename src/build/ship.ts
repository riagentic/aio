// ship.ts — `aio ship` core: a verifiable release manifest for a
// compiled binary. Ties together the reproducible artifact (SHA-256), the
// least-privilege capability manifest (what --allow-* it actually needs, never
// -A), and an optional Ed25519 signature over the digest. The auto-update
// CHANNEL (serving + fetching + swapping) is separate infra; this is the
// signable, verifiable artifact it would distribute.
import { readDenoJson } from "../server/deno-json.ts";
import { appIdFromConfig } from "../server/single-instance-lock.ts";
import { basename, dirname, join, resolve as resolvePath } from "@std/path";
// Synchronous SHA-256 for `keyFingerprint`: WebCrypto's digest is async, and a
// key fingerprint is shown from render/report paths that are not. Same import
// the session and user stores already use.
import { createHash } from "node:crypto";
import { resolveAppDir, resolveEntry } from "./build-config.ts";
import { buildVersionFor, unpublishableReason } from "./build-version.ts";
import {
  flagVocabulary,
  SHIP_BOOL_FLAGS,
  SHIP_VALUE_FLAGS,
  unknownShipFlags,
} from "./build-flags.ts";
import {
  type Capabilities,
  permissionFlags,
  scanCapabilities,
} from "./capabilities.ts";

/** How an update client installs this artifact. The swap differs per target;
 *  everything before it (fetch → verify → stage) does not. `"source"` is a
 *  running-from-`deno task dev` tree — detect works, apply refuses. */
export const UPDATE_TARGETS = [
  "binary",
  "appimage",
  "electron-appimage",
  "electron-zip",
  "android",
  "source",
] as const;

/** How a published release installs itself — one of {@linkcode UPDATE_TARGETS}.
 *
 *  Signed into the manifest and matched against what the running install
 *  actually is, so a release built for one shape can never be applied to
 *  another (an `electron-zip` archive renamed over a bare binary, say). */
export type UpdateTarget = typeof UPDATE_TARGETS[number];

/** Pure: is `v` one of the install strategies a client can actually perform?
 *  `--target=` used to be CAST, so `--target=binry` produced a perfectly signed
 *  manifest that every client refused with "target mismatch" — a typo that only
 *  surfaced in production, on someone else's machine. */
export function isUpdateTarget(v: unknown): v is UpdateTarget {
  return typeof v === "string" &&
    (UPDATE_TARGETS as readonly string[]).includes(v);
}

/** What `ship` publishes next to a binary: identity, integrity (hash +
 *  signature), the capabilities scanned from source, the least-privilege flags
 *  to run it with, and the release coordinates an update client refuses on. */
export type ShipManifest = {
  /** Manifest format. `3` = channel-bound AND text-bound: the signature covers
   *  every field a human or a client DECIDES on, including the release notes
   *  and the release date. Versions 1 (digest-only) and 2 (coordinates only,
   *  notes/releasedAt unsigned) are REFUSED — see verifyManifestClaims. */
  manifestVersion: 3;
  name: string;
  version: string;
  /** The derived build number (`major.minor.<buildNumber>`) and the short
   *  commit it was built from — INSIDE the signed core (`manifestCore`), like
   *  everything a client shows or decides on. */
  buildNumber?: number;
  commit?: string | null;
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
   *
   *  There is no cell option that narrows this by hand: `deriveDataContract`
   *  writes `onMigrate ? 1 : version` and nothing else. (The doc used to
   *  describe an explicit `migratesFrom` key, which never existed — a claim
   *  about an API is as load-bearing as the API.)
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
 *  promise the same thing serialize — and therefore sign — identically.
 *
 *  The sort is the whole point: `Object.entries` yields INSERTION order, so the
 *  same set of cells registered in a different order would otherwise produce a
 *  different core and a signature that does not verify against a manifest
 *  describing the identical release. Pinned by a test that builds the same
 *  contract with its keys inserted both ways. */
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
 *  v3 additionally covers `name`, `notes` and `releasedAt`. v2 left all three
 *  outside, which meant a CDN — or anyone who can write to the release path —
 *  could rewrite the sentence a human reads before clicking Yes ("routine
 *  security fix"), backdate the release, or relabel whose app it is, and every
 *  client would still report the signature as valid. Everything a human or a
 *  client decides on is inside the signature or it is not authenticated.
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
    notes: m.notes ?? "",
    releasedAt: m.releasedAt ?? "",
    // Where the build came from — a client can show it, so it is signed.
    // Absent on a manifest that predates it: `null` / "" keep such a
    // manifest's core stable, but a manifest SIGNED before these two joined
    // the core no longer verifies (alpha70 is the last breaking release).
    buildNumber: m.buildNumber ?? null,
    commit: m.commit ?? "",
  });
}

/** The charset every identity-shaped manifest field must match.
 *
 *  These three values (`name`, `version`, `channel`) do not stay inside the
 *  manifest: they are interpolated into filesystem paths (the staging dir, the
 *  `.old-<version>` sibling, the versioned install layout), into a shell string
 *  on the electron-zip swap, and `channel` reaches `git ls-remote` as a
 *  positional argument. A manifest is attacker-influenced input, so the charset
 *  is fixed here — leading alphanumeric, then alphanumerics and `. _ + -`, at
 *  most 64 characters. No slash, no `..`, no whitespace, no shell metacharacter,
 *  no leading `-` (which is how a positional becomes a flag).
 *
 *  This is THE decider: `verifyManifestClaims` applies it before anything else
 *  and nothing downstream re-validates. A second copy of this rule somewhere
 *  else is how the two spellings drift apart. */
export const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;

/** Pure: why `value` is not usable as `field`, or `null` when it is fine.
 *  The offending value is echoed back (truncated, JSON-escaped) because a
 *  refusal nobody can act on is only half a refusal. */
export function safeTokenReason(field: string, value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) {
    return `manifest ${field} is missing — refusing a release that does not ` +
      `say what it is. Re-publish with \`aio ship\`.`;
  }
  if (SAFE_TOKEN.test(value)) return null;
  const shown = value.length > 48 ? value.slice(0, 48) + "…" : value;
  return `manifest ${field} ${JSON.stringify(shown)} is not a safe ` +
    `identifier — ${field} reaches filesystem paths and command arguments, ` +
    `so it must match ${SAFE_TOKEN.source} (letters, digits, and . _ + -, ` +
    `starting alphanumeric, at most 64 characters). Re-publish with ` +
    `\`aio ship --${field}=…\`.`;
}

/** A short, stable fingerprint of a public signing key, for showing a human
 *  WHICH key an app is trusting (the boot report, the update prompt, `am`).
 *
 *  Over the canonical `{kty,crv,x}` triple rather than the whole JWK: the same
 *  key re-exported by a different runtime differs in `key_ops`/`ext`/`alg`, and
 *  a fingerprint that changed on a re-export would train people to ignore it.
 *  Synchronous, so a render path can call it. */
export function keyFingerprint(jwk: JsonWebKey): string {
  const canonical = JSON.stringify({
    kty: jwk.kty ?? "",
    crv: jwk.crv ?? "",
    x: jwk.x ?? "",
  });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 12);
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

/** The manifest file name a client fetches for a platform: `<os>-<arch>.json`.
 *
 *  An update client asks for `<base>/<channel>/<os>-<arch>.json` — that name is
 *  not a convention, it is the request. `aio ship` used to write only
 *  `<binary>.ship.json`, and the doc said "copy both", which produces a channel
 *  directory with no file at the name the client asks for. The failure mode is
 *  a permanent, silent "no updates available", so the publish surface writes
 *  the fetched name itself.
 *
 *  Pinned against `manifestUrl` (updates-core) by a test — two spellings of one
 *  path is exactly how this broke. */
export function manifestFileName(
  platform: { os: string; arch: string },
): string {
  return `${platform.os}-${platform.arch}.json`;
}

/** Build a ship manifest for a compiled binary. Signs the digest when a private
 *  key JWK is supplied (with its public JWK for the consumer). */
export async function buildShipManifest(opts: {
  name: string;
  version: string;
  buildNumber?: number;
  commit?: string | null;
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
    manifestVersion: 3,
    name: opts.name,
    version: opts.version,
    ...(opts.buildNumber !== undefined
      ? { buildNumber: opts.buildNumber }
      : {}),
    ...(opts.commit !== undefined ? { commit: opts.commit } : {}),
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
  /** The app this install IS. A manifest naming another app is refused before
   *  the signature is even looked at: the realistic cause is two apps sharing
   *  one release path, and "this is a release for something else" is a far more
   *  actionable sentence than "untrusted key". */
  name?: string;
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
  /** Additional trusted keys — a ROSTER, so signing keys can be rotated.
   *
   *  With exactly one pinned key, losing it bricks every install forever: no
   *  future release can ever be signed by the key the users already trust, and
   *  the correct refusal is indistinguishable from an attack. A roster makes
   *  rotation an ordinary release: publish release N (signed by the OLD key)
   *  carrying `updates: { keys: [old, new] }`, let installs pick it up, then
   *  sign release N+1 with the new key — every install already trusts it.
   *
   *  It is deliberately NOT a recovery mechanism for a key already lost: the
   *  roster has to reach the install BEFORE the old key stops signing. The
   *  manual procedure for the lost-key case is in the updates doc.
   *
   *  A manifest signed by ANY rostered key verifies. `key` and `keys` are
   *  unioned, so pinning still works unchanged. */
  keys?: JsonWebKey[];
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

/** Every key this install trusts: the pinned one plus the roster, deduped by
 *  curve point. Empty means "nothing pinned yet" — trust on first use. */
function trustedKeys(expect: ShipExpectations): JsonWebKey[] {
  const all = [...(expect.key ? [expect.key] : []), ...(expect.keys ?? [])];
  return all.filter((k, i) => all.findIndex((o) => sameKey(o, k)) === i);
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
  // FIRST, before anything reads these values: the three identity-shaped
  // fields leave the manifest and become path segments and command arguments.
  // Validating here — and only here — means every consumer of a verified
  // manifest can use them without asking again. See SAFE_TOKEN.
  for (
    const [field, value] of [
      ["name", manifest.name],
      ["version", manifest.version],
      ["channel", manifest.channel],
    ] as const
  ) {
    const bad = safeTokenReason(field, value);
    if (bad) return { ok: false, reason: bad };
  }
  // A v1 manifest signed only the binary digest; a v2 manifest signed the
  // release coordinates but left the notes, the release date and the app name
  // outside. Accepting either would hand back exactly the guarantee this format
  // exists to provide, so they are refused rather than downgraded to.
  if (manifest.manifestVersion !== 3) {
    const v = manifest.manifestVersion ?? 1;
    return {
      ok: false,
      reason: v >= 2
        ? `manifest format ${v} predates release-text binding — its signature ` +
          `does not cover the app name, the release notes or the release ` +
          `date, so the sentence a human agrees to can be rewritten in ` +
          `transit. Re-publish with \`aio ship\`.`
        : `manifest format ${v} predates channel binding — its signature does ` +
          `not cover the channel, target or platform. Re-publish with ` +
          `\`aio ship\`.`,
    };
  }
  // Before the signature: cheap, and "this release is for another app" is a
  // sentence the publisher can act on, where "untrusted key" sends them
  // looking for an attacker that is not there.
  if (expect.name && manifest.name !== expect.name) {
    return {
      ok: false,
      reason:
        `this app is "${expect.name}", the manifest is for "${manifest.name}" ` +
        `— a release for another app was published to this path`,
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
  const trusted = trustedKeys(expect);
  if (!manifest.signature) {
    if (trusted.length > 0) {
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
          "manifest is unsigned — an unsigned release authenticates nothing. " +
          "Sign it with `aio ship --key=…`, or, for a private LAN build, set " +
          "`updates: { allowUnsigned: true }` in the app's config.",
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
  if (
    trusted.length > 0 && !trusted.some((k) => sameKey(manifest.publicKey!, k))
  ) {
    return {
      ok: false,
      reason:
        `signed by an untrusted key (${
          keyFingerprint(manifest.publicKey)
        }) — ` +
        `not one of the ${trusted.length} key(s) this app trusts (${
          trusted.map(keyFingerprint).join(", ")
        }). To rotate signing keys, publish a release signed by the CURRENT ` +
        `key that lists the new one in \`updates: { keys: [...] }\`.`,
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
    reason: trusted.length > 0
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

/** Every target KIND a project declares, across BOTH spellings of
 *  `build.targets`.
 *
 *  `Array.isArray(targets) && targets.includes("electron")` was the whole
 *  check, and the object form — the documented layout for a repo holding two
 *  apps, `{"desk": {"kind": "electron", "entry": …}}` — is not an array. Such a
 *  project's Electron AppImage was therefore published as a plain `appimage`,
 *  i.e. a signed manifest describing the wrong install strategy. Pure. */
export function declaredTargetKinds(
  buildCfg: Record<string, unknown>,
): Set<string> {
  const out = new Set<string>();
  // The pre-alpha52 singular key, still honoured where it is still written.
  if (typeof buildCfg.target === "string") out.add(buildCfg.target);
  const t = buildCfg.targets;
  if (Array.isArray(t)) {
    for (const n of t) if (typeof n === "string") out.add(n.trim());
  } else if (t && typeof t === "object") {
    // A label IS the kind unless the override names one — the same rule
    // `normalizeTargets` applies in build-all.
    for (const [label, o] of Object.entries(t as Record<string, unknown>)) {
      const kind = (o && typeof o === "object" && !Array.isArray(o) &&
          typeof (o as { kind?: unknown }).kind === "string")
        ? (o as { kind: string }).kind.trim()
        : label.trim();
      out.add(kind);
    }
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
  const electron = declaredTargetKinds(buildCfg).has("electron");
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
 *  A failure THROWS. It used to warn and carry on, which meant the flow the
 *  docs teach published every release with `data: undefined` — and a manifest
 *  with no contract is refused by every install that HAS data, forever, with
 *  no signal on the publisher's machine. Losing the feature's headline
 *  guarantee is not a warning. The two legitimate escapes are explicit:
 *  `--data=<file>` (a contract captured on a machine that CAN run the binary)
 *  and `--no-data` (publish without one, on purpose). */
async function probeDataContract(binaryPath: string): Promise<DataContract> {
  let out: Deno.CommandOutput;
  try {
    out = await new Deno.Command(binaryPath, {
      args: ["--aio-data-contract"],
      stdout: "piped",
      stderr: "piped",
    }).output();
  } catch (e) {
    // The spawn itself failed — ENOEXEC, EACCES, no such file. The artifact is
    // not a program.
    throw new Error(notRunnable(
      binaryPath,
      `it could not be executed at all (${e instanceof Error ? e.message : e})`,
    ));
  }
  const stdout = new TextDecoder().decode(out.stdout);
  if (!out.success) {
    const stderr = new TextDecoder().decode(out.stderr);
    const tail = stderr.trim().split("\n").slice(-3).join("\n       ");
    if (notRunnableExit(out.code, stderr)) {
      throw new Error(notRunnable(
        binaryPath,
        `it is not an executable program (exit ${out.code}${
          tail ? `:\n       ${tail}` : ""
        })`,
      ));
    }
    throw new Error(contractFailure(
      binaryPath,
      `exited ${out.code}${tail ? `:\n       ${tail}` : ""}`,
    ));
  }
  return parseDataContract(stdout, `\`${binaryPath} --aio-data-contract\``);
}

/** Did this exit mean "the file is not a program", rather than "the program
 *  ran and failed"?
 *
 *  A shell answers a file it cannot execute with 126 (`cannot execute`) or 127
 *  (`not found` — which is also what it says about the SHEBANG-less first line
 *  of a text file it tried to interpret), and says so on stderr. Both are the
 *  process never having started, dressed as an exit code.
 *
 *  Pure, so the whole table is a unit test. Conservative on purpose: a real
 *  program is free to exit 127 for its own reasons, so the code alone is not
 *  enough — stderr has to agree, and a program that exits 127 with output of
 *  its own keeps the data-contract message (and its escape hatches).
 *  @internal alpha70 — test seam via src/testing/internal.ts */
export function notRunnableExit(code: number, stderr: string): boolean {
  if (code !== 126 && code !== 127) return false;
  return /not found|cannot execute|exec format error|permission denied|no such file/i
    .test(stderr);
}

/** What KIND of file this artifact is, by its own first bytes — or `null` when
 *  it is none of them.
 *
 *  Every shape aio can publish is one of these ({@link UPDATE_TARGETS} is a
 *  closed set): `binary` and `appimage` are ELF/PE/Mach-O, an `electron-zip`
 *  and an `android` APK are ZIP containers, and a launcher script carries a
 *  shebang. There is no sixth thing.
 *
 *  Which is why `null` can be a refusal rather than a warning: it means the
 *  file is not an executable or an archive for ANY platform. That distinction
 *  matters because `--no-data` exists — it is the honest hatch for an artifact
 *  THIS machine cannot run (a cross-compiled binary), and it skips the only
 *  step that would otherwise have executed the file. Without this check, a
 *  broken artifact plus `--no-data` produces a correctly signed release that
 *  every install fetches, fails its pre-swap smoke test on, and rolls back.
 *
 *  Pure over the first bytes, so the whole table is a unit test and no platform
 *  has to be present to check another platform's artifact. */
export function artifactFormat(bytes: Uint8Array): string | null {
  const at = (i: number) => bytes[i] ?? -1;
  const magic = (...b: number[]) => b.every((v, i) => at(i) === v);
  if (magic(0x7f, 0x45, 0x4c, 0x46)) return "ELF"; // Linux binary / AppImage
  if (magic(0x4d, 0x5a)) return "PE"; // Windows .exe
  if (magic(0x50, 0x4b, 0x03, 0x04)) return "ZIP"; // .zip / .apk
  if (magic(0x23, 0x21)) return "script"; // #! launcher
  // Mach-O, all four spellings: 32/64-bit, both endiannesses — plus the
  // universal ("fat") header a macOS artifact for two arches carries.
  for (
    const m of [
      [0xfe, 0xed, 0xfa, 0xce],
      [0xce, 0xfa, 0xed, 0xfe],
      [0xfe, 0xed, 0xfa, 0xcf],
      [0xcf, 0xfa, 0xed, 0xfe],
      [0xca, 0xfe, 0xba, 0xbe],
      [0xbe, 0xba, 0xfe, 0xca],
    ]
  ) if (magic(...m)) return "Mach-O";
  return null;
}

/** "This artifact is not a runnable program."
 *
 *  Deliberately NOT {@link contractFailure}, and the difference is the whole
 *  point. The two failures used to share one message, so an artifact that does
 *  not execute was reported as a data-contract problem — and the message then
 *  offered `--no-data`, which signs and publishes it. Every install would fetch
 *  a binary that cannot run, fail its pre-swap smoke test and roll back; the
 *  one machine that could have caught it cheaply was handed the flag that
 *  ships it instead.
 *
 *  So this message names no hatch. A binary that cannot execute is not a
 *  releasable artifact on any channel, with a contract or without one. */
function notRunnable(binaryPath: string, why: string): string {
  return `[ship] ${binaryPath} is not a runnable program — ${why}.\n` +
    `       This is a BROKEN BUILD, not a missing data contract: an install ` +
    `that fetched it would fail its pre-swap smoke test and roll back. There ` +
    `is no flag for it and --no-data is not one — that hatch is for an ` +
    `artifact THIS MACHINE cannot run (a cross-compiled binary), not for one ` +
    `that does not run anywhere.\n` +
    `       See it for yourself: \`${binaryPath} --aio-data-contract\`. Then ` +
    `rebuild (\`deno task build\`) and publish the artifact that produces.`;
}

/** Parse + shape-check a data contract, naming the source when it is not one.
 *  Shared by the probe and `--data=<file>`: a file that holds boot log lines
 *  used to reach `JSON.parse` bare and abort `ship` with a framework stack. */
export function parseDataContract(text: string, source: string): DataContract {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    const first = text.trim().split("\n")[0] ?? "";
    throw new Error(
      `[ship] ${source} is not JSON (${
        e instanceof Error ? e.message : e
      }).\n` +
        (first ? `       first line: ${first.slice(0, 120)}\n` : "") +
        `       A data contract is the JSON object printed by ` +
        `\`<binary> --aio-data-contract\` and NOTHING else — if the file also ` +
        `holds boot log lines, recapture it with ` +
        `\`<binary> --aio-data-contract > contract.json\` ` +
        `(aio prints the contract on stdout and everything else on stderr).`,
    );
  }
  if (
    !parsed || typeof parsed !== "object" ||
    typeof (parsed as DataContract).cells !== "object"
  ) {
    throw new Error(
      `[ship] ${source} parsed as JSON but is not a data contract — it must ` +
        `be an object with a "cells" map (and a "schema" number). Got: ` +
        `${JSON.stringify(parsed).slice(0, 160)}`,
    );
  }
  return parsed as DataContract;
}

/** Parse + shape-check a release SIGNING KEY file, naming the source when it
 *  is not one.
 *
 *  This was `JSON.parse(...) as {privateKey, publicKey}` — a bare parse and a
 *  bare cast — twenty lines below `parseDataContract`, whose own comment
 *  explains why that shape is unacceptable for the DATA contract. The key is
 *  the input where it matters more: a wrong file reached WebCrypto and came
 *  back as `TypeError: Cannot import key: 'keyData' is not a JsonWebKey`,
 *  which names neither the file, nor the key, nor the fix.
 *
 *  And it is reachable by following the docs. `aio ship keygen` WRITES the
 *  keypair and PRINTS a summary — `{"keyPath": "…", "publicKey": {…}}` — so
 *  the redirect the docs used to teach (`ship keygen > release-key.json`)
 *  captures the summary: valid JSON, carrying a public key, missing the
 *  private half, and looking exactly like a key file. That case gets its own
 *  sentence, because the real key is sitting at the `keyPath` the captured
 *  file itself names.
 *
 *  Pure over the text, so every branch is a unit test rather than a claim
 *  about a path that only runs with a real key on disk. */
export function parseSigningKey(
  text: string,
  path: string,
): { privateKey: JsonWebKey; publicKey: JsonWebKey } {
  const head = `[ship] ${path} is not a release signing key`;
  const made = `       Make one with \`aio ship keygen\` — it WRITES the key ` +
    `outside the repo (0600) and prints only the public half, so ` +
    `\`ship keygen > key.json\` captures the summary, not the key.`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    const first = text.trim().split("\n")[0] ?? "";
    throw new Error(
      `${head}: it is not JSON (${e instanceof Error ? e.message : e}).\n` +
        (first ? `       first line: ${first.slice(0, 120)}\n` : "") +
        made,
    );
  }
  const o = (parsed && typeof parsed === "object" && !Array.isArray(parsed))
    ? parsed as Record<string, unknown>
    : null;
  const isJwk = (v: unknown): v is JsonWebKey =>
    !!v && typeof v === "object" && !Array.isArray(v) &&
    typeof (v as JsonWebKey).kty === "string";

  // The keygen-summary case, named for what it is: the file is honest, it just
  // is not the key — and it says where the key is.
  if (o && !("privateKey" in o) && isJwk(o.publicKey)) {
    const where = typeof o.keyPath === "string" && o.keyPath
      ? `\n       Your key is at ${o.keyPath} — pass --key=${o.keyPath}.`
      : "";
    throw new Error(
      `${head}: it holds a PUBLIC key and no \`privateKey\`.\n` +
        `       This is what \`aio ship keygen\` prints on stdout (the ` +
        `summary), not the key file it writes — a \`> file.json\` redirect ` +
        `captures the summary.${where}\n` +
        (where ? "" : `${made}\n`),
    );
  }
  if (!o || !("privateKey" in o) || !("publicKey" in o)) {
    throw new Error(
      `${head}: it must be a JSON object with BOTH \`privateKey\` and ` +
        `\`publicKey\` (Ed25519 JWKs). Got: ${
          JSON.stringify(parsed).slice(0, 160)
        }\n` + made,
    );
  }
  const bad = [
    !isJwk(o.privateKey) ? "privateKey" : null,
    !isJwk(o.publicKey) ? "publicKey" : null,
  ].filter(Boolean);
  if (bad.length > 0) {
    throw new Error(
      `${head}: ${bad.join(" and ")} ${
        bad.length > 1 ? "are" : "is"
      } not a JSON Web Key (no \`kty\`). A release key is a pair of Ed25519 ` +
        `JWKs — \`kty\`/\`crv\`/\`x\`, and \`d\` on the private half.\n` +
        made,
    );
  }
  return o as unknown as { privateKey: JsonWebKey; publicKey: JsonWebKey };
}

/** The one wording for "this build could not tell us what it does with data" —
 *  cause AND the two ways out, so it is never a dead end. */
function contractFailure(binaryPath: string, why: string): string {
  return `[ship] ${binaryPath} ${why}, so this release cannot say what it ` +
    `does with existing data.\n` +
    `       Publishing anyway is allowed but NOT the default: a manifest ` +
    `with no data contract is refused by every install that already has ` +
    `data, on every machine, silently.\n` +
    `       Fix: run \`<binary> --aio-data-contract > contract.json\` on a ` +
    `machine that can execute this artifact and pass --data=contract.json — ` +
    `or, when this artifact is CROSS-COMPILED and this machine simply cannot ` +
    `run it, --no-data publishes without a contract on purpose.`;
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
  /** The version to publish. Default: THE build version resolved from this
   *  tree (`major.minor.<commit count>`, see build-version.ts). */
  version?: string;
  buildNumber?: number;
  commit?: string | null;
  /** Publish a `-dirty.*` / `-nogit.*` version anyway — logged, never silent. */
  allowDirty?: boolean;
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
  /** Publish WITHOUT a data contract, on purpose — for an artifact this
   *  machine cannot execute (an .apk, a cross-compiled binary). Every install
   *  that already holds data will refuse the release; that is the trade being
   *  made explicitly, instead of a warning nobody reads. */
  noData?: boolean;
  /** The platform this artifact RUNS ON, when it is not this machine's.
   *
   *  Defaults to the host, which is right for a single-platform build and
   *  wrong for every other artifact of a fleet one: a cross-compiled binary
   *  published from Linux claimed `linux-x86_64`, so every manifest of a
   *  multi-platform build landed on the same `<os>-<arch>.json` and each
   *  overwrote the last — while a Windows client asking for its own name got a
   *  404. The platform is inside the signature too, so the wrong one is refused
   *  even where the path happens to resolve. */
  platform?: { os: string; arch: string };
  /** A contract already in hand, to stamp as-is.
   *
   *  The data contract is a property of the SOURCE, not of the platform: the
   *  same `cell()` declarations compile into every artifact of one build. So a
   *  fleet build can probe the one artifact this machine can run and stamp that
   *  answer into every platform's manifest — which is the difference between
   *  cross-platform publishing that works and a Windows install permanently
   *  refusing every release cut on Linux. Outranks {@link dataPath} and
   *  {@link noData}. */
  data?: DataContract;
  /** Also write the manifest into `<dir>/<channel>/<os>-<arch>.json` — the
   *  exact path a client requests. Given a staging directory, `aio ship`
   *  assembles the channel layout itself, so no script anywhere has to re-spell
   *  the file name (re-spelling it is what broke). */
  channelDir?: string;
}): Promise<ShipManifest> {
  const binary = await Deno.readFile(opts.binaryPath);
  // BEFORE the hash, the capability scan and the signature: is this file an
  // artifact at all?
  //
  // The data-contract probe catches a broken binary only when it RUNS it, and
  // `--no-data` (correctly) skips that step for a cross-compiled artifact this
  // machine cannot execute. So the two together left a hole with a signature on
  // it: `printf 'NOT A BINARY' > dist/app` + `--no-data` published a release
  // every install would fetch, fail its pre-swap smoke test on, and roll back.
  // Reading four bytes closes it for every platform at once, and cannot be
  // confused by cross-compilation — a Windows .exe is recognisable from Linux.
  if (artifactFormat(binary) === null) {
    // The first bytes ARE the evidence, so they go in the message — mapped by
    // code point rather than a control-character regex, because those bytes
    // are exactly what a terminal must not be handed raw.
    const head = Array.from(
      new TextDecoder("utf-8", { fatal: false }).decode(binary.slice(0, 40)),
      (ch) => {
        const c = ch.codePointAt(0) ?? 0;
        return c < 0x20 || c === 0x7f ? "\u00b7" : ch;
      },
    ).join("");
    throw new Error(
      `[ship] ${opts.binaryPath} is not a publishable artifact — its first ` +
        `bytes are not an executable or an archive of any kind.\n` +
        `       aio publishes ELF / PE / Mach-O binaries, ZIP packages ` +
        `(.zip, .apk) and shebang launchers; this file starts "${head}".\n` +
        `       Point --key/ship at the BUILT artifact (\`deno task build\` ` +
        `writes it into dist/), not at a source file, a manifest or a ` +
        `placeholder. A file that cannot execute is not releasable on any ` +
        `channel, and --no-data does not make it one.`,
    );
  }
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
  // THE build version — derived from the tree exactly as the build named the
  // artifact. A `-dirty.*` / `-nogit.*` version is not reproducible from a
  // commit, so it is refused here, at the publisher, unless said otherwise.
  let version = opts.version;
  let buildNumber = opts.buildNumber;
  let commit = opts.commit;
  if (!version) {
    const { bv } = await buildVersionFor(root, cfg.version, {
      out: (cfg.build as { out?: string } | undefined)?.out,
    });
    version = bv.version;
    buildNumber ??= bv.build;
    commit ??= bv.commit;
  }
  const unpublishable = unpublishableReason(version);
  if (unpublishable) {
    if (!opts.allowDirty) throw new Error(`[ship] ✗ ${unpublishable}`);
    console.warn(
      `[ship] ⚠ --allow-dirty: publishing ${version} — ${unpublishable}`,
    );
  }
  const fileName = opts.binaryPath.replace(/.*[\\/]/, "");
  const buildCfg = (cfg.build ?? {}) as Record<string, unknown>;
  // The app's OWN id, not the artifact's file name. The client half
  // (`verifyManifestClaims`) refuses a manifest whose signed `name` differs
  // from the booting app's `appId` — the check that stops product B's manifest,
  // signed with the same release key, being installed over product A. The two
  // halves must therefore read the SAME identity: `appIdFromConfig` is the one
  // decider (appId > title > name), the same chain `resolveAppId` uses, with
  // the same slugify rule. A file name is a build-output detail (`notes-cli`,
  // `notes.AppImage`, `notes-1.2.0`) and would refuse its own updates.
  const nameFromCfg = appIdFromConfig(
    cfg as { appId?: string; title?: string; name?: string },
  );
  const name = opts.name ?? nameFromCfg ?? fileName;
  if (!opts.name && !nameFromCfg) {
    console.warn(
      `[ship] \u26a0 no appId/title/name in ${join(root, "deno.json")} — ` +
        `falling back to the artifact's file name "${fileName}" as the ` +
        `release name.\n` +
        `       The client matches the manifest name against the app's own ` +
        `appId and REFUSES a mismatch, so a build output called anything ` +
        `else ("${fileName}") ships updates no install will take. ` +
        `Fix: add "appId" to deno.json, or pass --name=<appId>.`,
    );
  }
  let sign: { privateKey: JsonWebKey; publicKey: JsonWebKey } | undefined;
  const key = await resolveSigningKey(opts.keyPath, name);
  if (key.path) {
    let keyText: string;
    try {
      keyText = await Deno.readTextFile(key.path);
    } catch (e) {
      throw new Error(
        `[ship] cannot read the signing key at ${key.path}: ${
          e instanceof Error ? e.message : e
        }\n       \`aio ship keygen\` writes one (outside any git work tree) ` +
          `and prints where it put it.`,
      );
    }
    sign = parseSigningKey(keyText, key.path);
  }
  const channel = opts.channel ??
    (typeof buildCfg.channel === "string" ? buildCfg.channel : "prod");
  // Refuse at the PRODUCER, not only at the consumer. `verifyManifestClaims`
  // is the one decider for a manifest that arrives over the wire; this is the
  // same rule applied where the mistake is actually made, so a bad channel or
  // an artifact whose file name is not a usable app name fails on the
  // publisher's machine instead of on every user's.
  for (
    const [field, value] of [
      ["name", name],
      ["version", version],
      ["channel", channel],
    ] as const
  ) {
    const bad = safeTokenReason(field, value);
    if (bad) throw new Error(`[ship] ${bad}`);
  }
  if (opts.target !== undefined && !isUpdateTarget(opts.target)) {
    throw new Error(
      `[ship] unknown target "${opts.target}" — a manifest with a target no ` +
        `client can perform is signed, valid, and refused by every install ` +
        `("target mismatch"). Use one of: ${UPDATE_TARGETS.join(", ")}.`,
    );
  }
  const manifest = await buildShipManifest({
    platform: opts.platform,
    name,
    version,
    buildNumber,
    commit,
    binary,
    sources,
    sign,
    channel,
    target: opts.target ?? inferTarget(fileName, buildCfg),
    // Default the URL to the artifact's own file name: a manifest published
    // beside its artifact then resolves with nothing to configure, which is
    // the layout the docs recommend and the one CI produces by accident.
    url: opts.url ?? fileName,
    notes: opts.notes,
    minFrom: opts.minFrom,
    data: opts.data ??
      (opts.dataPath
        ? parseDataContract(
          await Deno.readTextFile(opts.dataPath),
          opts.dataPath,
        )
        : opts.noData
        ? undefined
        : await probeDataContract(opts.binaryPath)),
  });
  const json = JSON.stringify(manifest, null, 2);
  // Write BOTH names, always. `<binary>.ship.json` is the one a human
  // recognises next to the artifact; `<os>-<arch>.json` is the one the client
  // literally requests. Writing only the first is the single most likely
  // publishing mistake in this whole subsystem and it fails silently forever,
  // so the tool does not leave it to a copy step in a doc.
  const outPath = opts.out ?? opts.binaryPath + ".ship.json";
  await Deno.writeTextFile(outPath, json);
  // `dirname`, not a hand-rolled regex: a bare relative path ("app.bin") has
  // no separator to strip, and the regex left the FILE name as the directory —
  // the manifest was then written to `app.bin/linux-x86_64.json` and the whole
  // command died at the last line.
  const fetched = join(
    dirname(opts.binaryPath),
    manifestFileName(manifest.platform),
  );
  if (fetched !== outPath) await Deno.writeTextFile(fetched, json);
  if (opts.channelDir) {
    const chDir = join(opts.channelDir, manifest.channel);
    await Deno.mkdir(chDir, { recursive: true });
    await Deno.writeTextFile(
      join(chDir, manifestFileName(manifest.platform)),
      json,
    );
  }
  return manifest;
}

/** The exact lines a publisher must run to turn what `aio ship` just wrote into
 *  a channel directory a client can read. Pure, so the CLI and a test read the
 *  same text.
 *
 *  Printed rather than performed: where the channel directory lives is the one
 *  thing aio genuinely does not know. What it does know is the layout, and an
 *  instruction the publisher can paste is the difference between that layout
 *  being right and being "no updates available" for the life of the app.
 *  @internal alpha70 — test seam via src/testing/internal.ts */
export function publishInstructions(
  m: ShipManifest,
  artifactFile: string,
): string {
  const fetched = manifestFileName(m.platform);
  return [
    `publish: copy these TWO files into <your-release-base>/${m.channel}/`,
    `  ${artifactFile}`,
    `  ${fetched}      <- the manifest, under the name the client FETCHES`,
    ``,
    `  mkdir -p out/${m.channel}`,
    `  cp ${artifactFile} out/${m.channel}/`,
    `  cp ${fetched} out/${m.channel}/`,
    ``,
    `then: aio.run({ updates: "<your-release-base>" })`,
    `      the client requests <your-release-base>/${m.channel}/${fetched}`,
    `NOTE: a GitHub Release cannot serve this — its assets are FLAT, so`,
    `      .../releases/latest/download/${m.channel}/${fetched} does not exist.`,
    `      Use any host that serves directories (GitHub Pages, S3, nginx);`,
    `      \`aio ship github\` writes a workflow that does exactly that.`,
  ].join("\n");
}

/** A GitHub Actions workflow that builds, signs and publishes releases into the
 *  exact channel layout an aio updater already reads.
 *
 *  Emitted rather than integrated. Talking to a forge's API from the framework
 *  would buy a dependency on somebody else's moving target for something a
 *  workflow file does natively — and the layout, not the transport, is the part
 *  aio actually owns. The result is a file you can read, edit and keep.
 *
 *  It publishes the channel directory to **GitHub Pages**, not to the release's
 *  own asset list, and that is not a preference. A client asks for
 *  `<base>/<channel>/<os>-<arch>.json`; GitHub Release assets are a FLAT list
 *  with no directories, so `.../releases/latest/download/prod/linux-x86_64.json`
 *  can never exist. Pages serves a real directory tree from the same origin as
 *  the artifacts beside it, which is exactly what the updater expects. The
 *  release itself still gets the binaries attached, for humans who just want to
 *  download one. */
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
# <base> is your GitHub Pages site, because that is the only GitHub surface
# that serves a DIRECTORY. Release assets are a flat list — there is no
# .../releases/latest/download/${channel}/… path and there never will be — so
# pointing an app at a release download URL produces a permanent, silent
# "no updates available". Enable Pages once (Settings -> Pages -> Source:
# GitHub Actions) and point your app at the site:
#
#   aio.run({ updates: "https://OWNER.github.io/REPO" })
#
# Size note: Pages allows 100 MB per file and 1 GB per site. Each deploy
# REPLACES the site, so only the current release counts — but an Electron zip
# larger than 100 MB needs a different host (S3, R2, any nginx). Only the base
# URL changes; the layout below is the same everywhere.
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
  pages: write
  id-token: write

# One deploy at a time: two releases racing would leave the site holding half
# of each, and half a channel directory is an app that cannot update.
concurrency:
  group: pages
  cancel-in-progress: false

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

      - name: Sign and stage the channel directory
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
          # --channel-dir lets \`aio ship\` assemble the channel layout itself.
          # Nothing here re-spells <os>-<arch>.json: re-spelling it somewhere
          # else is exactly how a channel directory ends up with no file at the
          # name the client asks for.
          deno run -A jsr:@riagentic/aio/ship "$artifact" \\
            --channel=${channel} --key=/tmp/aio-key.json --channel-dir=out
          rm -f /tmp/aio-key.json
          cp "$artifact" out/${channel}/
          ls -l out/${channel}

      - uses: actions/upload-artifact@v4
        with:
          name: release-\${{ matrix.os }}
          path: out/

  publish:
    needs: build
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: \${{ steps.deploy.outputs.page_url }}
    steps:
      - uses: actions/download-artifact@v4
        with:
          path: staged
      - name: Collect every platform into one channel directory
        run: |
          set -euo pipefail
          mkdir -p out
          cp -r staged/*/* out/
          find out -type f | sort
          # A channel directory with no manifest is the silent failure this
          # whole pipeline exists to prevent, so it is a red step, not a warning.
          test -n "$(find out/${channel} -name '*-*.json' -print -quit)" \\
            || { echo "no <os>-<arch>.json in out/${channel}"; exit 1; }

      # The updater reads THIS: a real directory tree, same origin as the
      # artifacts sitting beside the manifests.
      - uses: actions/upload-pages-artifact@v3
        with:
          path: out
      - id: deploy
        uses: actions/deploy-pages@v4

      # …and the release keeps the binaries attached, for people (not the
      # updater — see the header).
      - uses: softprops/action-gh-release@v2
        if: startsWith(github.ref, 'refs/tags/')
        with:
          files: out/${channel}/*
          draft: false
`;
}

/** The nearest enclosing git work tree of `dir`, or null. Walks up looking for
 *  `.git` (a directory in a normal clone, a FILE in a worktree/submodule) —
 *  no subprocess, so it works with git absent.
 *  @internal alpha70 — test seam via src/testing/internal.ts */
export function gitWorkTreeOf(dir: string): string | null {
  let cur = resolvePath(dir);
  for (;;) {
    try {
      Deno.statSync(join(cur, ".git"));
      return cur;
    } catch { /* keep walking */ }
    const up = dirname(cur);
    if (up === cur) return null;
    cur = up;
  }
}

/** Where a release signing key lives by default: OUTSIDE any work tree, under
 *  the user's home, one file per project.
 *
 *  Exported so anything that HINTS about a missing key (`am publish`) names the
 *  path `keygen` actually writes rather than carrying a second copy of the
 *  rule — "run keygen" without a location is the gap that sent people to
 *  `ship keygen > key.json`, which captures the printed summary instead of the
 *  key (see {@link parseSigningKey}). */
export function defaultKeyPath(project: string): string {
  const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? ".";
  return join(home, ".aio", "keys", `${project}-release-key.json`);
}

/** Which key signs a release: `--key`, else the file `ship keygen` wrote for
 *  THIS app (`defaultKeyPath(name)`) when it exists, else none. One decider for
 *  the `ship` CLI and `am publish` — a key that keygen wrote to the documented
 *  default used to be ignored unless the same path was typed back as --key,
 *  and the release went out unsigned.
 *  @internal */
export async function resolveSigningKey(
  explicit: string | undefined,
  appName: string,
): Promise<
  | { path: string; source: "flag" | "default" }
  | { path: undefined; source: "none" }
> {
  if (explicit) return { path: explicit, source: "flag" };
  const dflt = defaultKeyPath(appName);
  try {
    if ((await Deno.stat(dflt)).isFile) {
      return { path: dflt, source: "default" };
    }
  } catch {
    // no default key — unsigned; the caller says so out loud
  }
  return { path: undefined, source: "none" };
}

/** `aio ship keygen` — a fresh Ed25519 release key, written somewhere it will
 *  not be committed.
 *
 *  This used to print the private JWK on stdout and the docs redirected it into
 *  the repo root (`> release-key.json`), where nothing ignored it: a routine
 *  `git add -A` committed a private signing key, and it travelled into every
 *  clone. Whoever holds it can publish an update that every install of the app
 *  accepts, signed, forever — the app pins the matching public key.
 *
 *  So the key is WRITTEN, not printed: outside any git work tree by default,
 *  0600, never over an existing file (losing the key your users already pinned
 *  is unrecoverable). stdout gets the public half, which is the part that goes
 *  into the app's config. `--stdout` still prints the pair for a secret store
 *  (`aio ship keygen --stdout | gh secret set AIO_SIGNING_KEY`) — explicit, and
 *  it says what it just put on the pipe. */
async function keygenCli(args: string[]): Promise<void> {
  const flag = (k: string) =>
    args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
  const force = args.includes("--force");
  const pair = await generateSigningKey();
  if (args.includes("--stdout")) {
    console.error(
      `ship: \u26a0 that is a PRIVATE release signing key on stdout. Anyone ` +
        `who has it can publish a signed update every install accepts. Send ` +
        `it to a secret store, never to a file in a repository.`,
    );
    console.log(JSON.stringify(pair, null, 2));
    return;
  }
  const project = basename(resolvePath(Deno.cwd())) || "app";
  const out = flag("out") ?? defaultKeyPath(project);
  const tree = gitWorkTreeOf(dirname(resolvePath(out)) || ".");
  if (tree && !force) {
    console.error(
      `ship: refusing to write a private release signing key inside the git ` +
        `work tree at ${tree}\n` +
        `      (${resolvePath(out)}). One \`git add -A\` publishes it, and ` +
        `whoever has it can sign an update every install of this app will ` +
        `accept.\n` +
        `      Fix: run \`aio ship keygen\` with no --out (writes ` +
        `${defaultKeyPath(project)}), pass --out=<path outside the repo>, ` +
        `or --force if the path really is ignored.`,
    );
    Deno.exit(1);
  }
  try {
    Deno.statSync(out);
    if (!force) {
      console.error(
        `ship: ${out} already exists — refusing to overwrite a release ` +
          `signing key.\n` +
          `      Replacing it means no future release can be signed by the ` +
          `key your users already pinned, and every install refuses the ` +
          `update. To rotate, keep the old key and ship a release signed by ` +
          `it whose config lists both: \`updates: { keys: [old, new] }\`.\n` +
          `      --force overwrites anyway.`,
      );
      Deno.exit(1);
    }
  } catch { /* does not exist — the normal case */ }
  await Deno.mkdir(dirname(out), { recursive: true });
  await Deno.writeTextFile(out, JSON.stringify(pair, null, 2), { mode: 0o600 });
  try {
    await Deno.chmod(out, 0o600); // pre-existing file, or a umask that widened it
  } catch { /* not POSIX — Windows ACLs are the user's */ }
  console.error(
    `ship: ⚠ wrote a PRIVATE release signing key to ${out} (0600).\n` +
      `      Back it up somewhere safe: lose it and no future release can be ` +
      `signed by the key your users already pinned. Never commit it — ` +
      `whoever has it can publish an update every install accepts.\n` +
      `      For CI: \`aio ship keygen --stdout\` pipes the pair into a ` +
      `secret (AIO_SIGNING_KEY), or paste this file's contents.`,
  );
  // stdout is the PUBLIC half only — the part that goes into the app's config,
  // and the only part that is safe to paste anywhere.
  console.log(
    JSON.stringify({ keyPath: out, publicKey: pair.publicKey }, null, 2),
  );
}

/** The usage text — one string, so `--help` and "no argument" agree.
 *  @internal */
export const SHIP_USAGE: string =
  "usage: ship <binary> [--src=DIR] [--name=N] [--version=V] [--key=key.json]\n" +
  "            [--channel=dev|test|prod] [--target=T] [--url=U] [--notes=…]\n" +
  "            [--min-from=X.Y.Z] [--data=contract.json] [--no-data]\n" +
  "            [--out=ship.json] [--allow-dirty]\n" +
  "            [--channel-dir=DIR]   # also write DIR/<channel>/<os>-<arch>.json\n" +
  `       --target: ${UPDATE_TARGETS.join(" | ")}\n` +
  "       --key defaults to ~/.aio/keys/<name>-release-key.json when that file exists\n" +
  "       ship keygen [--out=PATH] [--stdout]   # a fresh Ed25519 " +
  "signing key, written OUTSIDE the repo\n" +
  "       ship github [--channel=prod]   # write a release workflow";

/** `--help`/`-h` anywhere on the line is a QUESTION — answered on stdout,
 *  exit 0. It used to fall into the unknown-flag refusal (exit 1).
 *  @internal */
export function isHelpRequest(args: readonly string[]): boolean {
  return args.some((a) => a === "--help" || a === "-h");
}

if (import.meta.main) {
  const args = Deno.args;
  if (isHelpRequest(args)) {
    console.log(SHIP_USAGE);
    Deno.exit(0);
  }
  // An unrecognized flag is not an error to `args.find(…startsWith("--k="))`:
  // it is ABSENT, and the default silently takes over. `--keys=` publishes an
  // UNSIGNED manifest; `--no-dta` runs the data probe it meant to skip. Both
  // produce a release whose defect surfaces on other people's machines. Same
  // gate the two build entry points have carried since alpha52.
  const strayFlags = unknownShipFlags(args);
  if (strayFlags.length > 0) {
    console.error(
      `ship: \u2717 unknown flag(s): ${strayFlags.join(", ")}\n` +
        `      known: ${flagVocabulary(SHIP_BOOL_FLAGS, SHIP_VALUE_FLAGS)}\n` +
        `      (an unrecognized flag is read as ABSENT, so this would have ` +
        `published a DIFFERENT release than you asked for — unsigned, or ` +
        `without the data contract, or on the default channel.)`,
    );
    Deno.exit(1);
  }
  const bin = args.find((a) => !a.startsWith("--"));
  if (bin === "github" || args.includes("--github")) {
    const channel = args.find((a) => a.startsWith("--channel="))?.slice(10) ??
      "prod";
    const name = args.find((a) => a.startsWith("--name="))?.slice(7) ?? "app";
    const badChannel = safeTokenReason("channel", channel);
    if (badChannel) {
      console.error(`ship: ✗ ${badChannel}`);
      Deno.exit(1);
    }
    const out = ".github/workflows/release.yml";
    await Deno.mkdir(".github/workflows", { recursive: true });
    await Deno.writeTextFile(out, githubWorkflow({ name, channel }));
    console.log(
      `ship: wrote ${out} (channel "${channel}")\n` +
        `  1. aio ship keygen            # writes ~/.aio/keys/<app>-release-key.json\n` +
        `  2. put its CONTENTS in the repo secret AIO_SIGNING_KEY\n` +
        `     (or pipe it straight there: aio ship keygen --stdout)\n` +
        `  3. keep that key file somewhere safe and out of git —\n` +
        `     losing it means no future release can be signed by the key your\n` +
        `     users already pinned, and every install will refuse the update.\n` +
        `     Rotate BEFORE you have to: ship a release signed by the current\n` +
        `     key whose config lists both, \`updates: { keys: [old, new] }\`.\n` +
        `  4. enable Pages once: Settings -> Pages -> Source: GitHub Actions\n` +
        `  5. point the app at the Pages site:\n` +
        `     updates: "https://OWNER.github.io/REPO"\n` +
        `     NOT a release download URL — release assets are flat, so\n` +
        `     .../releases/latest/download/${channel}/<os>-<arch>.json\n` +
        `     does not exist and the app would only ever see "no updates".`,
    );
    Deno.exit(0);
  }
  if (bin === "keygen") {
    await keygenCli(args);
    Deno.exit(0);
  }
  if (!bin) {
    console.error(SHIP_USAGE);
    Deno.exit(1);
  }
  const flag = (k: string) =>
    args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
  // Validated, never cast: `--target=binry` used to sail through as a
  // `UpdateTarget`, producing a correctly signed manifest that every client
  // refuses with "target mismatch" — a typo whose only symptom appears on
  // other people's machines, days later.
  const target = flag("target");
  if (target !== undefined && !isUpdateTarget(target)) {
    console.error(
      `ship: ✗ unknown --target=${target}. One of: ${
        UPDATE_TARGETS.join(", ")
      }.`,
    );
    Deno.exit(1);
  }
  // Every refusal in this file is a written message with a fix in it — and
  // every one of them arrived as `Uncaught (in promise) Error: …` followed by
  // a framework stack, because nothing caught them. The two build entry points
  // print and exit; so does this one. `AIO_DEBUG` keeps the stack for the
  // person debugging `ship` itself.
  let m: ShipManifest;
  try {
    m = await shipApp({
      binaryPath: bin,
      sourceDir: flag("src"),
      name: flag("name"),
      version: flag("version"),
      keyPath: flag("key"),
      out: flag("out"),
      channel: flag("channel"),
      target,
      url: flag("url"),
      notes: flag("notes"),
      minFrom: flag("min-from"),
      dataPath: flag("data"),
      noData: args.includes("--no-data"),
      allowDirty: args.includes("--allow-dirty"),
      channelDir: flag("channel-dir"),
    });
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    if (Deno.env.get("AIO_DEBUG") && e instanceof Error) console.error(e.stack);
    Deno.exit(1);
  }
  console.log(
    `ship: ${m.name} ${m.version}\n` +
      `  channel  ${m.channel}\n` +
      `  target   ${m.target} (${m.platform.os}/${m.platform.arch})\n` +
      `  data     ${
        m.data
          ? `${
            Object.keys(m.data.cells).length
          } cell(s), schema v${m.data.schema}`
          : "NOT DECLARED (--no-data) — installs holding data will refuse " +
            "this release"
      }\n` +
      `  sha256   ${m.sha256}\n` +
      `  run:     ${
        m.runFlags.length ? m.runFlags.join(" ") : "(no perms)"
      }\n` +
      `  ${
        m.signature && m.publicKey
          ? `signed (Ed25519, key ${
            keyFingerprint(m.publicKey)
          }) — name, notes, channel, target and platform are inside the signature`
          : "UNSIGNED — clients refuse this unless the app sets " +
            "`updates: { allowUnsigned: true }`"
      }\n\n` +
      publishInstructions(m, m.url ?? m.name),
  );
}
