/**
 * @module
 * Shared harness for the REAL-app E2E suites (onboarding-e2e, build-e2e):
 * scaffold a throwaway app against this repo, run its tasks, boot artifacts and
 * prove they serve. Not a test file (no `.test.ts`) — nothing here runs on its
 * own; it exists so the suites assert against ONE definition of "the app really
 * works" instead of drifting copies.
 */
import "./store-sandbox.ts";
import { assert } from "@std/assert";
import { join, resolve } from "@std/path";
import { scaffold } from "../src/am/am-cmd-create.ts";
import { stripVersionToken } from "../src/build/build-version.ts";
import { descendantPids } from "../src/server/single-instance-lock.ts";
import { aioTestDir } from "../src/testing/test-strict.ts";
import type { Template } from "../src/am/am-help-text.ts";
import { freePort } from "../src/testing/server-test.ts";

export const REPO_ROOT = resolve(import.meta.dirname!, "..");
const dec = new TextDecoder();

/** Scaffold a template app into a fresh temp dir with dep/aio → the repo. Each
 *  app gets a UNIQUE name so its appId (deno.json name → single-instance lock,
 *  compiled-binary identity) never collides with a sibling test's server. */
export async function makeApp(
  // Every template, typed from the one list — a hand-kept `"counter"|"todo"`
  // here is what stopped the onboarding gate from ever scaffolding `cli`,
  // `canvas` or `assets`. `scaffold` already accepts them all.
  tpl: Template = "counter",
  prefix = "onboard-",
  target?: Parameters<typeof scaffold>[3],
): Promise<string> {
  const name = `app-${crypto.randomUUID().slice(0, 8)}`;
  const dir = await Deno.makeTempDir({ prefix });
  for (
    const [rel, content] of Object.entries(scaffold(name, tpl, true, target))
  ) {
    const path = resolve(dir, rel);
    await Deno.mkdir(resolve(path, ".."), { recursive: true });
    await Deno.writeTextFile(path, content);
  }
  await Deno.mkdir(resolve(dir, "dep"), { recursive: true });
  await Deno.symlink(REPO_ROOT, resolve(dir, "dep/aio"));
  return dir;
}

/** Is this the compiled binary a FLEET build placed in dist/? Placed names
 *  carry THE build version (`app-0.1.7`, `app-0.1.0-nogit.9f3ac2b1`), so
 *  "has no dot" — the rule for a builder's unversioned output in the project
 *  root — is wrong there: strip the version token, then ask for no extension.
 *  On Windows the binary this host runs is `app-0.1.7.exe`: that extension,
 *  there only (elsewhere an `.exe` in dist/ is a cross-built artifact, not
 *  the binary a test can start). `os`: for the test of this rule. */
export function isPlacedBinary(
  name: string,
  os: string = Deno.build.os,
): boolean {
  if (name === "manifest.json") return false;
  const bare = os === "windows" && name.endsWith(".exe")
    ? name.slice(0, -4)
    : name;
  if (os === "windows" && bare === name) return false; // no `.exe`: not runnable there
  const stripped = stripVersionToken(bare);
  return stripped === bare ? false : !stripped.includes(".");
}

/** The one compiled binary a fleet build placed in `<dir>/dist/`. */
export function placedBinary(dir: string): string {
  const bins = [...Deno.readDirSync(resolve(dir, "dist"))]
    .filter((e) => e.isFile && isPlacedBinary(e.name)).map((e) => e.name);
  assert(
    bins.length === 1,
    `expected exactly one placed binary in dist/, got: ${
      bins.join(", ") || "none"
    }`,
  );
  return resolve(dir, "dist", bins[0]!);
}

/** Run the build with raw single-target flags (`dep/aio/src/build.ts
 *  --compile …`) — the spelling the pre-alpha52 `compile:*` tasks used.
 *
 *  It is no longer a second path: build.ts resolves the target from its own
 *  flags and runs the FLEET, so artifacts land in `dist/` with the version in
 *  the name, exactly as `deno task build` produces them. The scaffold no longer carries a task per
 *  target (alpha52 one-vocabulary diet: `build`/`compile` are the tasks), so
 *  target-specific artifact tests invoke the pipeline directly. */
export async function buildFlags(
  dir: string,
  ...flags: string[]
): Promise<{ code: number; out: string; err: string }> {
  const p = await new Deno.Command("deno", {
    args: ["run", "-A", "dep/aio/src/build.ts", ...flags],
    cwd: dir,
    stdout: "piped",
    stderr: "piped",
  }).output();
  return { code: p.code, out: dec.decode(p.stdout), err: dec.decode(p.stderr) };
}

