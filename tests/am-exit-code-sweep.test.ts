// Every `am` verb, driven into a REAL failure, as a real subprocess.
//
// `am` is scripted against — `am create x && cd x`, `am health && deploy`,
// `am remove x --data && reinstall` — so a verb that fails and exits 0, or
// prints a success document after a side effect failed, lets the `&&` walk on
// into the wreck. 1.0.9-beta fixed one (`am remove` claimed success after a
// failed removal); `tests/am-failure-exits.test.ts` guards one SPELLING of the
// class statically. This file guards the BEHAVIOUR, for every verb at once:
//
//   - the exit code is 1 (`uninstall` forwards `deno uninstall`'s own code,
//     and says so in its row). `status` documents 1 = stopped and gets no
//     pass for it: its row is an unknown component, a real error.
//   - no success document: stdout is JSON documents only, none carries
//     `ok: true`, and one carries `error`.
//   - the error NAMES what failed (a per-row pattern over stdout + stderr).
//
// The verb list is read from the `COMMANDS` map in src/am.ts — the table that
// actually dispatches — never a hand list. A verb added there without a row in
// SCENARIOS turns this file red; so does a row for a verb that no longer
// exists. Verbs that need a GUI, an emulator, docker or the network are driven
// into a failure that happens BEFORE that dependency, and `why` says so. Where
// a verb has a side effect that can cheaply be made to fail (a write into a
// path that is a file, a mkdir that collides), that is the row: it is the
// class 1.0.9 was about.
//
// Sandbox: HOME, AIO_APPS_DIR, AIO_INSTALL_ROOT, DENO_INSTALL_ROOT and
// XDG_RUNTIME_DIR all point into one temp dir, the environment is cleared, and
// no DISPLAY is passed — nothing here can reach the real home, a real app's
// lock, or a real desktop. `uninstall` runs against a fake `deno` on PATH that
// fails, so the real `deno uninstall -g am` never runs from a test.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const AM = new URL("../src/am.ts", import.meta.url).pathname;
const CONFIG = new URL("../deno.json", import.meta.url).pathname;
const LOCK_MOD = new URL(
  "../src/server/single-instance-lock.ts",
  import.meta.url,
).href;
/** An app id nothing registers, runs, or installs. */
const GHOST = "amsweepghost";

/** The registry keys, read from source — importing src/am.ts would run its
 *  CLI. The same reader `am-help-covers-every-command` uses. */
async function registeredVerbs(): Promise<string[]> {
  const src = await Deno.readTextFile(AM);
  const from = src.indexOf("const COMMANDS");
  const body = src.slice(from, src.indexOf("\n};", from));
  return [...body.matchAll(/^ {2}([a-z][a-zA-Z]*):/gm)].map((m) => m[1]!);
}

/** The disposable world one sweep runs in. */
interface World {
  /** Temp root; everything below lives in it. */
  base: string;
  /** HOME for the child. */
  home: string;
  /** An empty directory: no deno.json, no src/ — the default cwd. */
  empty: string;
  /** A regular FILE — a path that cannot be a directory. */
  file: string;
  /** An app (deno.json) whose `src` is a FILE, so every write under it fails. */
  app: string;
  /** A home whose `~/.local/share/aio` is a FILE. */
  brokenHome: string;
  /** A port nothing listens on, from freePort(). */
  port: number;
  /** Absolute DENO_DIR of the parent, so a cleared env still has the cache. */
  denoDir: string;
}

/** What a row needs beyond the defaults, set up just before it runs. */
interface Prep {
  cwd?: string;
  env?: Record<string, string>;
  cleanup?: () => Promise<void>;
}

interface Scenario {
  /** Everything after `am` (the verb included). `--json` is appended. */
  argv: (w: World) => string[];
  /** The error must name what failed — matched against stdout + stderr. */
  names: RegExp;
  /** The failure class driven, and for GUI/net verbs why this one. */
  why: string;
  /** Exit code wanted; 1 unless the row says why not. */
  code?: number;
  prepare?: (w: World) => Promise<Prep>;
}

/** "amsweepghost … not running", in either order and any of am's phrasings. */
const ghostDown = new RegExp(
  `${GHOST}[\\s\\S]*(?:not running|nothing is running)|` +
    `(?:not running|no running app)[\\s\\S]*${GHOST}`,
  "i",
);

