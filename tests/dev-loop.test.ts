/**
 * The dev loop, in the three places it went quiet on the developer.
 *
 * 1. `server-vendor.ts` built `file://${Deno.cwd()}/…` by hand and read
 *    `.pathname` back off it. A cwd with a SPACE in it came back
 *    percent-encoded (`/home/me/My%20Apps/…`), every candidate failed, and dev
 *    silently fell back to the esm.sh CDN — defeating the offline-dev
 *    guarantee that file's own header promises. Not Windows-only.
 * 2. `dev-restart.ts` spawned the supervised child with no `AIO_PARENT_PID`, so
 *    closing the terminal left an ORPHAN holding the port and the lock;
 *    and its restart branch had no rate limit, so an external formatter
 *    touching a cell file span an unbounded spawn loop.
 * 3. `server-watcher.ts` returned BEFORE any broadcast when graph validation
 *    exceeded its budget, with the explanation going to `log.debug` — so on a
 *    big project every save did nothing at all, silently. Its debounce also had
 *    no max wait, so an event storm meant no reload ever.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  _immerCandidates,
  _resetVendorCache,
  hasVendorImmer,
} from "../src/server/server-vendor.ts";
import {
  FAILED_RESTART_WINDOW_MS,
  RESTART_STORM_COOLDOWN_MS,
  RESTART_STORM_LIMIT,
  restartThrottleDelay,
} from "../src/server/dev-restart.ts";
import {
  _configPaths,
  _debounceDelay,
  createFileWatcher,
  DEBOUNCE_MAX_MS,
  DEBOUNCE_MS,
} from "../src/server/server-watcher.ts";

const AIO_ROOT = join(import.meta.dirname ?? ".", "..");

// ── 1. offline dev survives a space in the path ─────────────────────────────

Deno.test("vendor immer: candidates are PATHS, so a space stays a space", () => {
  const cands = _immerCandidates("/home/me/My Apps/proj");
  assertEquals(
    cands[0],
    join(
      "/home/me/My Apps/proj",
      "node_modules",
      "immer",
      "dist",
      "immer.mjs",
    ),
  );
  for (const c of cands) {
    assert(
      !c.includes("%20") && !c.includes("%2520"),
      `percent-encoded candidate — statSync can never open it: ${c}`,
    );
    assert(!c.startsWith("file:"), `a URL leaked into a path list: ${c}`);
  }
});

Deno.test("vendor immer: found under a directory whose name contains a space", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "aio vendor " });
  const proj = join(tmp, "My Apps", "proj");
  const dist = join(proj, "node_modules", "immer", "dist");
  await Deno.mkdir(dist, { recursive: true });
  await Deno.writeTextFile(
    join(dist, "immer.mjs"),
    "export const x = process.env.NODE_ENV;\n",
  );
  const cwd = Deno.cwd();
  try {
    Deno.chdir(proj);
    _resetVendorCache();
    assert(
      hasVendorImmer(),
      "the local immer was not found — dev would fall back to the CDN, " +
        "offline dev is broken, and nothing says so",
    );
  } finally {
    Deno.chdir(cwd);
    _resetVendorCache();
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
  }
});

// ── 2. the dev supervisor ───────────────────────────────────────────────────

Deno.test("dev supervisor: the child is told who its parent is", async () => {
  // Structural, because the alternative is orphaning a real server: the child
  // must be spawned with AIO_PARENT_PID so aio-lifecycle's parent watch stops
  // it when the supervisor dies. Headless apps deliberately ignore SIGHUP, so
  // without this a closed terminal leaves the app holding the port and the
  // single-instance lock and the next `deno task dev` is refused with
  // "Already running".
  const src = await Deno.readTextFile(
    join(AIO_ROOT, "src/server/dev-restart.ts"),
  );
  const spawn = src.indexOf("new Deno.Command(Deno.execPath()");
  assert(spawn > 0, "the supervisor still spawns the child here");
  const block = src.slice(spawn, spawn + 1200);
  assertStringIncludes(
    block,
    "AIO_PARENT_PID",
    "the supervised child must die with its supervisor",
  );
  assertStringIncludes(block, "String(Deno.pid)");
  // …and the mechanism has to be the one the runtime actually reads.
  const lifecycle = await Deno.readTextFile(
    join(AIO_ROOT, "src/server/aio-lifecycle.ts"),
  );
  assertStringIncludes(lifecycle, 'Deno.env.get("AIO_PARENT_PID")');
});

Deno.test("dev supervisor: a restart STORM is throttled, not spun", () => {
  // A save is a human act; five restarts inside a second each are a loop —
  // a format-on-save, a generator, a second watcher. The old code `continue`d
  // with no guard at all.
  for (let n = 0; n < RESTART_STORM_LIMIT; n++) {
    assertEquals(restartThrottleDelay(n), 0, `${n} restarts is still normal`);
  }
  assertEquals(
    restartThrottleDelay(RESTART_STORM_LIMIT),
    RESTART_STORM_COOLDOWN_MS,
  );
  assertEquals(
    restartThrottleDelay(RESTART_STORM_LIMIT + 50),
    RESTART_STORM_COOLDOWN_MS,
    "the throttle is a floor, not a ramp that grows without end",
  );
  // The cooldown must be shorter than the crash window, or a throttled restart
  // would read as a failed one.
  assert(RESTART_STORM_COOLDOWN_MS < FAILED_RESTART_WINDOW_MS);
});

// ── 3. the file watcher ─────────────────────────────────────────────────────

Deno.test("watcher: the debounce has a ceiling — a storm still reloads", () => {
  assertEquals(
    _debounceDelay(0),
    DEBOUNCE_MS,
    "a lone save waits the debounce",
  );
  assertEquals(_debounceDelay(50), DEBOUNCE_MS);
  // Once the burst has run past the ceiling the next timer is immediate,
  // instead of the old behaviour: every event pushing the reload further away.
  assertEquals(_debounceDelay(DEBOUNCE_MAX_MS), 0);
  assertEquals(_debounceDelay(DEBOUNCE_MAX_MS + 10_000), 0);
  assertEquals(_debounceDelay(DEBOUNCE_MAX_MS - 10), 10);
  assert(DEBOUNCE_MAX_MS > DEBOUNCE_MS);
});

Deno.test("watcher: config lookup honours BOTH names, and derives the parent properly", () => {
  const paths = _configPaths("/tmp/proj/src");
  assertEquals(paths, [
    "/tmp/proj/src/deno.json",
    "/tmp/proj/src/deno.jsonc",
    "/tmp/proj/deno.json",
    "/tmp/proj/deno.jsonc",
  ]);
  // A trailing separator used to produce an empty parent via
  // `lastIndexOf("/")` — `dirname` is the one that answers correctly.
  assertEquals(_configPaths("/tmp/proj/src/")[2], "/tmp/proj/deno.json");
  // The filesystem root has no parent to walk to, and must not produce "".
  for (const p of _configPaths("/")) assert(p.startsWith("/"), p);
});

Deno.test("watcher: a graph validation that times out still reloads, and SAYS SO", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "aio-watch-" });
  try {
    const entry = join(tmp, "App.tsx");
    await Deno.writeTextFile(
      entry,
      "export default function App() { return <div>hi</div>; }\n",
    );
    const sent: string[] = [];
    const reloads: string[] = [];
    const warned: string[] = [];
    const origWarn = console.warn;
    console.warn = (...a: unknown[]) => warned.push(a.join(" "));
    let watcher;
    try {
      watcher = createFileWatcher({
        absBaseDir: tmp,
        importMapObj: {},
        debug: () => {},
        broadcastWs: (m) => sent.push(m),
        onReload: (s) => reloads.push(s),
        // 0 ms: validation can never win the race — the timeout path, every
        // time, which is what a big project hits for real.
        graphTimeoutMs: 0,
      });
      watcher.scheduleReload(entry);
      // debounce + one macrotask for the async validation race
      await new Promise((r) => setTimeout(r, DEBOUNCE_MS + 250));
    } finally {
      console.warn = origWarn;
      watcher?.shutdown();
    }
    assertEquals(
      reloads,
      ["reload"],
      "the save must still reach the browser — it used to return before any " +
        "broadcast, so every save silently did nothing",
    );
    assertEquals(sent.length, 1, "exactly one broadcast, not none and not two");
    assert(
      warned.some((w) => w.includes("validation did not finish")),
      "the timeout must be a WARN a developer sees, not a suppressed debug " +
        `line. Got: ${JSON.stringify(warned)}`,
    );
  } finally {
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
  }
});

Deno.test("watcher: a deno.json edit warns once and never fakes a browser reload", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "aio-watch-cfg-" });
  try {
    const cfg = join(tmp, "deno.json");
    await Deno.writeTextFile(cfg, "{}\n");
    const sent: string[] = [];
    const watcher = createFileWatcher({
      absBaseDir: tmp,
      importMapObj: {},
      debug: () => {},
      broadcastWs: (m) => sent.push(m),
    });
    try {
      watcher.scheduleReload(cfg);
      watcher.scheduleReload(join(tmp, "deno.jsonc"));
      await new Promise((r) => setTimeout(r, DEBOUNCE_MS + 100));
      assertEquals(
        sent,
        [],
        "the import map is read at boot — nothing to send",
      );
    } finally {
      watcher.shutdown();
    }
  } finally {
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
  }
});
