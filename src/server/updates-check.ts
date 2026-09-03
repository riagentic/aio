// updates-check.ts — the IO half of updates: talking to a source, and the
// small amount of state an install has to remember about trust.
//
// Kept separate from updates-core.ts so the rules that decide whether a user is
// offered an update stay pure and testable, and everything that can fail for
// boring reasons (DNS, a 500, a half-written file) is in one place with one
// error vocabulary. Nothing here decides anything — it fetches, it verifies,
// it reports.
import { dirname, join } from "@std/path";
// Incremental SHA-256. WebCrypto's digest takes the WHOLE buffer, which is why
// this file used to read a 156 MB AppImage into memory twice; node:crypto's
// hash is a streaming one, and it is the same import the session, user and blob
// stores already use.
import { createHash } from "node:crypto";
import {
  type ShipExpectations,
  type ShipManifest,
  verifyManifestClaims,
} from "../build/ship.ts";
import type { GitHead } from "./updates-core.ts";
import { GIT_NO_PROMPT_ENV } from "./git-noninteractive.ts";

/** What an install remembers between runs. Lives beside the app's data,
 *  inside the backup unit, because losing it silently downgrades security. */
export type TrustStore = {
  /** The signing key this install trusts. Pinned on the first verified
   *  release (TOFU) and required to match forever after. */
  key?: JsonWebKey;
  /** The channel this install follows, once someone chose one explicitly. */
  channel?: string;
  /** Legacy: the last manifest ETag, cached after ANY successful fetch.
   *  No longer read — see `etagCurrent`. Kept in the type so an old trust
   *  file round-trips instead of losing the field on the next write. */
  etag?: string;
  /** The ETag of a manifest whose decision was "you are current".
   *
   *  ONLY that decision may be cached. The old field was written after every
   *  fetch, including one that produced an OFFER: the next check then got a
   *  304, reported `current`, and the cell cleared `available` — the update
   *  went invisible and, because the ETag is on disk, stayed invisible across
   *  every future boot. An unresolved offer must keep re-fetching until it is
   *  installed. (Reading a new field also heals installs whose old `etag` was
   *  poisoned by exactly that bug: it is ignored, so the next check refetches
   *  in full.) */
  etagCurrent?: string;
  /** The commit this build was made from — a git source's "current version". */
  commit?: string;
  /** The SHA-256 of the artifact this install is RUNNING, as verified at the
   *  moment it was staged — never re-hashed from disk, because the file on disk
   *  is the thing whose identity is in question.
   *
   *  Without it, "I republished 1.2.3 with new bytes" is undetectable: the
   *  version compares equal, so the decision is `current` forever. With it, a
   *  manifest for the same version but a different digest is a real offer.
   *  Absent on any install that predates this field — and absence must never
   *  be read as "different", or every old install would be offered its own
   *  build back. */
  installedSha256?: string;
};

const TRUST_FILE = "update-trust.json";

export function trustPath(dataDir: string): string {
  return join(dataDir, TRUST_FILE);
}

/** Read what this install remembers about trust.
 *
 *  A MISSING file is a normal answer (`{}` — a fresh install, trust-on-first-
 *  use ahead). Anything else THROWS. This used to `catch { return {} }`, which
 *  failed open in the worst possible direction: a truncated write, a bad disk
 *  or a hand-edited file silently discarded the pinned signing key, put the
 *  install back into trust-on-first-use, and re-pinned whatever the next host
 *  offered. The app would report itself protected while it was not. */