/** A row whose only need is a nothing-running target. */
const down = (verb: string, ...rest: string[]): Scenario => ({
  argv: () => [verb, ...rest, `--app=${GHOST}`],
  names: ghostDown,
  why: "nothing running under that app id",
});

/** One row per verb in src/am.ts's COMMANDS — enforced below. */
const SCENARIOS: Record<string, Scenario> = {
  // ── Process ────────────────────────────────────────────────────────
  // start/restart take their OWN ids: `start` files a placeholder lock
  // ("starting", port 0) before it finds the entry missing, and a sibling row
  // aimed at GHOST (`stop`) that lands inside that window reads it as live.
  start: {
    argv: () => ["start", "--app=amsweepstart", "--entry=src/nope.ts"],
    names: /nope\.ts/,
    why: "entry file does not exist",
  },
  stop: down("stop"),
  kill: down("kill"),
  restart: {
    argv: () => ["restart", "--app=amsweeprestart", "--entry=src/nope.ts"],
    names: /nope\.ts/,
    why: "entry file does not exist",
  },
  status: {
    argv: () => ["status", "nosuchcomponent", `--app=${GHOST}`],
    names: /nosuchcomponent/,
    why: "unknown component (exit 1 alone is its documented 'stopped', so " +
      "the row is an actual error)",
  },
  watch: {
    argv: (w) => ["watch", join(w.empty, "no-such-dir"), `--app=${GHOST}`],
    names: /no-such-dir/,
    why: "watched directory does not exist — refused before a child starts",
  },
  instances: {
    argv: () => ["instances", "--nosuchflag"],
    names: /nosuchflag/,
    why: "a listing with no failure of its own (an unreadable lock dir is " +
      "an empty scope); the central flag gate is its failure",
  },
  // ── State ──────────────────────────────────────────────────────────
  state: down("state"),
  expect: down("expect", "x", "eq", "1"),
  record: {
    argv: (w) => ["record", `--from=${join(w.empty, "none.jsonl")}`],
    names: /none\.jsonl/,
    why: "journal file does not exist",
  },
  timeline: {
    argv: (w) => ["timeline", `--from=${join(w.empty, "none.jsonl")}`],
    names: /none\.jsonl/,
    why: "journal file does not exist",
  },
  replay: {
    argv: (w) => ["replay", `--from=${join(w.empty, "none.jsonl")}`],
    names: /none\.jsonl/,
    why: "journal file does not exist",
  },
  ui: {
    argv: () => ["ui", "someuser"],
    names: /state --ui someuser/,
    why: "old spelling, refused BEFORE amui (Electron) would launch",
  },
  open: { ...down("open"), why: "nothing running — before a browser opens" },
  dispatch: down("dispatch", "counter:inc"),
  actions: down("actions"),
  timetravel: down("timetravel", "undo"),
  persist: down("persist"),
  snapshot: down("snapshot", "load", "none.json"),
  // ── Data ───────────────────────────────────────────────────────────
  data: {
    argv: () => ["data", "extra"],
    names: /takes no arguments/,
    why: "a stray positional (the verb only reports paths)",
  },
  backup: {
    argv: (w) => ["backup", join(w.file, "dest"), "--app=amsweepbak"],
    names: /dest/,
    why: "FAILED SIDE EFFECT: data exists, the destination's parent is a file",
    prepare: async (w) => {
      const data = join(w.base, "apps", "amsweepbak", "data");
      await Deno.mkdir(data, { recursive: true });
      await Deno.writeTextFile(join(data, "state.db"), "");
      return {};
    },
  },
  restore: {
    argv: (w) => ["restore", join(w.empty, "no-backup"), `--app=${GHOST}`],
    names: /no-backup/,
    why: "backup directory does not exist",
  },
  migrations: down("migrations"),
  report: {
    argv: () => ["report", "show", "nosuchreport", `--app=${GHOST}`],
    names: /nosuchreport/,
    why: "no report with that id",
  },
  // ── Inspect ────────────────────────────────────────────────────────
  clients: down("clients"),
  client: down("client", "0"),
  surface: down("surface"),
  trigger: down("trigger", "App/Button", "click"),
  where: {
    argv: (w) => ["where", join(w.empty, "nope.ts")],
    names: /nope\.ts/,
    why: "file does not exist",
  },
  feedback: {
    argv: () => ["feedback", "someapp", "--create"],
    names: /feedback/,
    why: "FAILED SIDE EFFECT: the feedback dir cannot be created",
    prepare: (w) => Promise.resolve({ env: { HOME: w.brokenHome } }),
  },
  check: {
    argv: () => ["check", "src/Nope.tsx"],
    names: /Nope\.tsx/,
    why: "an entry the caller NAMED does not exist (the default one being " +
      "absent is a documented server-only pass)",
  },
  migrate: {
    argv: () => ["migrate"],
    names: /deno\.json/,
    why: "not inside an app",
  },
  testgen: {
    argv: () => ["testgen", "src/nope.tsx"],
    names: /nope\.tsx/,
    why: "entry file does not exist",
  },
  preview: {
    argv: (w) => ["preview", join(w.empty, "nope.tsx")],
    names: /nope\.tsx/,
    why: "component file does not exist",
  },
  shot: { ...down("shot"), why: "nothing running — before CDP/Electron" },
  eval: { ...down("eval", "1+1"), why: "nothing running — before CDP" },
  sql: down("sql", "select 1"),
  tables: down("tables"),
  schedules: down("schedules"),
  logs: {
    argv: () => ["logs", `--app=${GHOST}`],
    names: /no log file/,
    why: "no log file",
  },
  errors: down("errors"),
  metrics: down("metrics"),
  heap: down("heap"),
  cost: down("cost"),
  top: down("top"),
  health: {
    argv: (w) => ["health", `--port=${w.port}`],
    names: /not running on port \d+/,
    why: "nothing answers on a free port",
  },
  doctor: {
    argv: () => ["doctor"],
    names: /framework the disk no longer has/,
    why: "a running instance (a live pid + its lock) started BEFORE its " +
      "dep/aio was last written — the stale-process finding",
    prepare: async (w) => {
      const dir = join(w.base, "doctor-app");
      const fw = join(dir, "dep", "aio");
      await Deno.mkdir(join(fw, "src"), { recursive: true });
      await Deno.writeTextFile(join(fw, "mod.ts"), "export {};\n");
      await Deno.writeTextFile(join(fw, "src", "x.ts"), "export {};\n");
      await Deno.writeTextFile(
        join(dir, "deno.json"),
        JSON.stringify({ name: "amsweepdoctor" }),
      );
      const apps = join(w.base, "apps-doctor");
      // A process that is alive for the whole run, standing in for the app.
      const sleeper = new Deno.Command("sleep", {
        args: ["300"],
        stdin: "null",
        stdout: "null",
        stderr: "null",
      }).spawn();
      const lock = {
        appId: "amsweepdoctor",
        pid: sleeper.pid,
        port: freePort(),
        startedAt: 1000, // 1970: every file under dep/aio is newer
        status: "started",
        cwd: dir,
      };
      // Written by a child with the SAME env the verb gets, so the lock lands
      // in the lock dir `am doctor` will read — the parent never mutates its
      // own environment.
      const wrote = await new Deno.Command(Deno.execPath(), {
        args: [
          "eval",
          `import { writeLock } from ${JSON.stringify(LOCK_MOD)};` +
          `writeLock(${JSON.stringify(lock)});`,
        ],
        clearEnv: true,
        env: sandboxEnv(w, { AIO_APPS_DIR: apps }),
        stdout: "null",
        stderr: "piped",
      }).output();
      assert(wrote.success, new TextDecoder().decode(wrote.stderr));
      return {
        cwd: dir,
        env: { AIO_APPS_DIR: apps },
        cleanup: async () => {
          sleeper.kill("SIGKILL");
          await sleeper.status;
        },
      };
    },
  },
  discover: {
    argv: () => ["discover", "--timeout=abc"],
    names: /--timeout/,
    why: "invalid --timeout, refused BEFORE the UDP broadcast",
  },
  profile: {
    ...down("profile"),
    why: "nothing running (no exposed instance to export from)",
  },
  pair: down("pair"),
  config: down("config"),
  // ── Auth ───────────────────────────────────────────────────────────
  auth: {
    argv: () => ["auth", "users", `--app=${GHOST}`],
    names: /auth\.db/,
    why: "no auth.db for that app",
  },
  // ── Meta / scaffold / build ────────────────────────────────────────
  create: {
    argv: (w) => [
      "create",
      "myapp",
      "--force",
      `--mirror=${join(w.base, "throwaway-aio")}`,
    ],
    names: /myapp\/src/,
    why: "FAILED SIDE EFFECT: ./myapp/src is a FILE, so the scaffold's write " +
      "fails mid-way. `--mirror` at a throwaway checkout: the default path " +
      "provisions a `git worktree` of THIS repo into the temp HOME, which " +
      "would leave a dangling registration in the real .git",
    prepare: async (w) => {
      const cwd = join(w.base, "create-cwd");
      await Deno.mkdir(join(cwd, "myapp"), { recursive: true });
      await Deno.writeTextFile(join(cwd, "myapp", "src"), "not a dir\n");
      const fake = join(w.base, "throwaway-aio");
      await Deno.mkdir(fake, { recursive: true });
      await Deno.writeTextFile(join(fake, "mod.ts"), "export {};\n");
      return { cwd };
    },
  },
  build: {
    argv: () => ["build"],
    names: /no "build" task/,
    why: "the app declares no build task — before any bundler runs",
    prepare: (w) => Promise.resolve({ cwd: w.app }),
  },
  compile: {
    argv: () => ["compile"],
    names: /no "compile" task/,
    why: "the app declares no compile task — before any compiler runs",
    prepare: (w) => Promise.resolve({ cwd: w.app }),
  },
  dev: {
    argv: () => ["dev"],
    names: /no "dev" task/,
    why: "no dev task — refused before a foreground server would run",
    prepare: (w) => Promise.resolve({ cwd: w.app }),
  },
  publish: {
    argv: () => ["publish"],
    names: /build failed — nothing was published/,
    why: "FAILED SIDE EFFECT: its build step fails — before sign/upload",
    prepare: (w) => Promise.resolve({ cwd: w.app }),
  },
  add: {
    argv: () => ["add", "cell", "foo"],
    names: /src\/cell/,
    why: "FAILED SIDE EFFECT: src/ is a file, so the scaffold write fails",
    prepare: (w) => Promise.resolve({ cwd: w.app }),
  },
  pin: {
    argv: (w) => ["pin", `--aio=${join(w.empty, "no-aio")}`],
    names: /no-aio/,
    why: "an explicit --aio that is not an aio checkout",
    prepare: (w) => Promise.resolve({ cwd: w.app }),
  },
  lab: {
    argv: () => ["lab", "plan9"],
    names: /plan9/,
    why: "unknown OS — refused before docker/KVM is touched",
  },
  theme: {
    argv: () => ["theme", "adopt"],
    names: /aio-theme\.css/,
    why: "FAILED SIDE EFFECT: src/ is a file, so the stylesheet write fails",
    prepare: (w) => Promise.resolve({ cwd: w.app }),
  },
  link: {
    argv: (w) => ["link", `--aio=${join(w.empty, "no-aio")}`],
    names: /no-aio/,
    why: "an explicit --aio that is not an aio checkout (it used to fall " +
      "back to another framework and report linked:true)",
    prepare: async (w) => {
      const cwd = join(w.base, "dep-app");
      await Deno.mkdir(cwd, { recursive: true });
      await Deno.writeTextFile(
        join(cwd, "deno.json"),
        JSON.stringify({ imports: { aio: "./dep/aio/mod.ts" } }),
      );
      return { cwd };
    },
  },
  fix: {
    argv: () => ["fix"],
    names: /blocker/,
    why: "a blocker it cannot repair (no aio import at all)",
    prepare: (w) => Promise.resolve({ cwd: w.app }),
  },
  prune: {
    argv: () => ["prune", "--days=abc"],
    names: /--days/,
    why: "invalid --days, refused before the machine-wide cache is read",
  },
  uninstall: {
    argv: () => ["uninstall"],
    names: /uninstall failed/,
    code: 3, // forwards `deno uninstall`'s own exit code — non-zero, as-is
    why: "FAILED SIDE EFFECT: the `deno uninstall` it runs fails (a fake " +
      "deno on PATH — the real one is never run from a test)",
    prepare: async (w) => {
      const bin = join(w.base, "failbin");
      await Deno.mkdir(bin, { recursive: true });
      await Deno.writeTextFile(
        join(bin, "deno"),
        "#!/bin/sh\necho 'error: fake deno refuses (am sweep)' >&2\nexit 3\n",
        { mode: 0o755 },
      );
      return { env: { PATH: `${bin}:${Deno.env.get("PATH") ?? ""}` } };
    },
  },
  remove: {
    argv: () => ["remove", GHOST],
    names: new RegExp(`nothing installed as "${GHOST}"`),
    why: "no such installed app",
  },
  installed: {
    argv: () => ["installed"],
    names: /install root/,
    why: "the install root is a FILE (unreadable) — it used to list as empty",
    prepare: (w) => Promise.resolve({ env: { AIO_INSTALL_ROOT: w.file } }),
  },
  upgrade: {
    argv: () => ["upgrade", GHOST],
    names: new RegExp(`no install record for "${GHOST}"`),
    why: "no install record — refused before run.sh/network",
  },
  version: {
    argv: () => ["version", "--nosuchflag"],
    names: /nosuchflag/,
    why: "cannot fail on its own; the central flag gate is its failure",
  },
  trust: {
    argv: () => ["trust"],
    names: /aio root/,
    why: "FAILED SIDE EFFECT: the root CA's directory cannot be created",
    prepare: (w) =>
      Promise.resolve({ env: { AIO_APPS_DIR: join(w.file, "apps") } }),
  },
  agent: {
    argv: () => ["agent", "--task=nosuchtask"],
    names: /nosuchtask/,
    why: "unknown section slug",
  },
  help: {
    argv: () => ["help", "nosuchverb"],
    names: /nosuchverb/,
    why: "help for a verb that does not exist",
  },
};

