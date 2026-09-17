/**
 * @module
 * The Electron runtime, fetched from Electron's own releases — for a machine
 * that has no `node_modules/electron` and no `deno` to install one with.
 *
 * A COMPILED aio binary whose client is Electron used to resolve the runtime
 * in exactly one place: `node_modules/.bin/electron` under the CURRENT
 * DIRECTORY, and when that was missing it "auto-installed" by running
 * `Deno.execPath() install --allow-scripts=npm:electron npm:electron`. Inside a
 * compiled binary `Deno.execPath()` is the app itself, so that command was
 * `<app> install …` — it can never have worked. The message that
 * followed said "run `deno task install:electron`", which is advice for a
 * checkout, aimed at someone who was handed a binary. That is the field
 * report behind this file: a desktop app installed by the one-liner opened
 * nothing until its user went back to the source tree, installed Electron by
 * hand, and launched the binary FROM that directory.
 *
 * Electron publishes every platform's runtime as a plain zip; the cross-build
 * path has fetched those for a while. This module is that fetch, made usable
 * from the launcher: download once into the per-user aio cache, verify the
 * unpack finished, hand back the binary. No npm, no deno, no cwd. The build
 * bakes the version (`dist/electron.json`) so a binary and the checkout it was
 * built from never run two different Electrons.
 *
 * Lives in `electron/` (not `build/`) because the LAUNCHER needs it and the
 * boundary matrix lets build → electron, never the reverse. The build-side
 * wrappers in `build/electron-runtime.ts` delegate here.
 */
import { join } from "@std/path";
import { log as flog } from "../diagnostics/logger-api.ts";
import { homedir } from "../server/paths.ts";
import { isProcessAlive } from "../server/single-instance-lock.ts";
import { OK } from "../diagnostics/fmt.ts";
import { extractZip } from "../server/zip-extract.ts";

/** The Electron version a build falls back to when the app declares no exact
 *  one and none is installed. ONE decider — the scaffold's import map says
 *  `npm:electron` (latest at install time), so a version has to come from
 *  somewhere when nothing has been installed yet. */
export const DEFAULT_ELECTRON_VERSION = "43.4.1";

/** `dist/electron.json` — written by the build, read by the launcher of a
 *  compiled binary. The file name is the contract between the two. */
export const ELECTRON_VERSION_FILE = "electron.json";

/** aio's per-user tool cache (appimagetool, Electron runtimes, run tmp).
 *  `$XDG_CACHE_HOME/aio/tools` or `~/.cache/aio/tools`. */
export function toolCacheDir(): string {
  const xdg = Deno.env.get("XDG_CACHE_HOME");
  // `?? "."` used to close this expression, which turned "no HOME" into "use
  // the current directory" — a 100 MB Electron runtime unpacked into whatever
  // the user happened to be standing in, per project, silently. `homedir()` is
  // THE decider for this question and it refuses instead, naming the fix.
  return join(
    xdg && xdg.length > 0 ? xdg : join(homedir(), ".cache"),
    "aio",
    "tools",
  );
}

/** Electron's own name for an os/arch pair, as it appears in its release
 *  assets: `electron-v28.3.3-win32-x64.zip`. Pure. */
export function electronSlug(
  build: { os: string; arch: string } = Deno.build,
): string {
  const os = build.os === "windows"
    ? "win32"
    : build.os === "darwin"
    ? "darwin"
    : "linux";
  const arch = build.arch === "aarch64" ? "arm64" : "x64";
  return `${os}-${arch}`;
}

/** The OS half of an Electron release slug (`win32-x64` → `windows`), in
 *  `Deno.build.os` vocabulary. The exact inverse of {@link electronSlug}, and
 *  the reason it exists is the bug it closes:
 *
 *  every consumer of a fetched runtime asked {@link electronBinIn} where the
 *  executable is, and that function defaults to the HOST's os. For the
 *  launcher that is right — it only ever fetches its own platform. For the
 *  CROSS-BUILD it is wrong in the one way that cannot be recovered from: a
 *  Linux host fetching `win32-x64` unpacked a perfectly good runtime holding
 *  `electron.exe`, looked for `electron`, and threw
 *  "the archive is not an Electron runtime for win32-x64" — blaming Electron
 *  for the build's own host assumption. So `deno task build --targets=electron
 *  --platforms=windows`, the headline capability of platforms.ts, could not
 *  succeed on any host. Pure, so the mapping is a unit test. */