export function readTrust(dataDir: string): TrustStore {
  const path = trustPath(dataDir);
  let text: string;
  try {
    text = Deno.readTextFileSync(path);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return {};
    throw new Error(
      `[updates] cannot read the update trust file at ${path}: ` +
        `${e instanceof Error ? e.message : e}. Refusing to continue — this ` +
        `file holds the pinned release signing key, and ignoring it would ` +
        `silently re-trust whatever the next release is signed with. Fix: ` +
        `make it readable by the user running this app, or delete it to ` +
        `re-pin deliberately on the next release.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(
      `[updates] the update trust file at ${path} is not valid JSON ` +
        `(${e instanceof Error ? e.message : e}). Refusing to continue — see ` +
        `above. Fix: repair it, or delete it to re-pin the release signing ` +
        `key deliberately on the next release.`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `[updates] the update trust file at ${path} is not an object ` +
        `(got ${Array.isArray(parsed) ? "an array" : typeof parsed}). ` +
        `Refusing to continue. Fix: delete it to re-pin the release signing ` +
        `key deliberately on the next release.`,
    );
  }
  return parsed as TrustStore;
}

/** Merge and persist. Best-effort by design: a read-only home must not stop an
 *  app from running, and the only thing lost is the memory of an ETag. The one
 *  exception is the KEY — see pinKey. */
export function writeTrust(dataDir: string, patch: Partial<TrustStore>): void {
  try {
    const next = { ...readTrust(dataDir), ...patch };
    Deno.writeTextFileSync(trustPath(dataDir), JSON.stringify(next, null, 2));
  } catch { /* best-effort */ }
}

/** Remember the digest of the artifact that was just installed.
 *
 *  Called with the digest that was VERIFIED during the swap, never one re-read
 *  from the installed file: re-hashing after the fact would happily record
 *  whatever ended up there. */
export function recordInstalledSha256(dataDir: string, sha256: string): void {
  writeTrust(dataDir, { installedSha256: sha256 });
}

/** Does this URL's transport authenticate the HOST it came from?
 *
 *  `https:` does (a certificate), `file:` does (there is no network), and
 *  loopback `http:` does (the bytes never leave the machine — the same reason
 *  browsers treat 127.0.0.1 as a secure context). Plain `http:` to anywhere
 *  else does not: anyone on the path chooses what the manifest says.
 *
 *  This is the ONE decider for "may a key be pinned from here". */
export function transportAuthenticatesHost(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol === "https:" || u.protocol === "file:") return true;
  if (u.protocol !== "http:") return false;
  const h = u.hostname.replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "::1" || /^127\./.test(h);
}

/** Pin the trusted signing key on first use.
 *
 *  `from` is the URL the key was learned from, and it is checked before
 *  anything is written: trust-on-first-use over plain `http:` pins whatever the
 *  first person on the network path decided to hand over, and then requires
 *  every genuine release forever after to match it. Refusing is the only
 *  honest answer.
 *
 *  Throws if it cannot be written. Every other piece of this file degrades
 *  quietly, but a key that was "pinned" only in memory means the NEXT run
 *  trusts whatever it is handed — the app would believe it was protected while
 *  it was not, which is worse than knowing it is unprotected. */
export function pinKey(
  dataDir: string,
  key: JsonWebKey,
  from?: string,
): void {
  if (from !== undefined && !transportAuthenticatesHost(from)) {
    throw new Error(
      `[updates] refusing to trust a release signing key learned over an ` +
        `unauthenticated transport (${from}): anyone on the network path ` +
        `could have chosen it, and it would then be required forever. ` +
        `Fix, any one of: serve the manifest over https, pin the key ` +
        `explicitly with \`updates: { key }\`, or accept unsigned releases ` +
        `with \`updates: { allowUnsigned: true }\`.`,
    );
  }
  const next = { ...readTrust(dataDir), key };
  try {
    Deno.writeTextFileSync(trustPath(dataDir), JSON.stringify(next, null, 2));
  } catch (e) {
    throw new Error(
      `[updates] cannot pin the release signing key at ${
        trustPath(dataDir)
      }: ` +
        `${e}. Refusing to continue — an unpinnable key means every future ` +
        `release would be trusted on sight.`,
    );
  }
}

/** Cache the ETag of a manifest whose decision was "you are current".
 *
 *  A DISMISSAL also produces `current` — and caching that ETag is how "Not
 *  now" turned into "you are the latest" forever: the next check sends
 *  `if-none-match`, gets a 304, and the release the user postponed can never be
 *  offered again, on this or any later boot. A dismissal is a decision about a
 *  release the client has SEEN, not evidence that nothing is there. */
export function cacheCurrentEtag(
  dataDir: string,
  etag: string | undefined,
  opts: { dismissed: boolean },
): void {
  if (!etag || opts.dismissed) return;
  writeTrust(dataDir, { etagCurrent: etag });
}

