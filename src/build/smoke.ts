/**
 * @module
 * `build --smoke` — START what was just built, and fail the build when it
 * does not come up clean.
 *
 * A green build says the artifact exists. Whether it boots, serves its page,
 * finds the files it was told to carry and stops again is a different claim,
 * and every field report of "works in dev, missing in the package" was that
 * gap: the first person to run the package was a user. This runs it here —
 * from a foreign cwd, with a throwaway home, on a free port, never on the
 * visible desktop — and turns each refusal into a build failure with its
 * line.
 *
 * The verdict rules are pure (unit-tested without a build); the runners are
 * the I/O around them. Internal — never re-exported from a public entry.
 */
import { dirname, join } from "@std/path";
import { cdpConnect } from "../media/cdp.ts";
import { HEY, NO } from "../diagnostics/fmt.ts";
import { APP_STYLE, BUNDLE_JS } from "../server/app-files.ts";
import { readDenoJson } from "../server/deno-json.ts";
import { declaredGuestPreloads } from "../server/guest-preloads.ts";
import {
  displayIsUp,
  nestedDisplayEnv,
  pickNestedDisplay,
  startXephyr,
  XEPHYR_INSTALL_HINT,
} from "../server/nested-display.ts";
import {
  descendantPids,
  isProcessAlive,
} from "../server/single-instance-lock.ts";
import { assetUrlsIn } from "./build-compile.ts";

/** Off, on, or `strict`: an artifact that COULD NOT be smoke-tested here
 *  (another OS, no display) is always listed; only `strict` makes it fail. */
export type SmokeMode = false | true | "strict";

/** `--smoke` / `--smoke=strict` (the flag wins), else deno.json
 *  `"build": { "smoke": true | "strict" }`. A value that is neither is
 *  refused — read as "off", a typo would skip the check it asked for. Pure. */
export function smokeMode(
  flag: { bare: boolean; value?: string },
  declared: unknown,
): SmokeMode {
  const bad = (where: string, v: unknown) =>
    new Error(
      `${NO} ${where} is ${JSON.stringify(v)} — it must be true, false or ` +
        `"strict" (--smoke, --smoke=strict).`,
    );
  if (flag.value !== undefined) {
    if (flag.value === "strict") return "strict";
    throw bad("--smoke=", flag.value);
  }
  if (flag.bare) return true;
  if (declared === undefined || declared === false) return false;
  if (declared === true || declared === "strict") return declared;
  throw bad("deno.json build.smoke", declared);
}

/** How one built target is smoke-tested on this host, or why it is not.
 *  Pure. `files` are the target's placed artifact names. */
export function smokePlan(opts: {
  kind: string;
  platform: string;
  hostPlatform: string;
  hostOs: string;
  files: readonly string[];
  /** The compiled binary's placed name, when the target has one. */
  binary?: string;
}):
  | { run: "server" | "cli" | "electron"; file: string; page: boolean }
  | { skip: string } {
  const { kind } = opts;
  if (opts.platform !== opts.hostPlatform) {
    return { skip: `not smoke-tested here: built for ${opts.platform}` };
  }
  if (kind === "electron") {
    const image = opts.files.find((f) => /\.appimage$/i.test(f));
    if (opts.hostOs !== "linux" || !image) {
      return {
        skip: `not smoke-tested here: the desktop smoke drives a Linux ` +
          `AppImage (this host: ${opts.hostOs})`,
      };
    }
    return { run: "electron", file: image, page: true };
  }
  if (kind === "browser" || kind === "server-app" || kind === "server") {
    if (!opts.binary) return { skip: "not smoke-tested: no binary was placed" };
    // `server` is headless: it has a health route and no page.
    return { run: "server", file: opts.binary, page: kind !== "server" };
  }
  if (kind === "cli") {
    if (!opts.binary) return { skip: "not smoke-tested: no binary was placed" };
    return { run: "cli", file: opts.binary, page: false };
  }
  return {
    skip: kind.endsWith("-client")
      ? `not smoke-tested: a ${kind} needs the server it connects to`
      : `not smoke-tested: a ${kind} artifact does not run on a build host`,
  };
}

/** The lines of an artifact's own output that mean it did not come up clean:
 *  anything logged at ERROR/FATAL, an uncaught error, and a `REFUSED` line
 *  (aio's refusals are spelled that way — a guest preload, a window). The
 *  smoke's own stop request is not one. Pure. */