export function electronOsFromSlug(slug: string): string {
  const os = slug.split("-")[0];
  return os === "win32" ? "windows" : os === "darwin" ? "darwin" : "linux";
}

/** The asset file name Electron publishes for `version`+`slug`. Pure — and the
 *  key into `SHASUMS256.txt`, which is why it is one function. */
export function electronZipName(version: string, slug: string): string {
  const v = version.startsWith("v") ? version : `v${version}`;
  return `electron-${v}-${slug}.zip`;
}

/** Where a release's files live. `$ELECTRON_MIRROR` (the same variable every
 *  Electron toolchain reads, and the one two of aio's own error messages told
 *  people to set while nothing read it) replaces the GitHub base; it may or may
 *  not end in a slash. Pure — the env read happens at the call site. */
export function electronReleaseBase(version: string, mirror?: string): string {
  const v = version.startsWith("v") ? version : `v${version}`;
  const base = mirror && mirror.length > 0
    ? (mirror.endsWith("/") ? mirror : `${mirror}/`)
    : "https://github.com/electron/electron/releases/download/";
  return `${base}${v}/`;
}

/** The URL Electron publishes `version` for `slug` at. Pure. */
export function electronZipUrlFor(
  version: string,
  slug: string,
  mirror?: string,
): string {
  return electronReleaseBase(version, mirror) +
    electronZipName(version, slug);
}

/** The URL of the release's checksum manifest. Pure. */
export function electronShasumsUrlFor(
  version: string,
  mirror?: string,
): string {
  return electronReleaseBase(version, mirror) + "SHASUMS256.txt";
}

/** The lowercase-hex SHA-256 `SHASUMS256.txt` records for `file`, or null when
 *  the file is not listed. Lines are `<64 hex>  *<name>` (the `*` is sha256sum's
 *  binary marker) or `<64 hex>  <name>`. Pure. */
export function shasumFor(shasums: string, file: string): string | null {
  for (const line of shasums.split("\n")) {
    const m = /^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(line);
    if (m && m[2] === file) return m[1]!.toLowerCase();
  }
  return null;
}

/** Lowercase hex SHA-256 of `bytes`. */
// A fourth spelling of the same four lines, and deliberately still here: the
// canonical one is exported from `src/build/ship.ts`, and the folder matrix
// does not allow `electron -> build`. Widening it for a hash is the wrong
// trade — a red gate loosened to save four lines. If a third copy ever wants
// this, move it somewhere both may reach instead of adding another.
async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Where a fetched runtime lives: one directory per version+slug, shared by
 *  the launcher and every build on this machine, so a runtime is downloaded
 *  once per user rather than once per app. */
export function electronRuntimeDir(version: string, slug: string): string {
  const v = version.startsWith("v") ? version.slice(1) : version;
  return join(toolCacheDir(), "electron", `${v}-${slug}`);
}

/** The executable inside an unpacked runtime directory. Pure. */
export function electronBinIn(dir: string, os: string = Deno.build.os): string {
  switch (os) {
    case "darwin":
      return join(dir, "Electron.app", "Contents", "MacOS", "Electron");
    case "windows":
      return join(dir, "electron.exe");
    default:
      return join(dir, "electron");
  }
}

/** Read the baked version from `<distDir>/electron.json`, or null. Pure in
 *  effect: no download, no guess — a caller decides what null means. */
export async function bakedElectronVersion(
  distDir: string | undefined,
): Promise<string | null> {
  if (!distDir) return null;
  try {
    const rec = JSON.parse(
      await Deno.readTextFile(join(distDir, ELECTRON_VERSION_FILE)),
    ) as { version?: unknown };
    return typeof rec.version === "string" && rec.version.length > 0
      ? rec.version
      : null;
  } catch {
    return null;
  }
}

