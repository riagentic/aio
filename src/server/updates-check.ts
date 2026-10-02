// updates-check.ts — the IO half of updates: talking to a source, and the
// small amount of state an install has to remember about trust.
//
// Kept separate from updates-core.ts so the rules that decide whether a user is
// offered an update stay pure and testable, and everything that can fail for
// boring reasons (DNS, a 500, a half-written file) is in one place with one
// error vocabulary. Nothing here decides anything — it fetches, it verifies,
// it reports.
import { basename, dirname, join } from "@std/path";
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
import type { InstalledTarget } from "./updates-apply.ts";
import { gitOwnRepoEnv } from "./git-noninteractive.ts";
import { neutralCwd, outlivingParent } from "./no-console.ts";
import {
  identity,
  made,
  OLD_STAGE_AGE_MS,
  record,
  sumOf,
} from "./updates-owned.ts";
import { moveFile, renameOverSync } from "../diagnostics/rename-over.ts";
import { DOWNLOAD_STALL_MS } from "../electron/electron-runtime-fetch.ts";

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
  /** WHAT `etagCurrent` was a verdict about: the running version and the
   *  manifest URL it was judged against. "You are current" is a fact about
   *  THIS install and THIS channel, not about the manifest alone — an older
   *  binary started on the same data dir (a downgrade, a second copy, a
   *  reinstall) sent the newer install's validator, got a 304, and was told
   *  it was the latest while a newer release sat in the manifest. A cached
   *  tag is sent only when both still match; one without this (written
   *  before it existed) is not sent at all, so the next check refetches. */
  etagCurrentFor?: { version: string; url: string; prerelease?: boolean };
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
  /** The signed `releasedAt` of the release `installedSha256` came from —
   *  what tells an older build of the same version from a newer one. */
  installedReleasedAt?: string;
  /** How many times in a row the swap of release `to` could not be made on
   *  this machine (the running version could not be moved, the helper could
   *  not start). Such a release never ran, so it is offered again — and this
   *  count is what stops that from going on for ever. */
  failedSwaps?: { to: string; count: number };
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

/** Replace the trust file ATOMICALLY: temp file, fsync, rename — the shape
 *  `writePending` uses. It is rewritten on every routine "you are current"
 *  check, and `readTrust` refuses a file it cannot parse (boot reads it), so a
 *  crash inside an in-place write stopped the app from starting over a cache
 *  field. Interrupted, this leaves the previous file whole. */
function writeTrustFile(path: string, next: TrustStore): void {
  const tmp = `${path}.tmp-${Deno.pid}`;
  try {
    Deno.writeTextFileSync(tmp, JSON.stringify(next, null, 2));
    const f = Deno.openSync(tmp, { write: true });
    try {
      f.syncSync();
    } finally {
      f.close();
    }
    renameOverSync(tmp, path);
  } catch (e) {
    try {
      Deno.removeSync(tmp);
    } catch { /* aio-ok: never written, or already renamed */ }
    throw e;
  }
}

/** Merge and persist. Best-effort by design: a read-only home must not stop an
 *  app from running, and the only thing lost is the memory of an ETag. The one
 *  exception is the KEY — see pinKey. */
export function writeTrust(dataDir: string, patch: Partial<TrustStore>): void {
  try {
    writeTrustFile(trustPath(dataDir), { ...readTrust(dataDir), ...patch });
  } catch { /* best-effort */ }
}

/** Remember the digest of the artifact that was just installed.
 *
 *  Called with the digest that was VERIFIED during the swap, never one re-read
 *  from the installed file: re-hashing after the fact would happily record
 *  whatever ended up there. */
export function recordInstalledSha256(
  dataDir: string,
  sha256: string,
  /** The verified manifest's `releasedAt`; absent (a digest measured from
   *  disk) clears any earlier one, which described another artifact. */
  releasedAt?: string,
): void {
  writeTrust(dataDir, {
    installedSha256: sha256,
    installedReleasedAt: releasedAt,
  });
}