export function logProblems(text: string): string[] {
  const out = new Set<string>();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const level = /^\d{4}-\d\d-\d\d \S+\s+(ERROR|FATAL)\s/.test(line);
    if (
      level || /\bREFUSED\b/.test(line) ||
      /^(?:error: )?Uncaught\b|^error: /.test(line)
    ) {
      // The file log repeats the console line with a `(file:line)` suffix.
      out.add(line.replace(/\s+\([\w.-]+:\d+\)$/, "").slice(0, 400));
    }
  }
  return [...out];
}

/** Same-origin URLs the served shell names (`src=` / `href=`) — the bundle,
 *  the stylesheet, the icon. Pure. */
export function shellUrls(html: string): string[] {
  const out = new Set<string>();
  for (
    const m of html.matchAll(
      /<(?:script|link|img)\b[^>]*?\b(?:src|href)\s*=\s*["']([^"']+)["']/gi,
    )
  ) {
    const u = m[1]!;
    if (u.startsWith("/") && !u.startsWith("//")) out.add(u.split("#")[0]!);
  }
  return [...out];
}

/** One row of the smoke table. */
export type SmokeRow = {
  target: string;
  artifact: string;
  status: "passed" | "FAILED" | "not smoke-tested";
  /** Failure lines, or the reason it was not run. */
  lines: string[];
};

/** The build's exit code for a smoke table. A row that was not run fails
 *  only under `strict`. Pure. */
export function smokeExit(rows: readonly SmokeRow[], mode: SmokeMode): number {
  return rows.some((r) =>
      r.status === "FAILED" ||
      (mode === "strict" && r.status === "not smoke-tested")
    )
    ? 1
    : 0;
}

/** The table, as lines. Pure. */
export function smokeTable(rows: readonly SmokeRow[]): string[] {
  const w = Math.max(...rows.map((r) => r.target.length), 6);
  return rows.flatMap((r) => [
    `  ${r.status === "passed" ? "✓" : r.status === "FAILED" ? "✗" : "–"} ` +
    `${r.target.padEnd(w)}  ${r.status.padEnd(16)}  ${r.artifact}`,
    ...r.lines.map((l) => `      ${l}`),
  ]);
}

// ── the runners ─────────────────────────────────────────────────────────────

const BOOT_MS = 90_000;
const STOP_MS = 20_000;
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A port nothing holds right now, on loopback. */
function freePort(): number {
  const l = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const { port } = l.addr as Deno.NetAddr;
  l.close();
  return port;
}

type Running = {
  proc: Deno.ChildProcess;
  exited: () => boolean;
  output: () => string;
  /** The throwaway dir: `home/` (AIO_APPS_DIR), `tmp/`, `cwd/`, `config/`. */
  box: string;
};

/** `spawn()`, or the throwaway dir gone with the throw: an artifact that is
 *  not there (or is no program) fails AT the spawn, before anything could
 *  `settle` the run — and each such build left one `aio-smoke-*` dir in the
 *  temp dir, which on Windows is also where the lock dirs live. */
function spawnOrDrop(
  box: string,
  spawn: () => Deno.ChildProcess,
): Deno.ChildProcess {
  try {
    return spawn();
  } catch (e) {
    Deno.removeSync(box, { recursive: true });
    throw e;
  }
}

/** Start `file` from a foreign cwd with a throwaway home — never the
 *  developer's data, config or temp dir. */