/** The runtime zip a self-contained build embeds in `dist/`, beside
 *  `electron.json` (which records its name and checksum). */
export const EMBEDDED_RUNTIME_ZIP = "electron-runtime.zip";

/** The runtime this binary CARRIES, from `<distDir>/electron.json`'s
 *  `embedded` record — or null when the build embedded none. A record whose
 *  zip is missing is an error, not a null: the build said it is there. */
export async function bakedEmbeddedRuntime(
  distDir: string | undefined,
): Promise<EmbeddedRuntime | null> {
  if (!distDir) return null;
  let rec: { embedded?: { name?: unknown; sha256?: unknown } };
  try {
    rec = JSON.parse(
      await Deno.readTextFile(join(distDir, ELECTRON_VERSION_FILE)),
    );
  } catch {
    return null;
  }
  const e = rec.embedded;
  if (typeof e?.name !== "string" || typeof e.sha256 !== "string") return null;
  const path = join(distDir, EMBEDDED_RUNTIME_ZIP);
  await Deno.stat(path).catch((cause) => {
    throw new Error(
      `this build says it carries ${e.name}, but ${path} is not in the ` +
        `binary — the build that embedded it is broken; rebuild.`,
      { cause },
    );
  });
  return { name: e.name, sha256: e.sha256, path };
}

/** Unpack `zip` into `dir` — with the runtime's own zip reader, never an
 *  outside tool (see server/zip-extract.ts for why). `slug` names the
 *  platform the archive is for; the reader keeps each entry's exec bit and
 *  symlinks, so it needs no per-platform repair. */
export async function unzipInto(
  zip: string,
  dir: string,
  _warn: (msg: string) => void = console.warn,
  _slug: string = electronSlug(),
): Promise<void> {
  await extractZip(await Deno.readFile(zip), dir);
}

/** Marker written last, inside a completed runtime directory. */
const STAMP = ".aio-complete";

/** How long to wait for another process's download before taking the lock
 *  over as stale. A cold 100 MB fetch on a slow link can genuinely take this
 *  long; the holder's liveness is what actually decides. */
const LOCK_WAIT_MS = 15 * 60_000;

/** True when `dir` holds a runtime that is complete AND still has its
 *  executable. "The stamp exists" alone was the whole check, and the stamp was
 *  written even when the tree underneath had been deleted out from under the
 *  unpack — after which every launch for the rest of that machine's life said
 *  "cached" and opened nothing. */
async function runtimeUsable(dir: string, slug: string): Promise<boolean> {
  try {
    await Deno.stat(join(dir, STAMP));
  } catch {
    return false;
  }
  try {
    const info = await Deno.stat(
      electronBinIn(dir, electronOsFromSlug(slug)),
    );
    return info.isFile && info.size > 0;
  } catch {
    return false;
  }
}

/** Hold a lock file for the duration of `fn`. Same shape as the build lock in
 *  `build/build-compile.ts`: `createNew` is the atomic claim, and a holder that
 *  died without cleaning up is taken over rather than allowed to wedge every
 *  future launch. Returns whether the lock was actually held. */