/** Run `deno task <name> [args…]` in dir, capture output. */
export async function task(
  dir: string,
  name: string,
  ...extra: string[]
): Promise<{ code: number; out: string; err: string }> {
  const p = await new Deno.Command("deno", {
    args: ["task", name, ...extra],
    cwd: dir,
    stdout: "piped",
    stderr: "piped",
  }).output();
  return { code: p.code, out: dec.decode(p.stdout), err: dec.decode(p.stderr) };
}

/** A free TCP port — THE one `freePort` (src/testing), which draws from this
 *  run's port slice when one is set. The `port: 0` twin that stood here handed
 *  out a number another process's `port: 0` could be given before the child
 *  bound it ("port 45025 already in use", in test:build under load). */
export { freePort };

/** The environment EVERY app a test spawns must carry, spread into the child's
 *  `env`. Two facts, both about not outliving or escaping the test:
 *
 *  • `AIO_PARENT_PID` — the runtime stops itself when this process is gone.
 *    A test that hangs and is then killed by `timeout` never reaches its
 *    `finally`; without this the app it started is reparented to init and
 *    keeps serving (one ran 5 h, `--expose`d, advertising itself on the LAN).
 *  • `AIO_NO_OPEN` — no browser tab out of a test (see `open-external.ts`).
 *
 *  Spread it LAST so nothing in the test's own env can switch either off. */
export function childEnv(
  own: Record<string, string> = {},
): Record<string, string> {
  const chose = (k: string) => own[k] !== Deno.env.get(k) && own[k];
  return {
    AIO_PARENT_PID: String(Deno.pid),
    AIO_NO_OPEN: "1",
    // …and three, about not escaping into the developer's HOME. A spawned app
    // resolves its home as `~/.<appId>` when nothing pins it, and these
    // harnesses scaffold a UNIQUE appId per run — so running one test file
    // directly (`deno test -A tests/x.test.ts`, the documented way) left one
    // `~/.app-<hash>` behind per app. Fifty accumulated before anyone looked.
    // …and it is a FLOOR, never an override. This block is spread LAST so the
    // two safety variables above cannot be switched off — which meant the
    // sandbox clobbered the one a test had chosen for itself, and two LAN
    // tests then looked for their app's TLS cert in a directory the app had
    // never been pointed at. A caller that pins its own passes it in `own`.
    // `||`, not `??`: an EMPTY value reads as unset to the app, which then
    // takes `~/.<appId>` — so `AIO_APPS_DIR= deno test …` walked out of the
    // sandbox through the one variable that is the sandbox.
    AIO_APPS_DIR: own.AIO_APPS_DIR || Deno.env.get("AIO_APPS_DIR") ||
      _childAppsDir(),
    // …and four, the same escape one directory over. An app started with
    // `--client=electron` writes its window's main script into the window's
    // PROFILE directory, and Electron keeps the whole Chromium profile there
    // — which `AIO_APPS_DIR` does not move. Each test app has a unique name,
    // so each run left one more: 73 `~/.config/app-<id>@<hash>` on one
    // workstation, and 178 `aio-app@<hash>` no gate had a shape for. The
    // parent's own value is NOT inherited here — that one IS the developer's.
    // Per OS, {@linkcode accountEnv}; a test that names its own home keeps it
    // — NAMES: a value that only repeats this process's (the whole env spread
    // into `own`, as many callers do) is the developer's, not a choice.
    ...own,
    ...Object.fromEntries(
      Object.entries(accountEnv(
        chose(
          Deno.build.os === "windows"
            ? "USERPROFILE"
            : Deno.build.os === "darwin"
            ? "HOME"
            : "XDG_CONFIG_HOME",
        ) || _childConfigHome(),
      )).filter(([k]) => !chose(k)),
    ),
  };
}

/** The variables that decide where a child keeps what its OS files under the
 *  ACCOUNT — above all an Electron window's profile — pointed into `home`, a
 *  directory of the test's (default: this test file's own, as
 *  {@linkcode childEnv} hands out). Pure, given `home`.
 *
 *  - Linux: `$XDG_CONFIG_HOME` is the profile's parent, and it is all that is
 *    moved (HOME stays: the module and tool caches hang off it).
 *  - macOS: the profile is `~/Library/Application Support/<name>`, and there
 *    is no variable for that directory alone — so the home moves: `HOME` (what
 *    aio reads) and `CFFIXED_USER_HOME` (what Foundation, and so Electron,
 *    reads).
 *  - Windows: `%APPDATA%` (what aio reads) and `%USERPROFILE%`, from which
 *    the shell expands the known folders Electron asks it for.
 *
 *  Where the home moves, the two caches that hang off it are pinned back to
 *  the real ones: without `DENO_DIR` every spawn re-downloads its modules,
 *  without `XDG_CACHE_HOME` every window test a 100 MB Electron. */