/** The build the digest described is no longer the one installed (it was put
 *  back, or never went in): forget the digest AND its release time. The time
 *  alone was left behind, naming a release that was not running. */
export function forgetInstalledDigest(dataDir: string): void {
  writeTrust(dataDir, {
    installedSha256: undefined,
    installedReleasedAt: undefined,
  });
}

/** Does this URL's transport authenticate the HOST it came from?
 *
 *  `https:` does (a certificate), `file:` does (there is no network), and
 *  loopback `http:` does (the bytes never leave the machine — the same reason
 *  browsers treat 127.0.0.1 as a secure context). Plain `http:` to anywhere
 *  else does not: anyone on the path chooses what the manifest says.
 *
 *  This is the ONE decider for "may a key be pinned from here".
 *
 *  @decider */
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
  // A LITERAL loopback address only: `127.attacker.example` is a DNS name that
  // resolves wherever its owner says, so a `127.` prefix proves nothing.
  return h === "localhost" || h === "::1" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
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
    writeTrustFile(trustPath(dataDir), next);
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
    /** The URL `pinnable` was judged by — the first redirect hop whose
     *  transport does not authenticate its host, else the last one. What
     *  `pinKey` is handed as `from`. */
    pinFrom: string;
  }
  | {
    kind: "error";
    error: string;
    /** Set when the URL simply gave no manifest, so a caller with another
     *  URL to read may read it: `no-such-file` — the host said so (404, 410);
     *  `this-time` — any other status, or a host that could not be reached.
     *  Never for a timeout (the host said nothing) or a body that was served
     *  and is wrong. */
    absent?: "no-such-file" | "this-time";
  };

/** A manifest is a few hundred bytes. Anything approaching a megabyte is a
 *  login page, an error document, or a host that decided to hand back a DVD —
 *  and `res.text()` would buffer all of it before anyone could object. */
const MANIFEST_MAX_BYTES = 1_000_000;

/** Redirect hops a manifest fetch follows — fetch's own `follow` limit. */
const MAX_REDIRECTS = 20;

/** A whole manifest fetch — every hop plus the body — must answer within this.
 *  `fetch` has no timeout of its own: a release host that accepted the
 *  connection and then said nothing (a stalled proxy, a captive portal, a
 *  half-open link) hung the check FOREVER — the cell sat on "checking", and
 *  the poll, which re-arms only after a check returns, never ran again. */
const MANIFEST_TIMEOUT_MS = 30_000;

/** An artifact download may be slow, never silent: no byte for this long
 *  aborts it. A total cap would refuse a large build on a slow link; an idle
 *  cap only refuses a download that stopped. Without one a stalled download
 *  held the cell on "downloading" for the life of the process — and every
 *  later check refuses while an install is in flight. The same idle cap the
 *  Electron runtime download uses — one fact, one home. */

/** `git ls-remote` is one round trip; a minute of silence is a stalled remote. */
const GIT_LS_REMOTE_TIMEOUT_MS = 60_000;

/** "no answer in Ns" for a timeout abort, the message otherwise. */
function fetchFailure(e: unknown, url: string, ms: number): string {
  if (e instanceof DOMException && e.name === "TimeoutError") {
    return `${url} did not answer within ${ms / 1000}s — the release host ` +
      `is unreachable or stalled; the next check tries again`;
  }
  return e instanceof Error ? e.message : String(e);
}

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

/** The ordinary "this channel has nothing" refusal — shared by HTTP 404 and
 *  a file:// ENOENT so both mouths say the same thing.
 *
 *  Raw status / OS wording reads as a transport fault; naming the missing
 *  release is what the operator can act on, and what keeps a mistyped channel
 *  from looking like "you are up to date". */
function missingManifestError(url: string, detail: string): string {
  return `no release manifest at ${url} — ${detail}. Publish to this ` +
    `channel (aio ship), or point updates.source / the channel name at one ` +
    `that has a release.`;
}

