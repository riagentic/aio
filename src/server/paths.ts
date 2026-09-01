// Path resolution utilities — extracted from aio.ts (AIO-52)
// Pure functions for resolving KV, SQLite, UDS, and data directory paths.

import { dirname, fromFileUrl, join, resolve } from "@std/path";
import { heldLockKey, lockDir } from "./single-instance-lock.ts";
import { log } from "../diagnostics/logger-api.ts";
import { isPipePath, PIPE_PREFIX } from "./local-listen.ts";

export { isPipePath };

/** True when running inside a compiled binary (AppImage, deno compile) */
export function isCompiled(): boolean {
  if (Deno.env.get("APPIMAGE")) return true;
  // Deno compile VFS: modules embedded at file:///tmp/deno-compile-<app>/...
  if (import.meta.url.includes("/deno-compile-")) return true;
  return !import.meta.url.startsWith("file://");
}

/** Ordered `baseDir` (THE app dir) candidates, most authoritative first — the
 *  same shape `distCandidates` already has, applied to the directory every
 *  OTHER app asset is served from.
 *
 *  This exists because the two were not the same shape, and the gap shipped:
 *  `distCandidates` gave a compiled binary an entry-relative ladder so it finds
 *  its bundle from any cwd, `/__aio/icon` got a two-directory ladder so the app
 *  icon survives, and every other app asset got `<cwd>/src` alone — a directory
 *  that exists on no user's machine. `<img src="/assets/logo.svg">` was a real
 *  URL in dev (the dev server serves the app dir, the file is really there) and
 *  a broken-image glyph in the shipped AppImage, with every gate green, because
 *  no gate reads the artifact.
 *
 *  Entry-relative comes FIRST for a compiled binary. `deno compile` mirrors the
 *  project tree into a VFS rooted next to the entry module, and everything
 *  `compile.include` names is fully readable there — `readFile`, `stat` AND
 *  `realPath` all answer, which is exactly what `serveFile`'s symlink-escape
 *  guard needs. So the asset that SHIPPED inside the binary wins over whatever
 *  happens to sit in the directory the operator typed the command from.
 *
 *  `<cwd>/src` stays as the LAST candidate rather than being replaced: it was a
 *  compiled binary's only root before, so a binary run beside a real source
 *  tree keeps serving from it. Nothing that resolved before resolves
 *  differently unless the binary embeds that same path, which is the fix.
 *
 *  Uncompiled, the entry's directory is the whole answer and always has been —
 *  `deno run src/app.ts` is right regardless of cwd. */
export function baseDirCandidates(opts: {
  mainModule: string;
  cwd: string;
  compiled: boolean;
}): [string, ...string[]] {
  // Non-empty BY TYPE, not by comment: `<cwd>/src` is pushed whenever nothing
  // else resolved, so every caller can read [0] without a fallback of its own
  // — and a future edit that could return nothing fails to compile here.
  const out: string[] = [];
  const push = (dir: string) => {
    const c = resolve(dir);
    if (!out.includes(c)) out.push(c);
  };
  try {
    const main = new URL(opts.mainModule);
    if (main.protocol === "file:") push(fromFileUrl(new URL(".", main)));
  } catch { /* unusual entry (data:, http:) — the cwd fallback answers */ }
  if (opts.compiled || out.length === 0) push(join(opts.cwd, "src"));
  return out as [string, ...string[]];
}

/** Ordered `dist/` candidates for prod-detection in a COMPILED binary, most
 *  authoritative first. Pure (every input injected) so the ORDER — the part
 *  that broke — is unit-testable without compiling.
 *
 *  A compiled binary embeds `dist/` (via `--include dist/`) into the VFS next
 *  to the entry module, so entry-relative paths are the only candidates that
 *  hold regardless of cwd, exec location, or `dep/aio` nesting depth. They MUST
 *  come first: probing the real filesystem first (cwd, exec dir, module root)
 *  means a binary run from any directory without a real `dist/` beside it fails
 *  to detect prod, falls back to the dev lint (which needs `src/App.tsx` at
 *  cwd) and crashes — e.g. from an AppImage mount or a moved binary. */