async function withRuntimeLock<T>(
  lock: string,
  fn: (held: boolean) => Promise<T>,
): Promise<T> {
  await Deno.mkdir(join(lock, ".."), { recursive: true }).catch(() => {});
  let held = false;
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (!held && Date.now() < deadline) {
    try {
      await Deno.writeTextFile(lock, `${Deno.pid}`, { createNew: true });
      held = true;
      break;
    } catch { /* someone else holds it */ }
    try {
      const owner = Number(await Deno.readTextFile(lock));
      if (
        Number.isFinite(owner) && owner !== Deno.pid && !isProcessAlive(owner)
      ) {
        await Deno.remove(lock).catch(() => {});
        continue; // holder died mid-download — claim it
      }
    } catch { /* lock vanished — retry immediately */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  try {
    return await fn(held);
  } finally {
    if (held) await Deno.remove(lock).catch(() => {});
  }
}

/** How long a download may go without receiving a byte before it is
 *  abandoned. A dead connection used to hang the launcher forever behind a
 *  "downloading runtime (~100 MB)…" line that never changed (real Windows 11,
 *  2026-09-17). */
export const DOWNLOAD_STALL_MS = 60_000;

/** Read `res`'s body, logging progress every ~10% and failing loudly when no
 *  byte arrives for `stallMs`. `abort` cancels the underlying request. */
async function readWithProgress(
  res: Response,
  label: string,
  log: (msg: string) => void,
  abort: AbortController,
  stallMs: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const total = Number(res.headers.get("content-length")) || 0;
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array(await res.arrayBuffer());
  const chunks: Uint8Array[] = [];
  let got = 0;
  let nextPct = 10;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stalled = () =>
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        abort.abort();
        reject(
          new Error(
            `${label}: no data for ${stallMs / 1000}s after ` +
              `${(got / 1e6).toFixed(1)} MB — the connection is dead. ` +
              `Check the network (a VPN or proxy blocking github.com?), then ` +
              `start the app again; set $ELECTRON_MIRROR to use a mirror.`,
          ),
        );
      }, stallMs);
    });
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), stalled()]);
      clearTimeout(timer);
      if (done) break;
      chunks.push(value);
      got += value.length;
      if (total > 0 && (got * 100) / total >= nextPct) {
        log(
          `  ${label}: ${Math.floor((got * 100) / total)}% ` +
            `(${(got / 1e6).toFixed(0)} / ${(total / 1e6).toFixed(0)} MB)`,
        );
        nextPct = Math.floor((got * 100) / total / 10) * 10 + 10;
      }
    }
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
  const out = new Uint8Array(got);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** Electron's published zip for `version`+`slug`, downloaded and checked
 *  against the release's `SHASUMS256.txt`. Refuses, never warns: these bytes
 *  become the process the app runs as. */
export async function fetchVerifiedZip(
  version: string,
  slug: string,
  opts: {
    log: (msg: string) => void;
    fetch: typeof fetch;
    mirror?: string;
    stallMs?: number;
    /** What to say first; the default names a download. */
    announce?: string;
  },
): Promise<{ bytes: Uint8Array<ArrayBuffer>; sha256: string; name: string }> {
  const { log, mirror } = opts;
  const name = electronZipName(version, slug);
  const url = electronZipUrlFor(version, slug, mirror);
  log(
    opts.announce ??
      `downloading runtime ${version} for ${slug} (~100 MB, once per machine)…`,
  );
  const abort = new AbortController();
  const res = await opts.fetch(url, { signal: abort.signal });
  if (!res.ok) {
    throw new Error(
      `could not download the Electron runtime for ${slug}: ` +
        `${res.status} ${res.statusText}\n  ${url}\n` +
        `  (is ${version} a real Electron release? If a proxy blocks ` +
        `github.com, set $ELECTRON_MIRROR to a mirror of ` +
        `electron/electron's releases, or point $ELECTRON_PATH at an ` +
        `Electron you already have.)`,
    );
  }
  const bytes = await readWithProgress(
    res,
    name,
    log,
    abort,
    opts.stallMs ?? DOWNLOAD_STALL_MS,
  );

  const sumsUrl = electronShasumsUrlFor(version, mirror);
  const sumsRes = await opts.fetch(sumsUrl, {
    signal: AbortSignal.timeout(opts.stallMs ?? DOWNLOAD_STALL_MS),
  });
  if (!sumsRes.ok) {
    throw new Error(
      `downloaded ${name} but could not fetch its checksums ` +
        `(${sumsRes.status} ${sumsRes.statusText})\n  ${sumsUrl}\n` +
        `  Refusing to run 100 MB of unverified native code. Retry, or ` +
        `point $ELECTRON_PATH at an Electron you already trust.`,
    );
  }
  const expected = shasumFor(await sumsRes.text(), name);
  if (!expected) {
    throw new Error(
      `${name} is not listed in ${sumsUrl} — the release does not publish ` +
        `this asset, so the download cannot be verified. Check that ` +
        `${version} really ships a ${slug} build, or point ` +
        `$ELECTRON_PATH at an Electron you already have.`,
    );
  }
  const actual = await sha256Hex(bytes);
  if (actual !== expected) {
    throw new Error(
      `integrity check FAILED for ${name}: SHASUMS256.txt says ` +
        `${expected}, the download hashes to ${actual}. The file was ` +
        `corrupted or tampered with in transit — it is NOT being ` +
        `unpacked. Retry; if it keeps failing, a proxy or mirror is ` +
        `rewriting the download.`,
    );
  }
  log(`${OK} integrity check passed (${name})`);
  return { bytes, sha256: actual, name };
}