export function accountEnv(
  home: string = _childConfigHome(),
  os: string = Deno.build.os,
  env: (k: string) => string | undefined = (k) => Deno.env.get(k),
): Record<string, string> {
  if (os !== "windows" && os !== "darwin") return { XDG_CONFIG_HOME: home };
  const real = env("HOME") ?? env("USERPROFILE");
  const local = os === "darwin"
    ? real && join(real, "Library", "Caches")
    : env("LOCALAPPDATA");
  const denoDir = env("DENO_DIR") ?? (local && join(local, "deno"));
  const cache = env("XDG_CACHE_HOME") || (real && join(real, ".cache"));
  return {
    XDG_CONFIG_HOME: home, // every OS: what follows XDG anywhere reads it
    ...(os === "darwin" ? { HOME: home, CFFIXED_USER_HOME: home } : {
      USERPROFILE: home,
      APPDATA: join(home, "AppData", "Roaming"),
      LOCALAPPDATA: join(home, "AppData", "Local"),
    }),
    ...(denoDir ? { DENO_DIR: denoDir } : {}),
    ...(cache ? { XDG_CACHE_HOME: cache } : {}),
  };
}

/** {@linkcode accountEnv} for THIS process, until disposed — for a test that
 *  launches a window in-process (`launchElectron()` reads the profile's
 *  parent from the environment it runs in): `using _home = ownAccount();`. */
export function ownAccount(): Disposable {
  const env = accountEnv();
  const prev = Object.keys(env).map((k) => [k, Deno.env.get(k)] as const);
  for (const [k, v] of Object.entries(env)) Deno.env.set(k, v);
  return {
    [Symbol.dispose]() {
      for (const [k, v] of prev) {
        if (v === undefined) Deno.env.delete(k);
        else Deno.env.set(k, v);
      }
    },
  };
}

/** One account home per test file ({@linkcode accountEnv}), under
 *  `<tmp>/aio/`, removed when the file unloads. Lazy, as
 *  {@linkcode _childAppsDir}. */
let _childConfig: string | undefined;
function _childConfigHome(): string {
  if (_childConfig) return _childConfig;
  const dir = _childConfig = aioTestDir("spawned-config-");
  globalThis.addEventListener("unload", () => {
    try {
      Deno.removeSync(dir, { recursive: true });
    } catch {
      // aio-ok: exit-time cleanup of a dir only this process made — see
      // `_childAppsDir`.
    }
  });
  return dir;
}

/** One sandbox per test PROCESS, under `<tmp>/aio/`. Lazy: a test file that
 *  never spawns an app never creates it.
 *
 *  THE PARENT ADOPTS IT TOO, and that is the load-bearing half.
 *
 *  A lock lives under `AIO_APPS_DIR`. `deno task test` sets one, so the test
 *  process and the app it spawns resolve the same directory and a test can
 *  watch the lock of its own child. Run that same file the way CLAUDE.md
 *  documents — `deno test -A tests/x.test.ts` — and there is no such variable:
 *  the child got this sandbox, the parent kept resolving the default, and
 *  `readLock()` looked in a directory nothing would ever write to. The test
 *  then failed as "app never started", 30 seconds after an app that had
 *  started perfectly well.
 *
 *  Measured on `tests/lock-lifetime.test.ts`, which could not pass standalone
 *  at all. A test that only works under one runner is a test that stops being
 *  run, and the failure it reports points at the product rather than at
 *  itself — the most expensive shape a harness bug can take.
 *
 *  Setting it here means the two sides agree BY CONSTRUCTION rather than by
 *  the caller remembering. When the variable already exists (the suite) this
 *  changes nothing: the value is read, not replaced. */
let _childApps: string | undefined;
function _childAppsDir(): string {
  if (_childApps) return _childApps;
  const dir = _childApps = aioTestDir("spawned-apps-");
  // The parent resolves locks, sockets and homes through the same variable.
  Deno.env.set("AIO_APPS_DIR", dir);
  // …and removes it when the process ends: one per standalone run
  // (check:mutations runs each test that way) piled up in `check:orphans`.
  globalThis.addEventListener("unload", () => {
    try {
      Deno.removeSync(dir, { recursive: true });
    } catch {
      // aio-ok: exit-time cleanup of a dir only this process made — "already
      // gone" is the goal, and a child still holding it is check:orphans' to
      // name, not a line here on every run.
    }
  });
  return dir;
}