export function distCandidates(opts: {
  mainModule: string;
  cwd: string;
  execDir: string;
  moduleDir: string | null;
}): string[] {
  const entryDist: string[] = [];
  try {
    // WALK UP to the compile root instead of guessing a fixed depth. The two
    // hardcoded guesses (`../dist`, `./dist`) assumed an entry exactly one
    // level down — `src/app.ts`. An entry at `src/server/app.ts` (one repo,
    // three apps) resolved to `src/dist` and `src/server/dist`, missed the
    // embedded copy, and the binary silently served the "Headless build — no
    // browser UI" page: the compile succeeded, dev was fine, and the failure
    // arrived as a 503 the first time anyone opened the shipped artifact
    // (R-5).
    //
    // The first two entries keep their historic order (parent, then the entry
    // dir) so nothing that worked changes; higher ancestors follow. The walk
    // stops at the filesystem root, and `deno compile` mirrors the project
    // tree under one VFS root, so the real dist/ is always one of these.
    const entryDir = resolve(fromFileUrl(new URL(".", opts.mainModule)));
    const seen = new Set<string>();
    const push = (dir: string) => {
      const c = resolve(join(dir, "dist"));
      if (!seen.has(c)) {
        seen.add(c);
        entryDist.push(c);
      }
    };
    push(dirname(entryDir));
    push(entryDir);
    let up = dirname(dirname(entryDir));
    for (let i = 0; i < 8; i++) {
      const parent = dirname(up);
      push(up);
      if (parent === up) break; // filesystem root
      up = parent;
    }
  } catch { /* mainModule not a file: URL — skip */ }
  return [...entryDist, ...realDistCandidates(opts)];
}

/** The subset of `distCandidates` that lives on the REAL filesystem — i.e. the
 *  ones a FOREIGN process can open.
 *
 *  Entry-relative candidates are deliberately excluded: in a compiled binary
 *  they point into Deno's virtual FS (`/tmp/deno-compile-<app>/…`), which only
 *  the Deno process can read. `Deno.stat` happily resolves it, so handing that
 *  path to Electron produced a path that exists for us and not for it — the
 *  AppImage blank-window bug: Electron's `fs.existsSync` said no, it fell back
 *  to `http://localhost:<port>`, and prod had already skipped the TCP server. */
export function realDistCandidates(opts: {
  cwd: string;
  execDir: string;
  moduleDir: string | null;
}): string[] {
  const moduleRoot = opts.moduleDir
    ? resolve(opts.moduleDir, "..", "..", "..")
    : null;
  return [
    resolve(join(opts.cwd, "dist")),
    resolve(join(opts.execDir, "dist")),
    ...(moduleRoot ? [resolve(join(moduleRoot, "dist"))] : []),
  ];
}

/** Returns user home directory — $HOME or $USERPROFILE, throws if neither set */
export function homedir(): string {
  const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE");
  if (!home) {
    throw new Error(
      "Cannot determine home directory — set $HOME environment variable",
    );
  }
  return home;
}

/** LEGACY layout only — `~/.local/share/<appId>/`, where auth.db / app.key /
 *  data.kv lived before the one-directory move. Both remaining callers only
 *  LOOK for files here (the migration, and the old-KV import), so this must not
 *  create the directory: doing so re-created the very location the move exists
 *  to retire, on every boot, for every app that had never used it.
 *  New code uses `appDirs()` — see src/server/app-dirs.ts. */
export function resolveDataDirLegacy(appId: string): string {
  const dataHome = Deno.env.get("XDG_DATA_HOME") ??
    join(homedir(), ".local", "share");
  return join(dataHome, appId);
}

/** LEGACY KV path — compiled apps only (dev let Deno pick its own location).
 *  Read to import an old `Deno.Kv` store into SQLite, nothing more. */