async function launch(
  file: string,
  args: string[],
  env: Record<string, string>,
): Promise<Running> {
  const box = await Deno.makeTempDir({ prefix: "aio-smoke-" });
  for (const d of ["home", "tmp", "cwd", "config"]) {
    await Deno.mkdir(join(box, d));
  }
  const proc = spawnOrDrop(box, () =>
    new Deno.Command(file, {
      args,
      cwd: join(box, "cwd"),
      env: {
        ...env,
        AIO_APPS_DIR: join(box, "home"),
        XDG_CONFIG_HOME: join(box, "config"),
        TMPDIR: join(box, "tmp"),
        TEMP: join(box, "tmp"),
        TMP: join(box, "tmp"),
        // Never a browser tab, and never an app that outlives a killed build.
        AIO_NO_OPEN: "1",
        AIO_PARENT_PID: String(Deno.pid),
      },
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).spawn());
  let text = "";
  let done = false;
  const dec = new TextDecoder();
  const drain = async (s: ReadableStream<Uint8Array>) => {
    for await (const c of s) text += dec.decode(c, { stream: true });
  };
  const drained = Promise.all([drain(proc.stdout), drain(proc.stderr)]);
  proc.status.then(() => drained).catch(() => {
    // aio-ok: a pipe that broke as the process died — what was read is kept
  }).finally(() => done = true);
  return { proc, exited: () => done, output: () => text, box };
}

/** The app's log files, as far as it wrote them. */
function appLogs(box: string): string {
  let t = "";
  try {
    for (const e of Deno.readDirSync(join(box, "home"))) {
      try {
        t += Deno.readTextFileSync(
          join(box, "home", e.name, "logs", "app.log"),
        );
      } catch {
        // aio-ok: not an app home (the lock dir), or no log yet
      }
    }
  } catch {
    // aio-ok: the app never created its home — its console output says why
  }
  return t;
}

/** The descendants still alive once the app has had `ms` to finish exiting.
 *
 *  Polled, not read once: an Electron package's helpers (zygote, GPU,
 *  utility) exit a few milliseconds AFTER the main process, so a single look
 *  right behind `await proc.status` failed a healthy build with "left N
 *  process(es) running". Returns as soon as none is left. `alive`/`wait` are
 *  test seams. */
export async function leftRunning(
  kids: readonly number[],
  ms = 3000,
  alive: (pid: number) => boolean = isProcessAlive,
  wait: (ms: number) => Promise<void> = delay,
): Promise<number[]> {
  let left = kids.filter(alive);
  for (let waited = 0; left.length && waited < ms; waited += 100) {
    await wait(100);
    left = left.filter(alive);
  }
  return left;
}

/** After the stop: nothing running, nothing left in the temp dir, and the
 *  throwaway dir removed. Appends what it finds to `fails`. */
async function settle(
  run: Running,
  kids: number[],
  fails: string[],
  stopped: boolean,
): Promise<void> {
  if (!stopped) {
    fails.push(
      `did not stop within ${STOP_MS / 1000}s of being asked — killed`,
    );
    try {
      run.proc.kill("SIGKILL");
    } catch {
      // aio-ok: exited between the wait and the kill
    }
  }
  await run.proc.status;
  const alive = await leftRunning(kids);
  if (alive.length) {
    fails.push(
      `left ${alive.length} process(es) running 3s after it exited: ${
        alive.join(", ")
      }`,
    );
    for (const pid of alive.reverse()) {
      try {
        Deno.kill(pid, "SIGKILL");
      } catch {
        // aio-ok: gone since the check
      }
    }
  }
  // Not the app's: `deno-compile-*` is the runtime's own extraction cache,
  // kept by design, and `appimage_extracted_*` is this smoke's own launch
  // mode (APPIMAGE_EXTRACT_AND_RUN — no FUSE needed). `.aio-roots` is the
  // lock-dir registry aio keeps beside its lock dir (where the temp dir
  // holds it — no XDG_RUNTIME_DIR, Windows), which outlives an app by design.
  const left = [...Deno.readDirSync(join(run.box, "tmp"))]
    .map((e) => e.name)
    .filter((n) =>
      !/^(?:deno-compile-|appimage_extracted_|\.aio-roots$)/.test(n)
    );
  if (left.length && stopped) {
    fails.push(`left in its temp dir after stopping: ${left.join(", ")}`);
  }
  try {
    await Deno.remove(run.box, { recursive: true });
  } catch (e) {
    fails.push(`its throwaway dir could not be removed (${run.box}): ${e}`);
  }
}

async function waitExit(run: Running, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until && !run.exited()) await delay(100);
  return run.exited();
}

const tail = (s: string) => s.trim().split("\n").slice(-6).join("\n      ");

/** Boot a compiled server binary, fetch what its page names, read its log,
 *  stop it. Returns the failure lines — empty is a pass. */