/** Spawn a long-running process; drain stderr in the background so it can't
 *  block, and expose the accumulated log for failure messages. */
export function spawn(
  cmd: string,
  args: string[],
  cwd: string,
): { proc: Deno.ChildProcess; log: () => string } {
  const proc = new Deno.Command(cmd, {
    args,
    cwd,
    env: childEnv(),
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  let log = "";
  const drain = async (s: ReadableStream<Uint8Array>) => {
    for await (const c of s) log += dec.decode(c);
  };
  drain(proc.stderr).catch(() => {});
  drain(proc.stdout).catch(() => {});
  return { proc, log: () => log };
}

/** Poll a URL until it answers 200 (returns the body) or the deadline passes.
 *  `client` carries the CA for a server exposing HTTPS with its own self-signed
 *  cert (`--expose`) — the only way to probe it without disabling TLS checks.
 *  `headers` carries credentials: an exposed app is KEYED by default
 *  (alpha52), and health sits behind the key like every route
 *  (docs/state/lifecycle.md) — probes send `Authorization: Bearer <key>`. */
export async function waitForHttp(
  url: string,
  timeoutMs: number,
  client?: Deno.HttpClient,
  headers?: Record<string, string>,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastErr = "";
  while (Date.now() < deadline) {
    try {
      // `client` is a Deno-only RequestInit field (absent from the DOM type).
      const res = await fetch(
        url,
        {
          ...(headers ? { headers } : {}),
          ...(client ? { client } : {}),
        } as unknown as RequestInit,
      );
      const body = await res.text();
      if (res.ok) return body;
      lastErr = `HTTP ${res.status}`;
    } catch (e) {
      lastErr = String(e);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(
    `server never served ${url} within ${timeoutMs}ms (${lastErr})`,
  );
}

export async function killAnd(
  proc: Deno.ChildProcess,
  dir: string,
): Promise<void> {
  await kill(proc);
  await Deno.remove(dir, { recursive: true }).catch(() => {});
}

/** Kill a spawned process AND everything it started, then reap it.
 *
 *  Killing only the direct child is what leaves zombies behind. Several tests
 *  spawn a shell — `run.sh`, an installer, a task runner — which then starts
 *  the actual app; SIGKILL to the shell ends the shell and leaves the app
 *  running, still holding its port and its singleton lock. The next run then
 *  refuses to start ("Already running"), and the developer has to hunt the
 *  process down by hand before they can work. That is the whole complaint.
 *
 *  Never throws: cleanup runs in `finally` blocks, and a cleanup path that can
 *  throw turns one failing test into a failing test plus a leaked process. */
export async function kill(proc: Deno.ChildProcess): Promise<void> {
  // THE descendant walk (server/single-instance-lock.ts), not a third copy of
  // it: `am stop` and this harness are answering the same question — what did
  // this process start — and two answers to that is how one of them goes stale.
  if (Deno.build.os === "windows") {
    // No pgrep there, so the walk below finds nobody: `taskkill /T` is the
    // tree walk, taken while the parent lives (`killTree`, stop-child.ts).
    await new Deno.Command("taskkill", {
      args: ["/T", "/F", "/PID", String(proc.pid)],
      stdout: "null",
      stderr: "null",
    }).output().catch(() => {}); // aio-ok: no taskkill — the kill below still ends the child
  }
  let kids: number[] = [];
  try {
    kids = await descendantPids(proc.pid);
  } catch { /* pgrep missing (windows) — the direct child is still killed */ }
  try {
    proc.kill("SIGKILL");
  } catch { /* already gone */ }
  // Reaped even when the kill above found nobody: on Windows `taskkill` has
  // ended it by now and `proc.kill` throws (measured: "Child process has
  // already terminated"); a status left unread there is a leaked child to
  // the sanitizer — in every test that ends through here.
  await proc.status.catch(() => {}); // aio-ok: cleanup never throws
  // Deepest first, so a parent cannot spawn a replacement on its way out.
  for (const pid of kids.reverse()) {
    try {
      Deno.kill(pid, "SIGKILL");
    } catch { /* already gone, or not ours */ }
  }
}

/** Assert an HTTP body is real served markup from an aio app. */
export function assertServesApp(body: string): void {
  const lc = body.toLowerCase();
  assert(body.length > 20, "empty response body");
  assert(
    lc.includes("<!doctype") || lc.includes("<html") || lc.includes("<script"),
    `response is not HTML markup:\n${body.slice(0, 200)}`,
  );
}