/** The kind-specific manifest beside a platform's `<os>-<arch>.json`:
 *  `<os>-<arch>.<kind>.json` (`kindManifestFileName` in ship.ts, pinned by a
 *  test). Pure. */
export function kindManifestUrl(platformUrl: string, kind: string): string {
  return platformUrl.replace(/\.json$/, () => `.${kind}.json`);
}

/** How long a channel's "no kind manifest" answer is believed — a day, so a
 *  channel that starts publishing one is read by a running install too. */
const KIND_ABSENT_MS = 24 * 60 * 60 * 1000;
const kindAbsentUntil = new Map<string, number>();

/** Fetch the manifest THIS install reads — ONE request per check.
 *
 *  A platform can publish two install kinds — Windows Electron's
 *  self-contained `.exe` (`binary`, the platform's own manifest) and the
 *  `.zip` (`electron-zip`). An install unpacked from the zip refuses the
 *  `.exe`'s release, so it reads `<os>-<arch>.electron-zip.json` when the
 *  channel serves one, and the platform's manifest otherwise — exactly what
 *  it read before the kind manifest existed, so a channel without one, or one
 *  that cannot be reached, behaves as it always did. Every other install kind
 *  reads the platform's manifest.
 *
 *  The kind manifest is FETCHED, not probed for: a probe followed by the
 *  fetch asked a channel that has one twice on every poll, for good. A second
 *  request is made only when the first found no kind manifest.
 *
 *  A kind fetch that TIMES OUT fails the check — the channel said nothing,
 *  which is not "absent", and reading the platform's manifest on it offered a
 *  zip install the `.exe` it refuses; it also spares an unreachable host a
 *  second full wait. Only a 404 or 410 — the channel saying "no such file" —
 *  is believed for `KIND_ABSENT_MS`; any other status (a 403 of a private
 *  bucket, a 429, a 5xx) reads the platform's manifest this time and asks
 *  again next check. `etagFor` is the cached validator for a URL, if any. */
export async function fetchInstallManifest(
  platformUrl: string,
  installed: InstalledTarget,
  etagFor: (url: string) => string | undefined = () => undefined,
  timeoutMs?: number,
): Promise<{ url: string; got: ManifestFetch }> {
  const read = async (url: string) => ({
    url,
    got: await fetchManifest(url, etagFor(url), { timeoutMs }),
  });
  if (installed !== "electron-zip") return read(platformUrl);
  const kind = kindManifestUrl(platformUrl, installed);
  if ((kindAbsentUntil.get(kind) ?? 0) > Date.now()) return read(platformUrl);
  const own = await read(kind);
  if (own.got.kind !== "error" || !own.got.absent) return own;
  if (own.got.absent === "no-such-file") {
    kindAbsentUntil.set(kind, Date.now() + KIND_ABSENT_MS);
  }
  return read(platformUrl);
}

/** Fetch and parse a manifest. `file:` URLs skip conditional requests — there
 *  is no ETag on a filesystem, and re-reading a local file costs nothing. */