// ── fetching ────────────────────────────────────────────────────────────────

export type ManifestFetch =
  | { kind: "not-modified" }
  | {
    kind: "ok";
    manifest: ShipManifest;
    etag?: string;
    /** Whether a key learned from this manifest may be PINNED — see
     *  `transportAuthenticatesHost`. The artifact may still be fetched over
     *  plain http once a key is pinned: the signed digest carries integrity. */
    pinnable: boolean;
  }
  | { kind: "error"; error: string };

/** A manifest is a few hundred bytes. Anything approaching a megabyte is a
 *  login page, an error document, or a host that decided to hand back a DVD —
 *  and `res.text()` would buffer all of it before anyone could object. */
const MANIFEST_MAX_BYTES = 1_000_000;

/** Is this actually a ship manifest, or just an object that reached us?
 *
 *  Checked rather than cast, because it USED to be cast: four of seven
 *  malformed bodies reached the user as a raw `TypeError` from deep inside the
 *  decision code ("Cannot read properties of undefined (reading 'os')"), which
 *  names neither the manifest nor the field. Every field validated here is one
 *  the client goes on to decide with. */
export function isShipManifest(m: unknown): m is ShipManifest {
  return manifestProblem(m) === null;
}

/** What is wrong with it, naming the field — "malformed" alone sends someone
 *  to read a manifest by hand. Returns null when nothing is wrong. */
function manifestProblem(m: unknown): string | null {
  if (typeof m !== "object" || m === null || Array.isArray(m)) {
    const what = m === null ? "null" : Array.isArray(m) ? "an array" : typeof m;
    return `it is ${what}, not an object`;
  }
  const o = m as Record<string, unknown>;
  const str = (k: string): string | null =>
    typeof o[k] === "string" && (o[k] as string).length > 0
      ? null
      : `\`${k}\` is ${o[k] === undefined ? "missing" : typeof o[k]}`;

  if (typeof o.manifestVersion !== "number") {
    return `\`manifestVersion\` is ${
      o.manifestVersion === undefined ? "missing" : typeof o.manifestVersion
    }`;
  }
  for (const k of ["name", "version", "channel", "target", "releasedAt"]) {
    const bad = str(k);
    if (bad) return bad;
  }
  if (typeof o.sha256 !== "string" || !/^[0-9a-f]{64}$/i.test(o.sha256)) {
    return "`sha256` is not a 64-character hex digest";
  }
  if (
    typeof o.size !== "number" || !Number.isFinite(o.size) || o.size < 0 ||
    !Number.isInteger(o.size)
  ) {
    return "`size` is not a byte count";
  }
  const p = o.platform;
  if (typeof p !== "object" || p === null) {
    return `\`platform\` is ${p === undefined ? "missing" : typeof p}`;
  }
  const plat = p as Record<string, unknown>;
  if (typeof plat.os !== "string" || typeof plat.arch !== "string") {
    return "`platform` has no `os`/`arch` pair";
  }
  if (o.url !== undefined && typeof o.url !== "string") {
    return `\`url\` is ${typeof o.url}, not a string`;
  }
  if (o.notes !== undefined && typeof o.notes !== "string") {
    return `\`notes\` is ${typeof o.notes}, not a string`;
  }
  if (o.minFrom !== undefined && typeof o.minFrom !== "string") {
    return `\`minFrom\` is ${typeof o.minFrom}, not a string`;
  }
  if (o.signature !== undefined && typeof o.signature !== "string") {
    return `\`signature\` is ${typeof o.signature}, not a string`;
  }
  if (
    o.publicKey !== undefined &&
    (typeof o.publicKey !== "object" || o.publicKey === null)
  ) {
    return `\`publicKey\` is ${typeof o.publicKey}, not a JWK`;
  }
  if (o.data !== undefined && (typeof o.data !== "object" || o.data === null)) {
    return `\`data\` is ${typeof o.data}, not a data contract`;
  }
  if (
    o.buildNumber !== undefined &&
    (typeof o.buildNumber !== "number" || !Number.isInteger(o.buildNumber) ||
      o.buildNumber < 0)
  ) {
    return `\`buildNumber\` is ${
      JSON.stringify(o.buildNumber)
    }, not a build number`;
  }
  if (
    o.commit !== undefined && o.commit !== null && typeof o.commit !== "string"
  ) {
    return `\`commit\` is ${typeof o.commit}, not a commit sha`;
  }
  return null;
}