export function resolveKvPath(appId: string): string | undefined {
  if (!isCompiled()) return undefined;
  return join(resolveDataDirLegacy(appId), "data.kv");
}

/** Resolves transport: the LOCAL socket for a local electron app, WS
 *  otherwise. The name `"uds"` means "local socket" — a Unix domain socket on
 *  linux/mac, a named pipe on windows (`\\.\pipe\aio-<lockKey>`, hosted by
 *  Deno, see `win-pipe.ts`); every layer above the socket is the same.
 *  `--transport=ws` still forces WS on every OS. `os` is a parameter so the
 *  decision is a table, not a belief about the machine the tests run on. */
export function resolveTransport(
  transport: "uds" | "ws" | "auto" | undefined,
  useElectron: boolean,
  expose: boolean,
  os: typeof Deno.build.os = Deno.build.os,
): "uds" | "ws" {
  if (transport === "ws") return "ws";
  if (transport === "uds") return "uds";
  if (
    useElectron && !expose &&
    (os === "linux" || os === "darwin" || os === "windows")
  ) return "uds";
  return "ws";
}

/** Resolves a UDS socket path — `<lockDir>/{appId}.sock`, beside the lock
 *  files and inside the same 0700 directory (which is what makes a socket a
 *  stricter door than a loopback port: only the owning user can open it).
 *  On windows: the named pipe `\\.\pipe\aio-<lockKey>` (and `…-http`) — a
 *  kernel namespace, not the filesystem, so `isPipePath()` gates every
 *  remove/stat/chmod a socket file would get.
 *
 *  `kind` names a SECOND socket for the same app. An app running with no TCP
 *  port has two listeners — the NDJSON state/IPC transport on the bare path,
 *  and the HTTP handler that serves its page and modules on `.http.sock` —
 *  because one listener owns one path and the two speak different protocols.
 *  Naming them here keeps both spellings in one place; deriving the second one
 *  at its use site is how the client and the server end up looking for
 *  different files. */
export function resolveSocketPath(
  appId: string,
  kind?: "http",
  os: typeof Deno.build.os = Deno.build.os,
): string {
  if (os === "windows") {
    // A pipe NAME, not a file: no directory, no length limit, no unlink. The
    // lock key keeps the per-home identity exactly as the unix path does, so
    // `am --home` reaches the instance whose lock it read.
    return `${PIPE_PREFIX}aio-${heldLockKey(appId)}${kind ? `-${kind}` : ""}`;
  }
  const dir = lockDir();
  const suffix = kind ? `.${kind}.sock` : ".sock";
  // Named by the LOCK this process holds for the app (`<appId>@<hash8(home)>`
  // for a non-default home), so a second instance of one appId from another
  // home does not unlink and take the first one's socket — and `am --home`
  // reaches the instance whose lock it read.
  const sockPath = join(dir, `${heldLockKey(appId)}${suffix}`);
  if (sockPath.length > 100) {
    log.warn(
      `UDS path is ${sockPath.length} chars (limit ~108) — using /tmp/aio fallback`,
    );
    // The fallback used to drop `kind`, which was survivable while there was
    // one socket per app and is not now: both listeners would resolve to the
    // same path and the second would take the first one's door.
    const fallbackDir = "/tmp/aio";
    // …and it used to hand back a path in a directory nothing created. With
    // `$XDG_RUNTIME_DIR` set, `lockDir()` is somewhere else entirely, so
    // `/tmp/aio` might not exist (bind fails with ENOENT) or might be owned by
    // ANOTHER user with the default 0755 — the one place the "a socket is
    // protected by its 0700 directory" guarantee did not hold. Same treatment
    // as `lockDir()`: create it, and make it ours.
    try {
      Deno.mkdirSync(fallbackDir, { recursive: true });
      if (Deno.build.os !== "windows") Deno.chmodSync(fallbackDir, 0o700);
    } catch { /* best-effort — the bind below reports what actually failed */ }
    return join(fallbackDir, `${appId}${suffix}`);
  }
  return sockPath;
}

