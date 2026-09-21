/**
 * @module
 * What is in `~/.cache/aio/tools/electron`, and what may be deleted from it.
 *
 * The cache is one directory per Electron version+platform, ~250–370 MB each,
 * shared by EVERY aio app on the machine — that is the whole point of it, and
 * it is also why nothing here deletes anything on its own. Real state on the
 * box this was written on: 32 entries, **7.7 GB**, versions 41.2.1 through
 * 44.4.2, six of them for platforms this machine cannot even run (they are
 * cross-build inputs).
 *
 * The obvious fixes are all wrong, and each is wrong in the same way:
 *
 *   - **prune on launch / on `am fix`** — the app you are standing in cannot
 *     know what the app next door needs. Deleting the runtime an offline app
 *     starts from turns its next launch into a 250 MB download it cannot do.
 *     Silent, remote, and unrecoverable without a network: the exact shape
 *     this repo refuses.
 *   - **keep the N newest** — version order is not need order. An app pinned
 *     to 43.4.1 (an app that never upgraded, a reproducible build, a bisect)
 *     loses its runtime the moment two newer ones exist.
 *   - **keep only this platform** — `--platforms=windows,macos` builds from
 *     Linux are a headline feature; those runtimes are inputs, not leftovers.
 *
 * What is actually knowable is USE: `touchRuntimeUse` stamps a runtime every
 * time an app starts from it, so "nothing on this machine has opened this in
 * N days" is a fact rather than a guess. Everything below turns that fact into
 * a plan a human reads BEFORE anything is removed — `am prune` prints it and
 * deletes only with `--yes`.
 */
import { join } from "@std/path";
import {
  DEFAULT_ELECTRON_VERSION,
  runtimeLastUsed,
  toolCacheDir,
} from "../electron/electron-runtime-fetch.ts";

/** The cache root this module reports on. One decider, so `am prune` and the
 *  fetcher can never disagree about which directory is meant. */
export function electronCacheRoot(): string {
  return join(toolCacheDir(), "electron");
}

/** What a single thing in the cache is. `zip` entries are the cross-build
 *  download cache (`44.3.0-win32-x64.zip`, 144–151 MB each) and their
 *  `.sha256` siblings; `stage` is an interrupted unpack (`.incoming.<pid>`);
 *  `lock` is a claim another process may be holding right now. */
export type CacheEntryKind = "runtime" | "zip" | "stage" | "lock" | "other";

export type CacheEntry = {
  /** The absolute path — spelled in full, because it is what a delete names. */
  path: string;
  /** The entry as it appears in the cache (`44.4.1-linux-x64`). */
  name: string;
  kind: CacheEntryKind;
  /** Parsed out of the name; null when the name does not follow the scheme. */
  version: string | null;
  slug: string | null;
  bytes: number;
  /** Epoch ms of the last launch from it, or null when even that is unknown. */
  lastUsed: number | null;
  /** `"stamp"` — written by a launch. `"mtime"` — no stamp yet, so the
   *  directory's timestamp stands in (older than the truth, never newer, so
   *  it can only make the plan more cautious). */
  lastUsedSource: "stamp" | "mtime" | "none";
};

/** `44.4.1-linux-x64` → `{version, slug}`. A name that does not parse keeps
 *  nulls and is never matched against a protected version, which is what makes
 *  "unrecognised" fall on the safe side. Pure. */
export function parseCacheName(
  name: string,
): { version: string | null; slug: string | null } {
  // The slug half is normally Electron's own (`linux-x64`, `win32-x64`), but
  // `electronCacheDir` has a `?? platform` fallback that writes aio's own
  // one-word platform names, so `43.4.0-macos` and `43.4.0-windows` are aio
  // directories too — 670 MB of them on the machine this was written on. A
  // regex that only knew the two-part form filed them as "not ours" and made
  // them permanently unreclaimable.
  //
  // The OS half is a CLOSED LIST, not `[a-z0-9]+`, and that is load-bearing:
  // with a wildcard, `43.4.1-linux-x64` parses as version `43.4.1-linux` +
  // slug `x64` (the optional prerelease group happily eats `-linux`), so
  // `--keep=43.4.1` protects nothing and the version this aio SHIPS is not
  // recognised as protected either. Caught by the first test in
  // tests/electron-cache-prune.test.ts, which is the one that exists to say
  // the shipped runtime is never offered.
  const m =
    /^(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)-(linux|win32|darwin|windows|macos)(?:-([a-z0-9]+))?$/
      .exec(name);
  if (!m) return { version: null, slug: null };
  return { version: m[1]!, slug: m[3] ? `${m[2]}-${m[3]}` : m[2]! };
}