/** Parse a manifest body. The ONE place a manifest becomes a typed value —
 *  never a cast, so a malformed release is a sentence naming the field rather
 *  than a TypeError from three layers down. */
export function parseShipManifest(
  text: string,
  source: string,
): { ok: true; manifest: ShipManifest } | { ok: false; error: string } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    // A proxy login page or an S3 error document is HTML, and "unexpected
    // token <" tells nobody where to look.
    return {
      ok: false,
      error: `${source} did not return a release manifest (got ${
        text.slice(0, 40).replace(/\s+/g, " ")
      }…)`,
    };
  }
  const problem = manifestProblem(value);
  if (problem) {
    return {
      ok: false,
      error: `${source} is not a valid release manifest: ${problem}. ` +
        `Re-publish it with \`aio ship\`.`,
    };
  }
  return { ok: true, manifest: value as ShipManifest };
}

/** Do two URLs come from the same place? Protocol AND host AND port — an
 *  https manifest pointing at an http artifact is a downgrade, not a detail.
 *  `file:` URLs have no host, so the protocol matching is the whole test. */
export function sameOrigin(a: string, b: string): boolean {
  try {
    const x = new URL(a), y = new URL(b);
    if (x.protocol !== y.protocol) return false;
    if (x.protocol === "file:") return true;
    return x.host === y.host;
  } catch {
    return false;
  }
}

/** Read a response body with a hard ceiling, so a hostile or broken host
 *  cannot make the client buffer whatever it feels like sending. */
async function readCapped(
  res: Response,
  max: number,
  url: string,
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > max) {
    await res.body?.cancel();
    return {
      ok: false,
      error: `${url} declared ${declared} bytes, more than the ${max}-byte ` +
        `limit for a release manifest — refusing to download it`,
    };
  }
  if (!res.body) return { ok: true, text: "" };
  const chunks: Uint8Array[] = [];
  let seen = 0;
  // Returning out of the `for await` cancels the stream (the iterator's
  // `return()` does it) — an explicit cancel here would throw, because the
  // iteration holds the lock.
  for await (const chunk of res.body) {
    seen += chunk.length;
    if (seen > max) {
      return {
        ok: false,
        error: `${url} sent more than ${max} bytes for a release ` +
          `manifest — refusing to buffer it`,
      };
    }
    chunks.push(chunk);
  }
  const all = new Uint8Array(seen);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.length;
  }
  return { ok: true, text: new TextDecoder().decode(all) };
}

/** Fetch and parse a manifest. `file:` URLs skip conditional requests — there
 *  is no ETag on a filesystem, and re-reading a local file costs nothing. */
export async function fetchManifest(
  url: string,
  etag?: string,
  opts?: {
    /** Allow `manifest.url` to point at another host. Off by default: a
     *  manifest that verifies says nothing about a host it merely names. */
    allowCrossOrigin?: boolean;
  },
): Promise<ManifestFetch> {
  try {
    const isFile = url.startsWith("file:");
    const res = await fetch(url, {
      headers: !isFile && etag ? { "if-none-match": etag } : undefined,
      redirect: "follow",
    });
    if (res.status === 304) {
      await res.body?.cancel();
      return { kind: "not-modified" };
    }
    if (!res.ok) {
      await res.body?.cancel();
      return {
        kind: "error",
        error: `${res.status} ${res.statusText} from ${url}`,
      };
    }
    const body = await readCapped(res, MANIFEST_MAX_BYTES, url);
    if (!body.ok) return { kind: "error", error: body.error };
    const parsed = parseShipManifest(body.text, url);
    if (!parsed.ok) return { kind: "error", error: parsed.error };

    // Where the artifact lives is resolved against the manifest's own URL, so
    // a relative `url` is always same-origin. An ABSOLUTE one need not be —
    // and a signed manifest authenticates its own contents, not a third host
    // it happens to name.
    const artifact = new URL(parsed.manifest.url ?? "", url).href;
    if (!opts?.allowCrossOrigin && !sameOrigin(artifact, url)) {
      return {
        kind: "error",
        error: `${url} points its artifact at a different host ` +
          `(${new URL(artifact).host || new URL(artifact).protocol}) — ` +
          `refusing to download from it. Fix: publish the artifact beside ` +
          `the manifest, or opt in with ` +
          `\`updates: { allowCrossOrigin: true }\`.`,
      };
    }
    return {
      kind: "ok",
      manifest: parsed.manifest,
      etag: res.headers.get("etag") ?? undefined,
      pinnable: transportAuthenticatesHost(url),
    };
  } catch (e) {
    return {
      kind: "error",
      error: `${url}: ${e instanceof Error ? e.message : e}`,
    };
  }
}