/** A runtime zip carried INSIDE a compiled binary, and its baked checksum. */
export type EmbeddedRuntime = { name: string; sha256: string; path: string };

/** A `fetch` that answers the runtime installer from an embedded zip instead
 *  of the network: the zip's own URL gets its bytes, the release's
 *  `SHASUMS256.txt` a one-line manifest built from the checksum the BUILD
 *  verified. So the self-contained exe goes through exactly the path a
 *  download does — lock, stage, integrity check, unpack, stamp — and a
 *  corrupted binary is refused the same way a tampered download is. Anything
 *  else is a 404: an embedded runtime never reaches the network. */
export function embeddedRuntimeFetch(rt: EmbeddedRuntime): typeof fetch {
  return (input) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith(`/${rt.name}`)) {
      return Deno.readFile(rt.path).then((b) => new Response(b));
    }
    if (url.endsWith("/SHASUMS256.txt")) {
      return Promise.resolve(new Response(`${rt.sha256} *${rt.name}\n`));
    }
    return Promise.resolve(new Response(null, { status: 404 }));
  };
}

/** Electron's verified zip for `version`+`slug`, kept beside the unpacked
 *  runtime in the cache (`<runtime>.zip` + `.sha256`) so a build can embed it
 *  without downloading it twice. Re-hashed on every use: a cache file is not
 *  trusted just because it exists. */
export async function ensureElectronZip(
  version: string,
  slug: string,
  opts: {
    log?: (msg: string) => void;
    fetch?: typeof fetch;
    mirror?: string;
  } = {},
): Promise<{ path: string; sha256: string; name: string }> {
  const log = opts.log ?? ((m: string) => flog.info(m));
  const zip = `${electronRuntimeDir(version, slug)}.zip`;
  const name = electronZipName(version, slug);
  try {
    const want = (await Deno.readTextFile(`${zip}.sha256`)).trim();
    const have = await sha256Hex(await Deno.readFile(zip));
    if (want === have) return { path: zip, sha256: have, name };
  } catch {
    // aio-ok(silent-catch): "not in the cache yet" is the miss this probe
    // exists to detect — the fetch below is the answer, not an error path.
  }
  const { bytes, sha256 } = await fetchVerifiedZip(version, slug, {
    log,
    fetch: opts.fetch ?? fetch,
    mirror: opts.mirror ?? Deno.env.get("ELECTRON_MIRROR") ?? undefined,
  });
  await Deno.mkdir(join(zip, ".."), { recursive: true });
  const tmp = `${zip}.incoming.${Deno.pid}`;
  await Deno.writeFile(tmp, bytes);
  await Deno.rename(tmp, zip);
  await Deno.writeTextFile(`${zip}.sha256`, `${sha256}\n`);
  return { path: zip, sha256, name };
}

/** The unpacked Electron runtime for `version`+`slug`, downloading it once.
 *
 *  Returns the directory (the same shape `node_modules/electron/dist` has,
 *  because it IS that: the zip Electron publishes is the dist directory).
 *
 *  Three properties this has to hold, each of which it did not:
 *
 *  1. **One downloader at a time.** The stamp guarded interruption but not
 *     concurrency. Two `am start`s of two apps raced, and the second one's
 *     `Deno.remove(dir, { recursive: true })` deleted the first one's
 *     half-unpacked tree — or the runtime under a RUNNING Electron. The first
 *     then wrote its stamp over the wreckage, and from then on every launch on
 *     that machine said "cached" and opened nothing, permanently. A lock file
 *     makes that window unreachable instead of unlikely.
 *
 *  2. **Nothing is destroyed until the replacement is complete.** The download
 *     stages into a sibling directory and is renamed into place, so an
 *     interrupted fetch cannot take the working runtime with it.
 *
 *  3. **The bytes are checked.** This downloads ~100 MB of native code that
 *     then BECOMES the app's process; it ran with no integrity check at all,
 *     while the AppImage path two folders away pins appimagetool's SHA-256.
 *     Electron publishes `SHASUMS256.txt` beside every asset — it is verified
 *     here, and a mismatch refuses rather than warns. */