/** The version+slug an ENTRY NAME identifies, suffixes and all. One decider:
 *  `44.4.1-win32-x64.zip` and `44.4.1-win32-x64.incoming.31337` are the same
 *  Electron as `44.4.1-win32-x64`, and a caller that strips the suffix itself
 *  (the scanner did, a test helper did not) gets a different answer from the
 *  one the plan protects. Pure. */
export function cacheEntryIdentity(
  name: string,
): { version: string | null; slug: string | null } {
  return parseCacheName(
    name.replace(/\.zip(\.sha256)?$/, "")
      .replace(/\.incoming\.\d+$/, "")
      .replace(/\.lock$/, ""),
  );
}

/** Which of the five kinds `name` is, from the name alone. Pure. */
export function cacheEntryKind(name: string): CacheEntryKind {
  if (name.endsWith(".lock")) return "lock";
  if (/\.incoming\.\d+$/.test(name)) return "stage";
  if (name.endsWith(".zip") || name.endsWith(".zip.sha256")) return "zip";
  if (parseCacheName(name).version !== null) return "runtime";
  return "other";
}

/** Bytes under `path`, following no symlinks. A missing tree is 0 rather than
 *  a throw: the cache is shared, and another process may be clearing the very
 *  entry we are measuring. */
export async function treeBytes(path: string): Promise<number> {
  let total = 0;
  const visit = async (p: string) => {
    let st: Deno.FileInfo;
    try {
      st = await Deno.lstat(p);
    } catch {
      return;
    }
    if (st.isDirectory) {
      let entries: Deno.DirEntry[];
      try {
        entries = await Array.fromAsync(Deno.readDir(p));
      } catch {
        return;
      }
      for (const e of entries) await visit(join(p, e.name));
    } else {
      total += st.size;
    }
  };
  await visit(path);
  return total;
}

/** Everything in the cache, measured. Returns `[]` when the cache does not
 *  exist — a machine that has never launched an Electron app is not an error. */