export async function smokeServer(opts: {
  file: string;
  /** False for a headless server: health only. */
  page: boolean;
  /** Does this URL path exist in the app's SOURCE dir (so dev serves it)? */
  inSource?: (urlPath: string) => boolean;
}): Promise<string[]> {
  const fails: string[] = [];
  const port = freePort();
  const run = await launch(opts.file, [`--port=${port}`], {});
  const base = `http://127.0.0.1:${port}`;
  let appId = "";
  let kids: number[] = [];
  let stopped = false;
  try {
    const until = Date.now() + BOOT_MS;
    let up = false;
    while (Date.now() < until && !run.exited() && !up) {
      try {
        const r = await fetch(`${base}/__aio/health`, {
          signal: AbortSignal.timeout(3000),
        });
        const body = await r.text();
        up = true;
        if (r.ok) appId = String(JSON.parse(body).appId ?? "");
        else fails.push(`GET /__aio/health → ${r.status}`);
      } catch {
        await delay(200); // aio-ok: not listening yet — the loop's deadline is the verdict
      }
    }
    if (!up) {
      fails.push(
        run.exited()
          ? `exited before it served anything:\n      ${tail(run.output())}`
          : `never answered ${base}/__aio/health within ${BOOT_MS / 1000}s:` +
            `\n      ${tail(run.output())}`,
      );
      return fails;
    }
    kids = await descendantPids(run.proc.pid);
    if (opts.page) {
      const get = async (path: string) => {
        const r = await fetch(base + path, {
          signal: AbortSignal.timeout(15_000),
        });
        return { status: r.status, text: await r.text() };
      };
      const shell = await get("/");
      if (shell.status !== 200) fails.push(`GET / → ${shell.status}`);
      else {
        // The bundle is loaded by the shell's inline module script, so it
        // is asked for by name; the stylesheet only when the shell names it
        // (an app on the generated theme ships none).
        let bundle = shell.text;
        const named = new Set([`/${BUNDLE_JS}`, ...shellUrls(shell.text)]);
        if (shell.text.includes(APP_STYLE)) named.add(`/${APP_STYLE}`);
        for (const u of named) {
          const r = await get(u);
          if (r.status !== 200) fails.push(`GET ${u} → ${r.status}`);
          else if (/\.(?:js|css)(?:\?|$)/.test(u)) bundle += r.text;
        }
        // The asset list of the artifact's OWN bundle — `assetUrlsIn`, the
        // decider the compile's warning uses. A URL the source tree cannot
        // answer either is a 404 in dev too: said, not failed (a literal is
        // a heuristic, and such a path may be a route).
        for (const u of assetUrlsIn(bundle)) {
          const r = await get(u);
          if (r.status === 200) continue;
          if (opts.inSource?.(u) === false) {
            console.warn(
              `${HEY} smoke: the bundle names ${u} (→ ${r.status}) and the ` +
                `source tree has no such file — not counted`,
            );
          } else {fails.push(
              `GET ${u} → ${r.status} (the page's bundle names it)`,
            );}
        }
      }
    }
    // Stop it the way `am stop` does — the one request that is graceful on
    // every OS — and let it finish its own teardown.
    try {
      const key = (await Deno.readTextFile(
        join(run.box, "home", appId, "data", "control.key"),
      )).trim();
      const r = await fetch(`${base}/__aio/trojan/shutdown`, {
        method: "POST",
        headers: { "X-AIO": "1", "X-Aio-Control": key },
        signal: AbortSignal.timeout(5000),
      });
      await r.body?.cancel();
      if (!r.ok) fails.push(`the stop request was answered ${r.status}`);
    } catch (e) {
      fails.push(
        `could not ask it to stop: ${e instanceof Error ? e.message : e}`,
      );
    }
    stopped = await waitExit(run, STOP_MS);
    for (const p of logProblems(run.output() + "\n" + appLogs(run.box))) {
      fails.push(`its log: ${p}`);
    }
    return fails;
  } finally {
    await settle(run, kids, fails, stopped || run.exited());
  }
}

/** A `cli` binary: `--help` from a foreign cwd with a throwaway home must
 *  exit 0 and log no error. (Its program is the app's own — `--help` is the
 *  one flag aio can promise it answers; see `smokeRunArtifact`.) */
export async function smokeCli(file: string): Promise<string[]> {
  const fails: string[] = [];
  const run = await launch(file, ["--help"], {});
  const done = await waitExit(run, 60_000);
  if (done) {
    const st = await run.proc.status;
    if (!st.success) {
      fails.push(`\`--help\` exited ${st.code}:\n      ${tail(run.output())}`);
    }
    for (const p of logProblems(run.output() + "\n" + appLogs(run.box))) {
      fails.push(`its log: ${p}`);
    }
  }
  await settle(run, [], fails, done);
  return fails;
}

/** The contained display a smoke-tested window opens on, or null when there
 *  is none: a nested X server owned by this user (started once, left
 *  running — `nested-display.ts`). Never the session's own display: a build
 *  must not put a window on the desktop of whoever is working there. */
export function smokeDisplayEnv(): Record<string, string> | null {
  const pick = pickNestedDisplay();
  if (!pick) return null;
  if (!pick.up && !startXephyr(pick.display)) return null;
  return displayIsUp(pick.display) ? nestedDisplayEnv(pick.display) : null;
}