export async function ensureElectronRuntime(
  version: string,
  slug: string,
  opts: {
    log?: (msg: string) => void;
    warn?: (msg: string) => void;
    /** Injected in tests — the real one downloads ~100 MB. */
    fetch?: typeof fetch;
    /** `$ELECTRON_MIRROR` override (tests). */
    mirror?: string;
    /** Install from the zip this binary CARRIES instead of the network. */
    embedded?: EmbeddedRuntime;
  } = {},
): Promise<string> {
  const log = opts.log ?? ((m: string) => flog.info(m));
  const doFetch = opts.embedded
    ? embeddedRuntimeFetch(opts.embedded)
    : opts.fetch ?? fetch;
  const mirror = opts.mirror ?? Deno.env.get("ELECTRON_MIRROR") ?? undefined;
  const dir = electronRuntimeDir(version, slug);
  if (await runtimeUsable(dir, slug)) {
    log(`${OK} runtime ${version} (${slug}) — cached`);
    return dir;
  }

  return await withRuntimeLock(`${dir}.lock`, async (held) => {
    // Whoever we waited for may have finished it for us.
    if (await runtimeUsable(dir, slug)) {
      log(`${OK} runtime ${version} (${slug}) — cached`);
      return dir;
    }
    if (!held) {
      throw new Error(
        `another process has been downloading the Electron runtime ` +
          `${version} (${slug}) into ${dir} for over ` +
          `${LOCK_WAIT_MS / 60_000} minutes and is still alive. Wait for it, ` +
          `or point $ELECTRON_PATH at an Electron you already have.`,
      );
    }

    const name = electronZipName(version, slug);
    const url = electronZipUrlFor(version, slug, mirror);
    // Stage beside the target, never into it: an interrupted download must not
    // be able to destroy a runtime that already works.
    const stage = `${dir}.incoming.${Deno.pid}`;
    await Deno.remove(stage, { recursive: true }).catch(() => {});
    await Deno.mkdir(stage, { recursive: true });
    try {
      const { bytes, sha256: actual } = await fetchVerifiedZip(
        version,
        slug,
        {
          log,
          fetch: doFetch,
          mirror,
          announce: opts.embedded
            ? `unpacking the Electron ${version} this app carries ` +
              `(once per machine)…`
            : undefined,
        },
      );

      const zip = join(stage, "electron.zip");
      await Deno.writeFile(zip, bytes);
      await unzipInto(zip, stage, opts.warn, slug);
      await Deno.remove(zip).catch(() => {});
      // The executable has to be there BEFORE the stamp says the tree is good
      // — and WHICH executable is decided by the slug, never by this host: a
      // `win32-x64` runtime holds `electron.exe` however the build machine is
      // spelled (see electronOsFromSlug).
      const os = electronOsFromSlug(slug);
      try {
        await Deno.stat(electronBinIn(stage, os));
      } catch (e) {
        throw new Error(
          `${name} unpacked without ${
            electronBinIn("<runtime>", os)
          } in it — the archive is not an Electron runtime for ${slug}.`,
          { cause: e },
        );
      }
      await Deno.writeTextFile(
        join(stage, STAMP),
        `${url}\nsha256:${actual}\n`,
      );

      await Deno.remove(dir, { recursive: true }).catch(() => {});
      await Deno.rename(stage, dir);
      log(`${OK} runtime ${version} (${slug}) ready`);
      return dir;
    } finally {
      await Deno.remove(stage, { recursive: true }).catch(() => {});
    }
  });
}