/** Every JSON document on stdout — one per line (compact: stdout is a pipe). */
function jsonDocs(stdout: string): { docs: unknown[]; junk: string[] } {
  const docs: unknown[] = [];
  const junk: string[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    try {
      docs.push(JSON.parse(line));
    } catch {
      junk.push(line);
    }
  }
  return { docs, junk };
}

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

/** The whole child environment — cleared, then only what am needs. */
function sandboxEnv(
  w: World,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
    DENO_DIR: w.denoDir,
    HOME: w.home,
    AIO_APPS_DIR: join(w.base, "apps"),
    AIO_INSTALL_ROOT: join(w.home, "app"),
    DENO_INSTALL_ROOT: join(w.home, ".deno"),
    XDG_RUNTIME_DIR: join(w.base, "run"),
    AIO_AM_NO_DELEGATE: "1",
    NO_COLOR: "1",
    ...extra,
  };
}

async function runAm(
  w: World,
  argv: string[],
  prep: Prep = {},
): Promise<Run> {
  const o = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "--config", CONFIG, AM, ...argv],
    cwd: prep.cwd ?? w.empty,
    clearEnv: true,
    env: sandboxEnv(w, prep.env),
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  const d = new TextDecoder();
  return {
    code: o.code,
    stdout: d.decode(o.stdout),
    stderr: d.decode(o.stderr),
  };
}