// ── downloading ─────────────────────────────────────────────────────────────

/** Can this directory be written by the user running the app?
 *
 *  Asked BEFORE an update is offered, not after 156 MB have been downloaded:
 *  a binary in `/usr/local/bin` running as a normal user is the ordinary case,
 *  and EACCES at the end of a download is the worst moment to learn it. */
export async function ensureWritable(
  dir: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const probe = await Deno.makeTempFile({ dir, prefix: ".aio-write-" });
    await Deno.remove(probe).catch(() => {});
    return { ok: true };
  } catch (e) {
    const why = e instanceof Deno.errors.NotFound
      ? `it does not exist`
      : e instanceof Deno.errors.PermissionDenied
      ? `it is not writable — run as the user who owns ${dir}, or install ` +
        `somewhere that user owns`
      : e instanceof Error
      ? e.message
      : String(e);
    return {
      ok: false,
      error: `cannot stage an update in ${dir}: ${why}`,
    };
  }
}

/** Bytes free on the filesystem holding `dir`, or null when the platform will
 *  not say. Null means "unknown", and an unknown is not a refusal — the
 *  download itself still fails loudly on ENOSPC. */
export async function freeSpace(dir: string): Promise<number | null> {
  try {
    const { statfs } = await import("node:fs/promises");
    const s = await statfs(dir);
    return Number(s.bsize) * Number(s.bavail);
  } catch {
    return null;
  }
}

/** Write a whole chunk. `file.write()` returns how much it actually took, and
 *  ignoring that is how a large artifact ends up silently truncated. */
async function writeAll(file: Deno.FsFile, data: Uint8Array): Promise<void> {
  let at = 0;
  while (at < data.length) {
    const n = await file.write(data.subarray(at));
    if (n <= 0) {
      throw new Error(
        `short write staging the artifact (${at}/${data.length})`,
      );
    }
    at += n;
  }
}

/** Sizes a human can act on: bytes while they are countable, MB once they
 *  are not. "0.0 MB" told a test author nothing about a 15-byte artifact. */
const MB = (n: number) =>
  n < 1_000_000 ? `${n} bytes` : `${(n / 1_000_000).toFixed(1)} MB`;

/** Download an artifact, verifying its size and digest as the bytes arrive.
 *
 *  The file is written into a 0700 staging directory beside the destination —
 *  same filesystem, so the later rename is atomic, and `createNew` so a
 *  symlink someone planted at the predictable `<app>.new-<version>` path is
 *  never followed. The digest is computed INCREMENTALLY: the previous version
 *  read the whole artifact back into memory and hashed it twice, which for a
 *  156 MB AppImage is 312 MB of peak heap for a value that could be had for
 *  free on the way past.
 *
 *  Removes everything it staged on any failure — a half-downloaded file left
 *  beside a binary is the kind of thing a later boot mistakes for a staged
 *  update. */
