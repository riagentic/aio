// updates-check.ts — the IO half of updates: talking to a source, and the
// small amount of state an install has to remember about trust.
//
// Kept separate from updates-core.ts so the rules that decide whether a user is
// offered an update stay pure and testable, and everything that can fail for
// boring reasons (DNS, a 500, a half-written file) is in one place with one
// error vocabulary. Nothing here decides anything — it fetches, it verifies,
// it reports.
import { join } from "@std/path";
import {
  sha256Hex,
  type ShipExpectations,
  type ShipManifest,
  verifyShipManifest,
} from "../build/ship.ts";
import type { GitHead } from "./updates-core.ts";

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
};

const TRUST_FILE = "update-trust.json";

export function trustPath(dataDir: string): string {
  return join(dataDir, TRUST_FILE);
}

export function readTrust(dataDir: string): TrustStore {
  try {
    return JSON.parse(Deno.readTextFileSync(trustPath(dataDir))) as TrustStore;
  } catch {
    return {};
  }
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

/** Pin the trusted signing key on first use.
 *
 *  Throws if it cannot be written. Every other piece of this file degrades
 *  quietly, but a key that was "pinned" only in memory means the NEXT run
 *  trusts whatever it is handed — the app would believe it was protected while
 *  it was not, which is worse than knowing it is unprotected. */
export function pinKey(dataDir: string, key: JsonWebKey): void {
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

// ── fetching ────────────────────────────────────────────────────────────────

export type ManifestFetch =
  | { kind: "not-modified" }
  | { kind: "ok"; manifest: ShipManifest; etag?: string }
  | { kind: "error"; error: string };

/** Fetch and parse a manifest. `file:` URLs skip conditional requests — there
 *  is no ETag on a filesystem, and re-reading a local file costs nothing. */
export async function fetchManifest(
  url: string,
  etag?: string,
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
    const text = await res.text();
    let manifest: ShipManifest;
    try {
      manifest = JSON.parse(text) as ShipManifest;
    } catch {
      // A proxy login page or an S3 error document is HTML, and "unexpected
      // token <" tells nobody where to look.
      return {
        kind: "error",
        error: `${url} did not return a release manifest (got ${
          text.slice(0, 40).replace(/\s+/g, " ")
        }…)`,
      };
    }
    return { kind: "ok", manifest, etag: res.headers.get("etag") ?? undefined };
  } catch (e) {
    return {
      kind: "error",
      error: `${url}: ${e instanceof Error ? e.message : e}`,
    };
  }
}

/** Download an artifact to `dest`, verifying its digest against the manifest
 *  BEFORE the caller is allowed to do anything with it.
 *
 *  Writes to `dest` directly (the caller picks a path beside the target, so the
 *  later rename is atomic) and removes it on any failure — a half-downloaded
 *  file left beside a binary is the kind of thing a later boot mistakes for a
 *  staged update. */
export async function downloadArtifact(opts: {
  url: string;
  dest: string;
  expectSha256: string;
  expectSize?: number;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}): Promise<{ ok: true } | { ok: false; error: string }> {
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
    const total = opts.expectSize ??
      Number(res.headers.get("content-length") ?? 0);
    let seen = 0;
    const file = await Deno.open(opts.dest, {
      create: true,
      write: true,
      truncate: true,
    });
    try {
      for await (const chunk of res.body) {
        await file.write(chunk);
        seen += chunk.length;
        if (total > 0) opts.onProgress?.(Math.min(1, seen / total));
      }
    } finally {
      file.close();
    }

    const bytes = await Deno.readFile(opts.dest);
    const sha = await sha256Hex(bytes);
    if (sha !== opts.expectSha256) {
      await Deno.remove(opts.dest).catch(() => {});
      return {
        ok: false,
        error: `downloaded artifact does not match the manifest (sha256 ${
          sha.slice(0, 12)
        }… vs ${opts.expectSha256.slice(0, 12)}…) — refusing to install it`,
      };
    }
    return { ok: true };
  } catch (e) {
    await Deno.remove(opts.dest).catch(() => {});
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Verify a downloaded artifact against its manifest and this install's
 *  expectations. A thin pass-through, but it is the ONE place an applier is
 *  allowed to call, so the verification cannot be skipped by forgetting it. */
export async function verifyDownload(
  path: string,
  manifest: ShipManifest,
  expect: ShipExpectations,
): Promise<{ ok: boolean; reason: string }> {
  const bytes = await Deno.readFile(path);
  return await verifyShipManifest(bytes, manifest, expect);
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
      args: ["ls-remote", "--exit-code", source, ref],
      stdout: "piped",
      stderr: "piped",
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
    const line = new TextDecoder().decode(out.stdout).trim().split("\n")[0] ??
      "";
    const sha = line.split(/\s+/)[0] ?? "";
    if (!/^[0-9a-f]{40}$/.test(sha)) {
      return { ok: false, error: `unexpected git ls-remote output: "${line}"` };
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