/** Why a run is NOT an honest failure, or null. Pure. */
function verdict(s: Scenario, r: Run): string | null {
  const want = s.code ?? 1;
  if (r.code !== want) return `exit ${r.code} (want ${want})`;
  const { docs, junk } = jsonDocs(r.stdout);
  if (junk.length) return `non-JSON on stdout: ${junk[0]!.slice(0, 160)}`;
  const objs = docs.filter((d): d is Record<string, unknown> =>
    typeof d === "object" && d !== null
  );
  if (objs.some((d) => d.ok === true)) return `success doc: ${r.stdout}`;
  if (!objs.some((d) => typeof d.error === "string" && d.error !== "")) {
    return `no {error} document on stdout: ${
      r.stdout.slice(0, 200) || "(empty)"
    }`;
  }
  // EXACTLY ONE document, and it is the error. A failure that prints its
  // {error} and then a success-SHAPED document (`{"removed":3}` — no `ok`
  // key, so the check above is blind to it) hands a `| jq .removed` script
  // a number from a command that failed. Anything that is not the error is
  // a second answer, and a failed command has only one.
  if (docs.length !== 1) {
    return `${docs.length} JSON documents on stdout (want exactly the one ` +
      `{error}): ${r.stdout.slice(0, 240)}`;
  }
  // Matched against the DECODED error text (JSON escapes a quote as \")
  // plus stderr, where pretty-mode prose and warnings go.
  const said = objs.map((d) => String(d.error ?? "")).join("\n") + "\n" +
    r.stderr;
  if (!s.names.test(said)) {
    return `error does not name ${s.names}: ${said.slice(0, 240)}`;
  }
  return null;
}