/** Find a free port in the private/ephemeral range 49152–65535 by attempting to bind */
export function findFreePort(): number {
  for (let i = 0; i < 50; i++) {
    const port = 49152 + Math.floor(Math.random() * 16384);
    try {
      const l = Deno.listen({ port, hostname: "127.0.0.1" });
      l.close();
      return port;
    } catch { /* taken — try another */ }
  }
  throw new Error(
    "no free port found in 49152-65535 after 50 attempts — the ephemeral range looks exhausted. Set an explicit port via aio.run({ port }) or --port=N.",
  );
}

/** The port an OPERATOR set in the environment — `AIO_PORT`.
 *
 *  It sits between `--port` and the app's own config: a systemd unit, a
 *  container, or `deno run --env-file` has no command line to hang `--port=`
 *  on, and a COMPILED binary in a service unit has neither. That is the whole
 *  gap this fills — which is also why aio does not read `.env` itself: one
 *  integer is not worth owning parse, precedence and secret-leak questions
 *  that `Deno.env` plus `--env-file` / `EnvironmentFile=` already answer.
 *
 *  A malformed value is REFUSED, never ignored: an app that silently drops
 *  `AIO_PORT=havoc` and binds an ephemeral port instead is the exact quiet
 *  misconfiguration this framework exists to make impossible. `0` is legal
 *  and means "pick a free one", the same as saying nothing.
 *
 *  THE one reader — `am` calls this too, so the operator's environment cannot
 *  mean one port to the app and another to the tool inspecting it. */
export function envPort(): number | undefined {
  let raw: string | undefined;
  try {
    raw = Deno.env.get("AIO_PORT");
  } catch {
    return undefined; // no --allow-env here: the environment is not readable
  }
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw.trim());
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    throw new Error(
      `AIO_PORT=${raw} is not a port (want an integer 0-65535; 0 means ` +
        `"pick a free one"). Fix or unset it — it will not be ignored.`,
    );
  }
  return n;
}

/** THE entry rule: an explicit `entry` (deno.json, or a per-target override),
 *  else `src/app.ts`.
 *
 *  Here rather than in `build/` because `am` needs the same answer and cannot
 *  import the build (folder matrix). It had its own probe list —
 *  `src/app.ts`, `src/main.ts`, `app.ts`, `main.ts` — so `am fix` could report
 *  a project healthy on the strength of a `main.ts` the build does not
 *  recognise and would never compile. Two spellings of "where does this app
 *  start" is one too many. */
export function resolveEntryPath(
  mainConfig: Record<string, unknown> | null | undefined,
  override?: string,
): string {
  return override?.trim() ||
    ((mainConfig?.entry as string | undefined) ?? "") ||
    "src/app.ts";
}

/** The address a SHIPPED client should default to, from deno.json
 *  `build.server`, normalised to a URL — or null when the app declares none.
 *
 *  `build.server` was manifest metadata and nothing else: the fleet recorded it,
 *  printed it, and refused a client-only build without it — and then the APK or
 *  AppImage that came out still opened a box asking the user to type an address
 *  the build already knew. A field deployment worked around it by rewriting a
 *  build-time constant.
 *
 *  Scheme is inferred, not required: `192.168.1.50:8000` is what people write in
 *  a config file, and demanding `http://` there is the kind of ceremony that
 *  gets an option abandoned. An explicit scheme is always honoured. */
export function bakedServerUrl(
  declared: string | null | undefined,
): string | null {
  const raw = (declared ?? "").trim();
  if (!raw) return null;
  const withScheme = /^https?:\/\//.test(raw) ? raw : `http://${raw}`;
  try {
    const u = new URL(withScheme);
    if (!u.hostname) return null;
    // No trailing slash: it is concatenated with paths downstream.
    return u.origin;
  } catch {
    return null;
  }
}