export async function downloadArtifact(opts: {
  url: string;
  /** Where the verified artifact ends up (a sibling of the install target). */
  dest: string;
  expectSha256: string;
  /** REQUIRED. The manifest states the size, it is inside the signature, and
   *  it is the only thing that bounds how much a host can make a client
   *  write to its disk. */
  expectSize: number;
  /** The manifest this artifact came from, when the caller has it: the
   *  artifact must come from the same host unless `allowCrossOrigin`. */
  manifestUrl?: string;
  allowCrossOrigin?: boolean;
  /** Leave the file inside the 0700 staging directory and return its path,
   *  instead of renaming it to `dest`. For a caller that wants to verify and
   *  rename the SAME file with no window in between. */
  keepStaged?: boolean;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  if (
    !Number.isInteger(opts.expectSize) || opts.expectSize <= 0
  ) {
    return {
      ok: false,
      error: `refusing to download ${opts.url}: the manifest states no size ` +
        `(${opts.expectSize}), so nothing bounds how much it may write to ` +
        `this disk. Re-publish the release with \`aio ship\`.`,
    };
  }
  if (
    opts.manifestUrl && !opts.allowCrossOrigin &&
    !sameOrigin(opts.url, opts.manifestUrl)
  ) {
    return {
      ok: false,
      error: `the artifact at ${opts.url} is on a different host than its ` +
        `manifest (${opts.manifestUrl}) — refusing to download it. Fix: ` +
        `publish the artifact beside the manifest, or opt in with ` +
        `\`updates: { allowCrossOrigin: true }\`.`,
    };
  }

  const parent = dirname(opts.dest);
  const writable = await ensureWritable(parent);
  if (!writable.ok) return { ok: false, error: writable.error };

  const free = await freeSpace(parent);
  if (free !== null && free < opts.expectSize) {
    return {
      ok: false,
      error:
        `not enough space in ${parent} for ${MB(opts.expectSize)}: only ${
          MB(free)
        } free. Fix: free some space, or install this app ` +
        `on a filesystem that has room.`,
    };
  }

  // 0700 and freshly made: whatever is at `dest` right now cannot influence
  // where the bytes land, and no other user can read a half-written artifact
  // or swap it for their own.
  const stage = join(parent, `.aio-update-${crypto.randomUUID().slice(0, 8)}`);
  await Deno.mkdir(stage, { recursive: false, mode: 0o700 });
  const staged = join(stage, "artifact");
  let done = false;
  try {
    const res = await fetch(opts.url, {
      redirect: "follow",
      signal: opts.signal,
    });
    if (!res.ok || !res.body) {
      await res.body?.cancel();
      return {
        ok: false,
        error: `${res.status} ${res.statusText} from ${opts.url}`,
      };
    }
    const hash = createHash("sha256");
    let seen = 0;
    const file = await Deno.open(staged, { createNew: true, write: true });
    try {
      for await (const chunk of res.body) {
        seen += chunk.length;
        if (seen > opts.expectSize) {
          // Returning cancels the stream; see readCapped.
          return {
            ok: false,
            error: `${opts.url} is sending more than the ${
              MB(opts.expectSize)
            } the manifest promised (${MB(seen)} and counting) — aborted`,
          };
        }
        hash.update(chunk);
        await writeAll(file, chunk);
        opts.onProgress?.(Math.min(1, seen / opts.expectSize));
      }
      // The rename below publishes a NAME. Without this, a power cut between
      // the two can leave that name pointing at a file whose contents were
      // never written — and the digest that proved it good was checked
      // against bytes that only ever existed in the page cache.
      await file.sync();
    } finally {
      file.close();
    }

    if (seen !== opts.expectSize) {
      return {
        ok: false,
        error:
          `${opts.url} sent ${MB(seen)}, but the manifest promises ${
            MB(opts.expectSize)
          } — it does not match the manifest, and a truncated artifact is ` +
          `never installed`,
      };
    }
    const sha = hash.digest("hex");
    if (sha !== opts.expectSha256) {
      return {
        ok: false,
        error: `downloaded artifact does not match the manifest (sha256 ${
          sha.slice(0, 12)
        }… vs ${opts.expectSha256.slice(0, 12)}…) — refusing to install it`,
      };
    }
    if (opts.keepStaged) {
      done = true;
      return { ok: true, path: staged };
    }
    // Same filesystem (the staging dir is a sibling), so this is atomic — and
    // it REPLACES anything at `dest`, including a symlink, rather than
    // writing through it.
    await Deno.rename(staged, opts.dest);
    return { ok: true, path: opts.dest };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    if (!done) await Deno.remove(stage, { recursive: true }).catch(() => {});
  }
}

/** Verify a downloaded artifact against its manifest and this install's
 *  expectations. A thin pass-through, but it is the ONE place an applier is
 *  allowed to call, so the verification cannot be skipped by forgetting it.
 *
 *  Spelled out here rather than calling `verifyShipManifest` because that one
 *  takes the whole artifact as a `Uint8Array`: an update's digest check must
 *  not cost as much RAM as the release is big. */
export async function verifyDownload(
  path: string,
  manifest: ShipManifest,
  expect: ShipExpectations,
): Promise<{ ok: boolean; reason: string }> {
  const claims = await verifyManifestClaims(manifest, expect);
  if (!claims.ok) return claims;
  const sha256 = await fileSha256(path);
  if (sha256 !== manifest.sha256) {
    return {
      ok: false,
      reason: "sha256 mismatch — binary does not match manifest",
    };
  }
  return { ok: true, reason: `sha256 + ${claims.reason}` };
}

/** Streaming SHA-256 of a file — constant memory, whatever the artifact. */
export async function fileSha256(path: string): Promise<string> {
  const file = await Deno.open(path, { read: true });
  const hash = createHash("sha256");
  // `file.readable` closes the handle when it ends OR when it is cancelled by
  // an abrupt exit from this loop — there is no close() to forget.
  for await (const chunk of file.readable) hash.update(chunk);
  return hash.digest("hex");
}

// ── git sources ─────────────────────────────────────────────────────────────

/** Ask a remote where a ref points, without cloning anything.
 *
 *  `git ls-remote` is one round trip and works identically for GitHub, GitLab,
 *  a bare repo on a NAS, and a local path — which is the whole reason a git
 *  source can be treated like any other source. */
export async function gitLsRemote(
  source: string,
  ref: string,
): Promise<{ ok: true; head: GitHead } | { ok: false; error: string }> {
  try {
    const cmd = new Deno.Command("git", {
      // `--` first: both the source and the ref come from config or a
      // manifest, and `git` would otherwise read a ref named
      // `--upload-pack=…` as an option and run it.
      //
      // `<ref>^{}` asks for the DEREFERENCED object as well. An annotated tag
      // points at a tag object, not a commit, while the rebuild records
      // `rev-parse HEAD` (the commit) — so without this the two never agree
      // and the same tag is offered as "new" forever.
      args: ["ls-remote", "--exit-code", "--", source, ref, `${ref}^{}`],
      stdout: "piped",
      stderr: "piped",
      stdin: "null",
      env: GIT_NO_PROMPT_ENV,
    });
    const out = await cmd.output();
    if (!out.success) {
      const err = new TextDecoder().decode(out.stderr).trim();
      return {
        ok: false,
        error: err ||
          `git ls-remote found no ref "${ref}" in ${source} — check the ` +
            `branch or tag name`,
      };
    }
    const lines = new TextDecoder().decode(out.stdout).trim().split("\n")
      .filter(Boolean)
      .map((l) => {
        const [sha = "", name = ""] = l.split(/\s+/);
        return { sha, name };
      });
    // The dereferenced entry wins when it is there; it is the commit.
    const picked = lines.find((l) => l.name.endsWith("^{}")) ?? lines[0];
    const sha = picked?.sha ?? "";
    if (!/^[0-9a-f]{40}$/.test(sha)) {
      return {
        ok: false,
        error: `unexpected git ls-remote output: "${
          lines.map((l) => `${l.sha} ${l.name}`).join(" / ") || ""
        }"`,
      };
    }
    return { ok: true, head: { sha, ref } };
  } catch (e) {
    // The most common cause by far, and the least obvious from a raw ENOENT.
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      error: /No such file|not found|os error 2/i.test(msg)
        ? `git is not installed or not on PATH — a git update source needs it`
        : msg,
    };
  }
}

/** The commit this build came from, if anything recorded it.
 *
 *  Checked in order: what the trust store remembers (written at install), then
 *  the environment the one-line runner sets. Absent is a normal answer — a
 *  binary downloaded from a release page has no commit — and the caller turns
 *  it into a refusal that explains itself rather than a silent no-op. */
export function currentCommit(dataDir: string): string | null {
  const stored = readTrust(dataDir).commit;
  if (stored) return stored;
  return Deno.env.get("AIO_BUILD_COMMIT") ?? null;
}