/** The guest preloads the shell says it can attach — its startup line
 *  (`tmplGuestPreloads`), written after its own resolver (`__aioGuestPreload`,
 *  the one a `<webview>` attach asks) went through each. Pure. */
export function shellGuestPreloads(log: string): string[] {
  const m = /\[aio:electron\] guest preloads present in .*?: ([^\n]*)/.exec(
    log,
  );
  return m ? m[1]!.replace(/\s+\([\w.-]+:\d+\)$/, "").split(", ") : [];
}

/** The declared guest preloads the packaged shell cannot attach, as failure
 *  lines. A package holds only what was staged into it, so a file lost
 *  after staging is simply not there — the declaration is what knows it
 *  should be. Pure. */
export function missingGuestPreloads(
  declared: readonly string[],
  log: string,
): string[] {
  const has = shellGuestPreloads(log);
  return declared.filter((d) => !has.includes(d)).map((d) =>
    `guest preload REFUSED in the package: ${d} is declared in deno.json ` +
    `build.guestPreloads and the packaged shell cannot attach it (it has: ${
      has.join(", ") || "none"
    })`
  );
}

/** Launch the packaged desktop app on the contained display, wait for its
 *  page, check what the page names and what the shell says about its
 *  declared guest preloads, close it. Returns the failure lines, or
 *  `{ skip }` when there is no display to run it on. */