export async function readElectronCache(
  root = electronCacheRoot(),
): Promise<CacheEntry[]> {
  let names: Deno.DirEntry[];
  try {
    names = await Array.fromAsync(Deno.readDir(root));
  } catch {
    return [];
  }
  const out: CacheEntry[] = [];
  for (const e of names) {
    const path = join(root, e.name);
    const kind = cacheEntryKind(e.name);
    const { version, slug } = cacheEntryIdentity(e.name);
    const used = kind === "runtime" ? await runtimeLastUsed(path) : null;
    const fallback = used ?? await (async () => {
      const st = await Deno.stat(path).catch(() => null);
      return st?.mtime ? { at: st.mtime, source: "mtime" as const } : null;
    })();
    out.push({
      path,
      name: e.name,
      kind,
      version,
      slug,
      bytes: await treeBytes(path),
      lastUsed: fallback?.at.getTime() ?? null,
      lastUsedSource: fallback?.source ?? "none",
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export type PruneDecision = {
  entry: CacheEntry;
  /** True when the plan refuses to offer it. `why` says so in one line. */
  keep: boolean;
  why: string;
};

export type PrunePlan = {
  keep: PruneDecision[];
  remove: PruneDecision[];
  /** Bytes the `remove` list would free, and bytes the cache holds now. */
  freed: number;
  total: number;
  /** The versions no plan will ever offer, whatever their age. */
  protectedVersions: string[];
  minAgeDays: number;
};

export type PruneOptions = {
  /** Versions that must survive regardless of age: what this aio ships, plus
   *  anything the caller knows an app here is pinned to. */
  keepVersions: readonly string[];
  /** Nothing used more recently than this is ever offered. */
  minAgeDays: number;
  /** Epoch ms. Injected so the plan is a pure function of its inputs. */
  now: number;
};

export const PRUNE_DEFAULT_MIN_AGE_DAYS = 30;

const DAY_MS = 86_400_000;

/** THE decider, pure: which entries may be deleted, and the reason for every
 *  single one either way. Every branch produces a sentence, because the whole
 *  design is that a human reads the verdict before it is acted on — a plan
 *  with an unexplained line in it is a plan nobody can check.
 *
 *  Note what is NOT an input: how many versions there are, which is newest,
 *  and which platform this host runs. Those are the three "obvious" rules that
 *  each delete a runtime some app still needs (see the module comment). */
export function planElectronPrune(
  entries: readonly CacheEntry[],
  opts: PruneOptions,
): PrunePlan {
  const kept: PruneDecision[] = [];
  const gone: PruneDecision[] = [];
  const keepVersions = [...new Set(opts.keepVersions)].sort();
  const ageDays = (at: number | null) =>
    at === null ? null : Math.floor((opts.now - at) / DAY_MS);

  for (const entry of entries) {
    const age = ageDays(entry.lastUsed);
    const used = age === null
      ? "never recorded"
      : age === 0
      ? "used today"
      : `last used ${age} day${age === 1 ? "" : "s"} ago`;

    if (entry.kind === "lock") {
      kept.push({
        entry,
        keep: true,
        why: "a lock — another process may be downloading into it right now",
      });
      continue;
    }
    if (entry.kind === "other") {
      kept.push({
        entry,
        keep: true,
        why:
          "not a name aio writes; aio does not delete what it did not put here",
      });
      continue;
    }
    if (entry.version !== null && keepVersions.includes(entry.version)) {
      kept.push({
        entry,
        keep: true,
        why: entry.version === DEFAULT_ELECTRON_VERSION
          ? `Electron ${entry.version} is the one this aio ships — every app ` +
            `here starts on it`
          : `Electron ${entry.version} is pinned (--keep)`,
      });
      continue;
    }
    if (age === null) {
      // No stamp and no mtime: the one case where use is genuinely unknown.
      // Unknown is not "unused".
      kept.push({
        entry,
        keep: true,
        why: "nothing says when this was last used, and unknown is not unused",
      });
      continue;
    }
    if (age < opts.minAgeDays) {
      kept.push({
        entry,
        keep: true,
        why: `${used} (newer than ${opts.minAgeDays} days)`,
      });
      continue;
    }
    gone.push({
      entry,
      keep: false,
      why: entry.kind === "stage"
        ? `an interrupted download, ${age} days old`
        : entry.kind === "zip"
        ? `a downloaded archive, ${used} — refetched on demand`
        : `${used}${
          entry.lastUsedSource === "mtime"
            ? " (by its mtime — no launch stamp)"
            : ""
        }`,
    });
  }
  return {
    keep: kept,
    remove: gone,
    freed: gone.reduce((n, d) => n + d.entry.bytes, 0),
    total: entries.reduce((n, e) => n + e.bytes, 0),
    protectedVersions: keepVersions,
    minAgeDays: opts.minAgeDays,
  };
}

/** Delete exactly what a plan listed — nothing derived, nothing globbed. The
 *  caller has already shown the plan and been told yes. Each removal is
 *  reported by its full path so the output can be checked against the plan
 *  line by line, and a failure is a line, never a thrown half-prune. */
export async function applyElectronPrune(
  plan: PrunePlan,
): Promise<{ removed: string[]; failed: { path: string; error: string }[] }> {
  const removed: string[] = [];
  const failed: { path: string; error: string }[] = [];
  for (const d of plan.remove) {
    try {
      await Deno.remove(d.entry.path, { recursive: true });
      removed.push(d.entry.path);
    } catch (e) {
      failed.push({
        path: d.entry.path,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return { removed, failed };
}

/** `7.7 GB`, `251 MB`, `0 B` — sizes a person reads, not bytes they count. */
export function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export { DEFAULT_ELECTRON_VERSION };