async function makeWorld(): Promise<World> {
  const base = await tempDir("am-exit-sweep-");
  const w: World = {
    base,
    home: join(base, "home"),
    empty: join(base, "cwd"),
    file: join(base, "a-file"),
    app: join(base, "app"),
    brokenHome: join(base, "broken-home"),
    port: freePort(),
    denoDir: await denoDirOf(),
  };
  for (
    const d of [
      w.home,
      w.empty,
      join(w.app),
      join(w.brokenHome, ".local", "share"),
      join(base, "apps"),
      join(base, "run"),
    ]
  ) {
    await Deno.mkdir(d, { recursive: true, mode: 0o700 });
  }
  await Deno.writeTextFile(w.file, "a file, not a directory\n");
  await Deno.writeTextFile(
    join(w.app, "deno.json"),
    JSON.stringify({ name: "amsweepapp" }),
  );
  await Deno.writeTextFile(join(w.app, "src"), "a file where src/ goes\n");
  await Deno.writeTextFile(
    join(w.brokenHome, ".local", "share", "aio"),
    "a file where the aio data dir goes\n",
  );
  return w;
}

async function denoDirOf(): Promise<string> {
  const o = await new Deno.Command(Deno.execPath(), {
    args: ["info", "--json"],
    stdout: "piped",
    stderr: "null",
  }).output();
  return JSON.parse(new TextDecoder().decode(o.stdout)).denoDir;
}