export async function fetchManifest(
  url: string,
  etag?: string,
  opts?: {
    /** Allow `manifest.url` to point at another host. Off by default: a
     *  manifest that verifies says nothing about a host it merely names.
     *
     *  INTERNAL — a caller's argument, NOT a config key. It is not on
     *  `UpdatesConfig` and not in `VALID_UPDATES_KEYS`, so `updates:
     *  { allowCrossOrigin: true }` is refused at boot as an unknown key. The
     *  refusal above used to name that spelling as the way out, which was
     *  inert while the nested walk skipped `updates` and boot-fatal once it
     *  did not. Naming it in a user-facing message again needs it to become a
     *  real config key first — a security opt-in, and a decision, not a
     *  wording change. */
    allowCrossOrigin?: boolean;
    /** Test seam: the whole-fetch deadline (default `MANIFEST_TIMEOUT_MS`). */
    timeoutMs?: number;
  },
): Promise<ManifestFetch> {
  const isFile = url.startsWith("file:");
  const timeoutMs = opts?.timeoutMs ?? MANIFEST_TIMEOUT_MS;
  // ONE deadline for every hop and the body: it rides into `readCapped`
  // through the response, so a host that sends headers and then stalls the
  // body is cut off too.
  const signal = AbortSignal.timeout(timeoutMs);
  // Whether the host answered at all — see `ManifestFetch`'s `absent`.
  let answered = false;
  try {
    // Redirects are followed BY HAND, so every hop's transport is seen: a key
    // may be pinned only if EACH leg authenticated its host. Judging the
    // configured URL alone pinned whatever a downgrading mirror's plain-http
    // leg carried — the URL judged was not the one that served the body.
    let at = url;
    let pinFrom = url;
    let res: Response;
    for (let hop = 0;; hop++) {
      res = await fetch(at, {
        headers: !isFile && etag ? { "if-none-match": etag } : undefined,
        redirect: "manual",
        signal,
      });
      const next = res.headers.get("location");
      if (res.status < 300 || res.status > 399 || res.status === 304 || !next) {
        break;
      }
      await res.body?.cancel();
      if (hop >= MAX_REDIRECTS) {
        return {
          kind: "error",
          error: `${url} redirected more than ${MAX_REDIRECTS} times`,
        };
      }
      at = new URL(next, at).href;
      if (transportAuthenticatesHost(pinFrom)) pinFrom = at;
    }
    answered = true;
    if (res.status === 304) {
      await res.body?.cancel();
      return { kind: "not-modified" };
    }
    if (!res.ok) {
      await res.body?.cancel();
      // A missing channel (or a mistyped source) is the ordinary failure mode
      // of `updates.check()`, and `404 … from <url>` reads as a transport
      // fault. Name the fact: there is no release at this channel path. That
      // is also what keeps "no update available" from looking the same as
      // "your release URL is wrong".
      if (res.status === 404) {
        return {
          kind: "error",
          error: missingManifestError(url, "HTTP 404"),
          absent: "no-such-file",
        };
      }
      return {
        kind: "error",
        error: `${res.status} ${res.statusText} from ${url}`,
        absent: res.status === 410 ? "no-such-file" : "this-time",
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
          `the manifest (a relative \`url\` in the manifest is always ` +
          `same-origin), or point \`updates.source\` at the host that ` +
          `serves both.`,
      };
    }
    return {
      kind: "ok",
      manifest: parsed.manifest,
      etag: res.headers.get("etag") ?? undefined,
      pinnable: transportAuthenticatesHost(pinFrom),
      pinFrom,
    };
  } catch (e) {
    const msg = fetchFailure(e, url, timeoutMs);
    const absent = !answered &&
        !(e instanceof DOMException && e.name === "TimeoutError")
      ? "this-time" as const
      : undefined;
    // Same rule as unpackArchive / gitLsRemote: a raw ENOENT is the least
    // obvious form of "this path does not exist". A file:// channel that was
    // never published used to surface Deno's fetch wording and nothing else.
    if (isFile && /No such file|not found|os error 2/i.test(msg)) {
      return {
        kind: "error",
        error: missingManifestError(url, "the file does not exist"),
        absent,
      };
    }
    return {
      kind: "error",
      error: msg.startsWith(url) ? msg : `${url}: ${msg}`,
      absent,
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
 *  update. A process that is KILLED mid-download removes nothing: with
 *  `owner`, the staging directory and the finished file are on record first,
 *  and a later boot removes them (`sweepOwned`). */
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
  /** Test seam: the no-bytes deadline (default `DOWNLOAD_STALL_MS`). */
  stallMs?: number;
  /** The data directory of the app this download is for: what is made beside
   *  the install is recorded there before it is made. */
  owner?: string;
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
        `publish the artifact beside the manifest (a relative \`url\` in ` +
        `the manifest is always same-origin), or point \`updates.source\` ` +
        `at the host that serves both.`,
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
  const stage = join(parent, downloadStageName(opts.dest));
  try {
    if (opts.owner) record(opts.owner, stage, "dir");
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  await Deno.mkdir(stage, { recursive: false, mode: 0o700 });
  if (opts.owner) made(opts.owner, stage);
  const staged = join(stage, "artifact");
  let done = false;
  // Re-armed on every chunk: fires only when the host stops sending.
  const stallMs = opts.stallMs ?? DOWNLOAD_STALL_MS;
  const stall = new AbortController();
  let stallTimer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(
      () => stall.abort(new DOMException("stalled", "TimeoutError")),
      stallMs,
    );
  };
  try {
    arm();
    const res = await fetch(opts.url, {
      redirect: "follow",
      signal: opts.signal
        ? AbortSignal.any([opts.signal, stall.signal])
        : stall.signal,
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
    // Whole percents only: each report is a dispatch, a persist and a
    // broadcast, and per chunk that was ~4000 of them for one desktop update.
    let reported = -1;
    const file = await Deno.open(staged, { createNew: true, write: true });
    try {
      for await (const chunk of res.body) {
        seen += chunk.length;
        if (seen > opts.expectSize) {
          // Returning cancels the stream; see readCapped.
          return {
            ok: false,
            error:
              `${opts.url} is sending more than the ${
                MB(opts.expectSize)
              } (${opts.expectSize} bytes) the manifest promised (${seen} ` +
              `bytes and counting) — aborted`,
          };
        }
        arm();
        hash.update(chunk);
        await writeAll(file, chunk);
        const pct = Math.min(100, Math.floor((seen / opts.expectSize) * 100));
        if (pct > reported) {
          reported = pct;
          opts.onProgress?.(pct / 100);
        }
      }
      clearTimeout(stallTimer); // the body is in; a slow fsync is not a stall
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
          // Exact bytes beside the rounded size: an off-by-a-few download
          // read "sent 186.7 MB, but the manifest promises 186.7 MB".
          `${opts.url} sent ${MB(seen)} (${seen} bytes), but the manifest ` +
          `promises ${MB(opts.expectSize)} (${opts.expectSize} bytes) — it ` +
          `does not match the manifest, and a truncated artifact is ` +
          `never installed`,
      };
    }
    const sha = hash.digest("hex");
    // Case-blind: the manifest validator accepts either case (a digest from
    // PowerShell's `Get-FileHash` is UPPERCASE), and the digest computed here
    // is lowercase — so an exact compare refused every such release with
    // "does not match", naming two identical digests.
    if (sha !== opts.expectSha256.toLowerCase()) {
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
    // A leftover of ours at `dest` is replaced; anything else there refuses.
    if (opts.owner) {
      record(opts.owner, opts.dest, "file", {
        is: identity(staged),
        sum: sumOf(staged),
      });
    }
    await moveFile(staged, opts.dest);
    return { ok: true, path: opts.dest };
  } catch (e) {
    return {
      ok: false,
      error: stall.signal.aborted
        ? `${opts.url} sent nothing for ${stallMs / 1000}s — the download ` +
          `stalled and was aborted; the next check tries again`
        : e instanceof Error
        ? e.message
        : String(e),
    };
  } finally {
    clearTimeout(stallTimer);
    if (!done) await Deno.remove(stage, { recursive: true }).catch(() => {});
  }
}

/** A download's staging directory: named for what is being downloaded and
 *  for the process doing it, so a person looking at the folder can tell. The
 *  random part keeps two downloads of one release in one process apart, and
 *  the name unguessable. What a boot may remove is decided by the record
 *  (`updates-owned.ts`), never by this name. */
function downloadStageName(dest: string): string {
  return `.aio-update-${basename(dest)}-${Deno.pid}-${
    crypto.randomUUID().slice(0, 8)
  }`;
}

/** Is `path` a download folder a build up to 1.0.16 left behind? Those are
 *  named `.aio-update-<8 hex>` and are on no record, so the proof is content:
 *  a real directory holding nothing but a file `artifact` (or nothing), and
 *  nothing in it written for an hour. */
export function abandonedOldStage(path: string): boolean {
  if (!/^\.aio-update-[0-9a-f]{8}$/.test(basename(path))) return false;
  try {
    if (!Deno.lstatSync(path).isDirectory) return false;
    const inside = [...Deno.readDirSync(path)];
    if (inside.some((e) => e.name !== "artifact" || !e.isFile)) return false;
    const newest = Math.max(
      ...[path, ...inside.map((e) => join(path, e.name))].map((p) =>
        Deno.lstatSync(p).mtime?.getTime() ?? Infinity
      ),
    );
    return Date.now() - newest > OLD_STAGE_AGE_MS;
  } catch {
    return false; // aio-ok: unreadable — not provably a download, left alone
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
  // Case-blind for the same reason as `downloadArtifact`.
  if (sha256 !== manifest.sha256.toLowerCase()) {
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

/** End a git AND every helper it spawned: its process group on POSIX
 *  (spawned `detached`, it leads one), `taskkill /T` on Windows, where ending
 *  a process never ends its children. Never blocks: taskkill is spawned, not
 *  awaited — `outputSync` froze the event loop for as long as it ran, and a
 *  spawned taskkill still finishes when this is called on the way out. */
function killGitTree(pid: number): void {
  const killGit = () => {
    try {
      Deno.kill(pid, "SIGKILL");
    } catch { /* aio-ok: already exited — nothing to kill */ }
  };
  try {
    if (Deno.build.os !== "windows") return Deno.kill(-pid, "SIGKILL");
    new Deno.Command("taskkill", {
      args: ["/T", "/F", "/PID", String(pid)],
      cwd: neutralCwd(),
      stdin: "null",
      stdout: "null",
      stderr: "null",
      // It is often called on the way OUT; a plain child dies with us there.
      ...outlivingParent(),
    }).spawn().status.then((s) => s.success || killGit(), killGit);
  } catch {
    // aio-ok: already exited, or no taskkill — end git itself at least
    killGit();
  }
}

/** Every `git ls-remote` still running. `detached` takes git out of the
 *  terminal's process group, so Ctrl-C, a closed terminal or `am stop` no
 *  longer reach it: an app stopped during a check against a stalled host left
 *  git (and ssh / git-remote-http) waiting on it forever. Every exit path —
 *  SIGINT/SIGTERM/SIGHUP and `aio.stop()` all end in `Deno.exit` — fires
 *  `unload`, which ends each tree here. */
const liveGit = new Set<number>();
addEventListener("unload", () => {
  for (const pid of liveGit) killGitTree(pid);
});

/** What ssh is told for a background git, or nothing when the user chose
 *  their own ssh. `GIT_SSH_COMMAND` outranks `core.sshCommand` and `GIT_SSH`,
 *  so setting it over theirs would drop their key or proxy — theirs is left
 *  alone. Otherwise: `BatchMode=yes` (never ask — a passphrase or an unknown
 *  host fails), a connect deadline, and keepalives, so an ssh whose app was
 *  SIGKILLed (no `unload`, no group kill) gives up on a stalled host by itself
 *  — the ssh twin of `GIT_HTTP_LOW_SPEED_*`. Pure: the caller reads the
 *  inputs. */
export function gitSshEnv(
  env: { GIT_SSH_COMMAND?: string; GIT_SSH?: string },
  /** `git config --get core.sshCommand`, "" when unset. */
  configured: string,
  stallSec: number,
): Record<string, string> {
  if (env.GIT_SSH_COMMAND || env.GIT_SSH || configured.trim()) return {};
  const every = Math.max(1, Math.ceil(stallSec / 3));
  return {
    GIT_SSH_COMMAND: `ssh -o BatchMode=yes -o ConnectTimeout=${stallSec} ` +
      `-o ServerAliveInterval=${every} -o ServerAliveCountMax=3`,
  };
}

/** The user's `core.sshCommand` as git sees it from `cwd` ("" if none).
 *  Config only — no remote, nothing to prompt for. */
async function configuredSshCommand(cwd?: string): Promise<string> {
  try {
    const o = await new Deno.Command("git", {
      args: ["config", "--get", "core.sshCommand"],
      cwd,
      stdout: "piped",
      stderr: "null",
      stdin: "null",
      // An inherited GIT_DIR (a hook) would name ANOTHER repo's config.
      ...gitOwnRepoEnv(),
    }).output();
    return o.success ? new TextDecoder().decode(o.stdout).trim() : "";
  } catch {
    return ""; // aio-ok: no git — the spawn that follows reports it
  }
}

/** Run a git that may talk to a remote, in the background: it never prompts,
 *  has a deadline, and leaves nothing behind — at the deadline, on exit, and
 *  (via the stall env) when aio is SIGKILLed. It addresses only the repo its
 *  cwd/args name: an inherited `GIT_DIR` & co. (an app started from a git
 *  hook) is stripped (`gitOwnRepoEnv`). Every git the update path spawns
 *  goes through here. Throws only when git cannot be spawned at all. */
export async function runBackgroundGit(
  args: string[],
  opts: {
    cwd?: string;
    timeoutMs: number;
    /** Silence (seconds) after which the transport gives up by itself. */
    stallSec: number;
    /** `timeoutMs` is an IDLE deadline: every byte git writes restarts it.
     *  For a long transfer that reports progress (`clone --progress`), so a
     *  slow-but-moving one is never killed while a silent one still is. */
    idle?: boolean;
  },
): Promise<{ ok: boolean; timedOut: boolean; out: string; err: string }> {
  const { timeoutMs, stallSec } = opts;
  // Same reason as `MANIFEST_TIMEOUT_MS`: git has no deadline of its own, so a
  // remote that accepted the connection and went silent held the caller
  // forever. At the deadline git is killed AND the pipes are let go: its
  // transport helper (`git-remote-http`) is a grandchild that inherits them,
  // so waiting for EOF after the kill would hang just the same.
  let timedOut = false;
  const cancels: (() => void)[] = [];
  const drain = async (s: ReadableStream<Uint8Array>): Promise<Uint8Array> => {
    const r = s.getReader();
    cancels.push(() =>
      void r.cancel().catch(() => {
        // aio-ok: releasing a pipe after the kill; the timeout is reported
      })
    );
    const parts: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await r.read();
      if (done) break;
      parts.push(value);
      if (opts.idle && !timedOut) arm();
    }
    const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) all.set(p, at), at += p.length;
    return all;
  };
  const ssh = gitSshEnv(
    {
      GIT_SSH_COMMAND: Deno.env.get("GIT_SSH_COMMAND"),
      GIT_SSH: Deno.env.get("GIT_SSH"),
    },
    await configuredSshCommand(opts.cwd),
    stallSec,
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pid = 0;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      killGitTree(pid);
      for (const c of cancels) c();
    }, timeoutMs);
  };
  try {
    const child = new Deno.Command("git", {
      args,
      cwd: opts.cwd,
      stdout: "piped",
      stderr: "piped",
      stdin: "null",
      ...gitOwnRepoEnv({
        // A background git never asks anyone anything. Detached, git and ssh
        // have no terminal, so both fall back to an askpass program — a GUI
        // dialog (VS Code's, ssh-askpass under $DISPLAY) on every poll. Empty
        // GIT_ASKPASS turns git's off, and ssh's off on any OpenSSH version;
        // with no terminal, ssh then fails (a passphrase, an unknown host)
        // exactly as `BatchMode=yes` would — even under the user's own
        // `core.sshCommand`, which `gitSshEnv` leaves alone.
        GIT_ASKPASS: "",
        SSH_ASKPASS: "",
        SSH_ASKPASS_REQUIRE: "never",
        // Backstop for an app that dies without its exit path (SIGKILL):
        // the HTTP helper then gives up on a silent host by itself.
        GIT_HTTP_LOW_SPEED_LIMIT: "1",
        GIT_HTTP_LOW_SPEED_TIME: String(stallSec),
        ...ssh,
      }),
      // Its own process group on POSIX, so the deadline ends the whole TREE:
      // killing git alone orphaned `git-remote-http`, which then waited on the
      // silent host for good (2 processes left per timed-out check). Leaving
      // the terminal's group is paid for by `liveGit` (killed on exit).
      detached: Deno.build.os !== "windows",
    }).spawn();
    pid = child.pid;
    liveGit.add(pid);
    void child.status.finally(() => liveGit.delete(pid));
    arm();
    const [stdout, stderr, status] = await Promise.all([
      drain(child.stdout),
      drain(child.stderr),
      child.status,
    ]);
    return {
      ok: status.success && !timedOut,
      timedOut,
      out: new TextDecoder().decode(stdout).trim(),
      err: new TextDecoder().decode(stderr).trim(),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Ask a remote where a ref points, without cloning anything.
 *
 *  `git ls-remote` is one round trip and works identically for GitHub, GitLab,
 *  a bare repo on a NAS, and a local path — which is the whole reason a git
 *  source can be treated like any other source. */
export async function gitLsRemote(
  source: string,
  ref: string,
  /** Test seam: the deadline (default `GIT_LS_REMOTE_TIMEOUT_MS`). */
  timeoutMs = GIT_LS_REMOTE_TIMEOUT_MS,
): Promise<{ ok: true; head: GitHead } | { ok: false; error: string }> {
  try {
    const out = await runBackgroundGit(
      // `--` first: both the source and the ref come from config or a
      // manifest, and `git` would otherwise read a ref named
      // `--upload-pack=…` as an option and run it.
      //
      // `<ref>^{}` asks for the DEREFERENCED object as well. An annotated tag
      // points at a tag object, not a commit, while the rebuild records
      // `rev-parse HEAD` (the commit) — so without this the two never agree
      // and the same tag is offered as "new" forever.
      ["ls-remote", "--exit-code", "--", source, ref, `${ref}^{}`],
      { timeoutMs, stallSec: Math.max(1, Math.ceil(timeoutMs / 1000)) },
    );
    if (out.timedOut) {
      return {
        ok: false,
        error: `git ls-remote ${source} did not answer within ${
          timeoutMs / 1000
        }s — the remote is unreachable or stalled; the next check tries again`,
      };
    }
    if (!out.ok) {
      return {
        ok: false,
        error: out.err ||
          `git ls-remote found no ref "${ref}" in ${source} — check the ` +
            `branch or tag name`,
      };
    }
    const lines = out.out.split("\n")
      .filter(Boolean)
      .map((l) => {
        const [sha = "", name = ""] = l.split(/\s+/);
        return { sha, name };
      });
    // `ls-remote <pattern>` matches the TAIL of a ref name, so `main` also
    // lists `refs/heads/feature/main` — which sorts FIRST. Taking the first
    // line followed that branch instead, while the rebuild clones `--branch
    // main`: the recorded commit never equalled the "head", and every check
    // offered the same update again (with `auto`, an endless rebuild loop).
    // So the ref is resolved EXACTLY, in the order `git clone --branch` uses
    // (a branch, then a tag), or taken verbatim for a full name such as
    // `HEAD`. The dereferenced entry of the chosen name wins when it is
    // there: for an annotated tag it is the commit.
    let picked: { sha: string; name: string } | undefined;
    for (const name of [`refs/heads/${ref}`, `refs/tags/${ref}`, ref]) {
      picked = lines.find((l) => l.name === `${name}^{}`) ??
        lines.find((l) => l.name === name);
      if (picked) break;
    }
    if (!picked) {
      return {
        ok: false,
        error: `git ls-remote found no branch or tag named exactly "${ref}" ` +
          `in ${source} (it matched only ${
            lines.map((l) => l.name).join(", ")
          }) — check the branch or tag name`,
      };
    }
    const sha = picked.sha;
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