export async function smokeElectron(opts: {
  file: string;
  /** deno.json `build.guestPreloads` — each must resolve in the package. */
  guestPreloads: readonly string[];
}): Promise<string[] | { skip: string }> {
  const display = smokeDisplayEnv();
  if (!display) {
    return {
      skip: `not smoke-tested: no display (a nested X display keeps the ` +
        `window off your desktop — ${XEPHYR_INSTALL_HINT})`,
    };
  }
  const fails: string[] = [];
  const cdpPort = freePort();
  const run = await launch(opts.file, [`--cdp=${cdpPort}`], {
    ...display,
    APPIMAGE_EXTRACT_AND_RUN: "1",
  });
  let kids: number[] = [];
  let stopped = false;
  try {
    // The app's own page: `aio://…` in the packaged shell.
    let wsUrl = "";
    const until = Date.now() + BOOT_MS;
    while (Date.now() < until && !run.exited() && !wsUrl) {
      try {
        const r = await fetch(`http://127.0.0.1:${cdpPort}/json`, {
          signal: AbortSignal.timeout(3000),
        });
        const targets = await r.json() as Array<
          { type: string; url: string; webSocketDebuggerUrl: string }
        >;
        wsUrl = targets.find((t) =>
          t.type === "page" && t.url.startsWith("aio://")
        )?.webSocketDebuggerUrl ?? "";
      } catch {
        // aio-ok: the shell is not up yet — the loop's deadline is the verdict
      }
      if (!wsUrl) await delay(300);
    }
    if (!wsUrl) {
      fails.push(
        (run.exited()
          ? `exited before its window opened:`
          : `no app window within ${BOOT_MS / 1000}s:`) +
          `\n      ${tail(run.output())}`,
      );
      return fails;
    }
    kids = await descendantPids(run.proc.pid);
    const cdp = await cdpConnect(wsUrl, 10_000);
    const evaluate = async (expression: string): Promise<unknown> => {
      const r = await cdp.call("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      }) as { result?: { value?: unknown }; exceptionDetails?: unknown };
      if (r.exceptionDetails) {
        throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
      }
      return r.result?.value;
    };
    try {
      const loadBy = Date.now() + 30_000;
      let loaded = false;
      while (Date.now() < loadBy && !loaded) {
        loaded = await evaluate(
          `document.readyState === "complete" && !!document.body && ` +
            `document.body.childElementCount > 0`,
        ).catch(() => false) === true;
        if (!loaded) await delay(300);
      }
      if (!loaded) fails.push("its page never finished loading (30s)");
      else {
        // Every file the page names, asked of the shell that serves it.
        const statuses = await evaluate(`Promise.all(
  [...document.querySelectorAll("script[src],link[href],img[src]")]
    .map((e) => e.src || e.href).filter((u) => u.startsWith(location.origin))
    .map((u) => fetch(u).then((r) => [u, r.status], (e) => [u, String(e)])))`) as Array<
          [string, number | string]
        >;
        for (const [u, s] of statuses ?? []) {
          if (s !== 200) fails.push(`the page's ${u} → ${s}`);
        }
      }
      // The window closed is how a person quits a desktop app.
      await cdp.call("Browser.close").catch(() => {
        // aio-ok: the socket closes WITH the browser — no reply is the normal
        // outcome, and "did it stop" is judged by the process exit below
      });
    } finally {
      await cdp.close().catch(() => {
        // aio-ok: already closed by Browser.close
      });
    }
    stopped = await waitExit(run, STOP_MS);
    const log = run.output() + "\n" + appLogs(run.box);
    for (const p of logProblems(log)) fails.push(`its log: ${p}`);
    // Positive evidence, never "no refusal seen": what the shell itself
    // says it can attach, against what the app declares.
    fails.push(...missingGuestPreloads(opts.guestPreloads, log));
    return fails;
  } finally {
    await settle(run, kids, fails, stopped || run.exited());
  }
}

/** One built target, as the fleet knows it. */
export type SmokeTarget = {
  target: string;
  kind: string;
  platform: string;
  /** Root-relative entry module of this target. */
  entry: string;
  files: readonly string[];
  binary?: string;
};

type SmokeRun = Exclude<ReturnType<typeof smokePlan>, { skip: string }>;

/** Run one planned artifact: its failure lines, or why it could not run. */
async function smokeOne(
  root: string,
  outDir: string,
  t: SmokeTarget,
  plan: SmokeRun,
  cfg: Parameters<typeof declaredGuestPreloads>[0],
): Promise<string[] | { skip: string }> {
  const file = join(outDir, plan.file);
  if (Deno.build.os !== "windows") await Deno.chmod(file, 0o755);
  const appDir = join(root, dirname(t.entry));
  return plan.run === "electron"
    ? await smokeElectron({ file, guestPreloads: declaredGuestPreloads(cfg) })
    : plan.run === "cli"
    ? await smokeCli(file)
    : await smokeServer({
      file,
      page: plan.page,
      inSource: (u) => {
        try {
          Deno.statSync(join(appDir, u.slice(1)));
          return true;
        } catch {
          return false;
        }
      },
    });
}

/** Smoke-test every built target, print the table, return the exit code.
 *
 *  Each target on its own: a runner that THROWS (a fetch refused mid-boot, a
 *  CDP socket that closed, an artifact that is not there) is that target's
 *  FAILED row — it used to escape with no table and no row for the targets
 *  after it. `run` is the test seam for exactly that. */
export async function smokeBuild(opts: {
  root: string;
  outDir: string;
  mode: SmokeMode;
  hostPlatform: string;
  targets: readonly SmokeTarget[];
  run?: (
    t: SmokeTarget,
    plan: SmokeRun,
  ) => Promise<string[] | { skip: string }>;
}): Promise<number> {
  const rows: SmokeRow[] = [];
  const cfg = (await readDenoJson(opts.root))?.config;
  for (const t of opts.targets) {
    const plan = smokePlan({
      ...t,
      hostPlatform: opts.hostPlatform,
      hostOs: Deno.build.os,
    });
    if ("skip" in plan) {
      rows.push({
        target: t.target,
        artifact: t.files.join(", ") || "—",
        status: "not smoke-tested",
        lines: [plan.skip],
      });
      continue;
    }
    console.log(`smoke: starting ${plan.file} (${t.target})`);
    let res: string[] | { skip: string };
    try {
      res = await (opts.run?.(t, plan) ??
        smokeOne(opts.root, opts.outDir, t, plan, cfg));
    } catch (e) {
      res = [
        `the smoke run itself threw: ${
          e instanceof Error ? e.stack ?? e.message : String(e)
        }`,
      ];
    }
    rows.push(
      "skip" in res
        ? {
          target: t.target,
          artifact: plan.file,
          status: "not smoke-tested",
          lines: [res.skip],
        }
        : {
          target: t.target,
          artifact: plan.file,
          status: res.length ? "FAILED" : "passed",
          lines: res,
        },
    );
  }
  const code = smokeExit(rows, opts.mode);
  console.log(`\nsmoke`);
  for (const l of smokeTable(rows)) console.log(l);
  const skipped = rows.filter((r) => r.status === "not smoke-tested").length;
  if (skipped && opts.mode !== "strict") {
    console.warn(
      `${HEY} ${skipped} artifact(s) were NOT smoke-tested on this host — ` +
        `--smoke=strict makes that a failure`,
    );
  }
  if (code) {
    console.error(
      `${NO} smoke failed — the artifact(s) above are built and do not come up clean`,
    );
  }
  return code;
}