/** Paths of THIS repo's registered git worktrees — the sweep must not add
 *  any. (Filtered to the sweep's temp dir by the callers: other sessions may
 *  add their own worktrees to the same repo while this runs.) */
async function worktrees(): Promise<string[]> {
  const o = await new Deno.Command("git", {
    args: ["worktree", "list", "--porcelain"],
    cwd: new URL("..", import.meta.url).pathname,
    stdout: "piped",
    stderr: "null",
  }).output();
  assert(o.success, "git worktree list failed");
  return new TextDecoder().decode(o.stdout).split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice("worktree ".length));
}

/** Run `fn` over `items`, `n` at a time, results in input order. */
async function pool<T, R>(
  items: T[],
  n: number,
  fn: (t: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

Deno.test("am exit-code sweep: every registered verb has a failure scenario", async () => {
  const verbs = await registeredVerbs();
  assert(verbs.length >= 60, `COMMANDS parse found only ${verbs.length}`);
  const rows = Object.keys(SCENARIOS);
  assertEquals(
    verbs.filter((v) => !rows.includes(v)),
    [],
    "verbs `am` runs with no failure scenario here — add a row to SCENARIOS",
  );
  assertEquals(
    rows.filter((v) => !verbs.includes(v)),
    [],
    "scenarios for verbs `am` no longer has",
  );
});

Deno.test({
  name:
    "am exit-code sweep: every verb fails with its exit code, no success doc, and names what failed",
  // POSIX fixtures: a `sleep` stands in for a live app, and the fake `deno`
  // that `uninstall` runs is a shell script.
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const w = await makeWorld();
    try {
      const verbs = await registeredVerbs();
      const results = await pool(verbs, 3, async (verb) => {
        const s = SCENARIOS[verb];
        if (!s) return `${verb}: no scenario (see the coverage test)`;
        const argv = [...s.argv(w), "--json"];
        if (argv[0] !== verb) return `${verb}: its row drives \`${argv[0]}\``;
        const prep = (await s.prepare?.(w)) ?? {};
        try {
          const bad = verdict(s, await runAm(w, argv, prep));
          return bad ? `am ${argv.join(" ")}\n      → ${bad}` : null;
        } finally {
          await prep.cleanup?.();
        }
      });
      const offenders = results.filter((x): x is string => x !== null);
      assertEquals(
        offenders,
        [],
        `${offenders.length} verb(s) failed dishonestly:\n  ` +
          offenders.join("\n  "),
      );
      // Every row ran — a loop that visits nothing proves nothing.
      assertEquals(results.length, verbs.length);
      // A failed verb must not leave debris where it was run.
      assertEquals([...Deno.readDirSync(w.empty)].map((e) => e.name), []);
      // …nor in the REAL repo: `am create` (default path), `pin`, `link` and
      // `fix` provision framework versions as `git worktree`s of the aio
      // checkout am runs from — this one. A worktree under the temp HOME is a
      // registration in this repo's .git that dangles once the dir is gone.
      assertEquals(
        (await worktrees()).filter((p) => p.startsWith(w.base)),
        [],
        "the sweep registered a git worktree in the real repo",
      );
    } finally {
      await dropTempDir(w.base);
    }
  },
});

/** One verb per section of SCENARIOS — the TEXT-mode half of the sweep. A
 *  pipe is json mode (`detectMode`), so every row above only ever proves the
 *  machine rendering; a person on a terminal reads the other one. Each pick is
 *  the section's row with the most to say after it fails (a failed side
 *  effect where the section has one). */
const TEXT_CLASSES: Record<string, string> = {
  process: "start",
  state: "record",
  data: "backup",
  inspect: "sql",
  auth: "auth",
  scaffold: "create",
  install: "remove",
};

/** `script` gives the child a pty, so `am` is in pretty mode. */
const noPty = !["linux", "darwin"].includes(Deno.build.os) || !(() => {
  try {
    new Deno.Command("script", { args: ["-V"], stderr: "null" }).outputSync();
    return true;
  } catch {
    return false;
  }
})();

/** `am <argv>` on a pty: what the terminal showed (stdout + stderr, in the
 *  order they arrived) and the child's exit code (`script -e` forwards it). */
async function runAmPty(
  w: World,
  argv: string[],
  prep: Prep = {},
): Promise<{ code: number; text: string }> {
  const cmd = [Deno.execPath(), "run", "-A", "--config", CONFIG, AM, ...argv];
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const o = await new Deno.Command("script", {
    args: Deno.build.os === "darwin"
      ? ["-q", "/dev/null", ...cmd]
      : ["-q", "-e", "-c", cmd.map(q).join(" "), "/dev/null"],
    cwd: prep.cwd ?? w.empty,
    clearEnv: true,
    env: sandboxEnv(w, prep.env),
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  return { code: o.code, text: new TextDecoder().decode(o.stdout) };
}

/** Why a TEXT-mode failure reads as anything but a failure, or null. Pure.
 *
 *  "Reads as success", precisely: am's pretty output leads every line that
 *  reports an outcome with a tone glyph (`block`/`mark` in
 *  src/diagnostics/fmt.ts) — `✗` for a failure, `✓` for a success — and a
 *  refusal is `outError`'s `✗` block. So after the FIRST `✗` line, no line
 *  may lead with `✓`, nor with a bare `done` / `ok` / `success` word (the
 *  unglyphed spellings of the same claim). A `✓` BEFORE the error is allowed:
 *  a multi-step verb may finish step 1 and fail at step 2, and saying so is
 *  the honest transcript. */
function textVerdict(want: number, r: { code: number; text: string }) {
  if (r.code !== want) return `exit ${r.code} (want ${want})`;
  const lines = r.text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").split(/\r?\n/)
    .map((l) => l.trim());
  const err = lines.findIndex((l) => l.startsWith("✗"));
  if (err < 0) return `no ✗ error line on the terminal:\n${r.text}`;
  const after = lines.slice(err + 1).find((l) =>
    l.startsWith("✓") || /^(?:done|ok|success(?:ful(?:ly)?)?)\b/i.test(l)
  );
  return after === undefined
    ? null
    : `reads as success after the error: "${after}"\n${r.text}`;
}

Deno.test({
  name:
    "am exit-code sweep: on a terminal, nothing reads as success after the error (one verb per class)",
  ignore: noPty,
  fn: async () => {
    const w = await makeWorld();
    try {
      const bad: string[] = [];
      for (const [cls, verb] of Object.entries(TEXT_CLASSES)) {
        const s = SCENARIOS[verb];
        assert(s, `TEXT_CLASSES.${cls} names ${verb}, which has no row`);
        const argv = s.argv(w);
        const prep = (await s.prepare?.(w)) ?? {};
        try {
          const why = textVerdict(s.code ?? 1, await runAmPty(w, argv, prep));
          if (why) bad.push(`[${cls}] am ${argv.join(" ")}\n      → ${why}`);
        } finally {
          await prep.cleanup?.();
        }
      }
      assertEquals(bad, [], `${bad.length} class(es):\n  ${bad.join("\n  ")}`);
    } finally {
      await dropTempDir(w.base);
    }
  },
});

Deno.test("am exit-code sweep: the success path still says success (spot check)", async () => {
  const w = await makeWorld();
  try {
    for (
      const argv of [
        ["version"],
        ["instances"],
        ["installed"],
        ["help", "start"],
        ["data", `--app=${GHOST}`],
      ]
    ) {
      const r = await runAm(w, [...argv, "--json"]);
      const what = `am ${argv.join(" ")}`;
      assertEquals(r.code, 0, `${what}: ${r.stdout}${r.stderr}`);
      const { docs, junk } = jsonDocs(r.stdout);
      assertEquals(junk, [], `${what}: non-JSON stdout`);
      assert(docs.length > 0, `${what}: no document`);
      for (const d of docs) {
        assert(
          !(typeof d === "object" && d !== null && "error" in d),
          `${what} exited 0 with an error doc: ${r.stdout}`,
        );
      }
    }
  } finally {
    await dropTempDir(w.base);
  }
});

Deno.test({
  name: "am create: a file at the target is refused BEFORE a framework " +
    "worktree is provisioned",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const w = await makeWorld();
    try {
      const cwd = join(w.base, "create-file");
      await Deno.mkdir(cwd, { recursive: true });
      await Deno.writeTextFile(join(cwd, "myapp"), "not an app\n");
      // The DEFAULT path (no --mirror): the one that provisions.
      const r = await runAm(w, ["create", "myapp", "--json"], { cwd });
      assertEquals(r.code, 1, r.stdout + r.stderr);
      const doc = JSON.parse(r.stdout) as { error?: string };
      assert(
        doc.error?.includes("'myapp' already exists and is not a directory"),
        r.stdout,
      );
      assertEquals(
        (await worktrees()).filter((p) => p.startsWith(w.base)),
        [],
        "create provisioned a worktree before refusing",
      );
    } finally {
      await dropTempDir(w.base);
    }
  },
});

Deno.test({
  name: "am create --force: a failed scaffold leaves the user's directory " +
    "exactly as it was",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const w = await makeWorld();
    try {
      // The sweep's own `create` row, end to end: `myapp/src` is a FILE, so
      // the scaffold dies half-way — after deno.json and .gitignore.
      const cwd = join(w.base, "create-force");
      const app = join(cwd, "myapp");
      await Deno.mkdir(app, { recursive: true });
      await Deno.writeTextFile(join(app, "src"), "not a dir\n");
      await Deno.writeTextFile(join(app, "notes.txt"), "the user's\n");
      const fake = join(w.base, "throwaway-aio");
      await Deno.mkdir(fake, { recursive: true });
      await Deno.writeTextFile(join(fake, "mod.ts"), "export {};\n");
      const r = await runAm(w, [
        "create",
        "myapp",
        "--force",
        `--mirror=${fake}`,
        "--json",
      ], { cwd });
      assertEquals(r.code, 1, r.stdout + r.stderr);
      assert(
        (JSON.parse(r.stdout) as { error?: string }).error?.includes("src"),
      );
      const left = (await Array.fromAsync(Deno.readDir(app)))
        .map((e) => e.name).sort();
      assertEquals(left, ["notes.txt", "src"], "scaffold debris left behind");
      assertEquals(await Deno.readTextFile(join(app, "src")), "not a dir\n");
      assertEquals(
        await Deno.readTextFile(join(app, "notes.txt")),
        "the user's\n",
      );
    } finally {
      await dropTempDir(w.base);
    }
  },
});

Deno.test({
  name:
    "am create: an unreadable target is said to be unreadable, not 'not a directory'",
  ignore: Deno.build.os === "windows" || Deno.uid() === 0,
  fn: async () => {
    const w = await makeWorld();
    const target = join(w.base, "create-eacces", "myapp");
    try {
      await Deno.mkdir(target, { recursive: true });
      await Deno.chmod(target, 0o000);
      const r = await runAm(w, ["create", "myapp", "--json"], {
        cwd: join(w.base, "create-eacces"),
      });
      assertEquals(r.code, 1, r.stdout + r.stderr);
      const error = (JSON.parse(r.stdout) as { error?: string }).error ?? "";
      assert(error.includes("cannot be read (permission denied)"), error);
      assert(!error.includes("not a directory"), error);
    } finally {
      await Deno.chmod(target, 0o700);
      await dropTempDir(w.base);
    }
  },
});
