// After `am restart` (or `am start`) races the dev watcher's in-process
// relaunch, exactly ONE process serves the app home — visible to
// `am instances`, stopped by `am stop` — and a restart keeps the port.
//
// Save a cell file and the running app turns itself into a thin supervisor
// (dev-restart.ts) that relaunches the app as a child. The old app has
// released its lock by then and the child has not taken one yet: `am restart`
// in that window saw NOTHING running, started a fresh instance on a NEW port,
// and the supervisor's child — refused, the lock now taken — died within a
// second. The supervisor read that as "the file you saved does not load" and
// waited forever for the next save: an app-less process no lock names,
// invisible to `am instances`, `am stop` and `am kill --stale` (a field
// observation: "killed by PID").
//
// Deterministic: the relaunched child sleeps before it boots (a slow module
// graph, stretched), so the window is seconds wide instead of milliseconds.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { lockPath } from "../src/server/single-instance-lock.ts";

const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const SLOW_CHILD_MS = 5_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Pids of every process running `file`. */
async function procs(file: string): Promise<number[]> {
  const o = await new Deno.Command("ps", {
    args: ["-axo", "pid=,args="],
    stdout: "piped",
    stderr: "null",
  }).output();
  return new TextDecoder().decode(o.stdout).split("\n")
    .map((l) => l.trim().match(/^(\d+)\s+(.*)$/))
    .filter((m) => m && m[2]!.includes(file) && !m[2]!.startsWith("ps "))
    .map((m) => Number(m![1]))
    .filter((p) => p !== Deno.pid);
}

async function world() {
  const dir = await tempDir("dev-race-");
  const proj = join(dir, "proj");
  const apps = join(dir, "apps");
  const rt = join(dir, "rt");
  await Deno.mkdir(join(proj, "src"), { recursive: true });
  await Deno.mkdir(rt, { mode: 0o700 });
  const head = JSON.parse(await Deno.readTextFile(join(REPO, "deno.json")));
  const imports: Record<string, string> = {};
  for (const [k, v] of Object.entries(head.imports as Record<string, string>)) {
    imports[k] = v.startsWith("./") ? `${REPO}/${v.slice(2)}` : v;
  }
  await Deno.writeTextFile(
    join(proj, "deno.json"),
    JSON.stringify({
      compilerOptions: head.compilerOptions,
      imports,
      nodeModulesDir: head.nodeModulesDir,
    }),
  );
  await Deno.writeTextFile(
    join(proj, "src", "cell.ts"),
    `import { cell } from "${REPO}/mod.ts";
export const c = cell("c", { state: { n: 1 }, methods: {} });
`,
  );
  const entry = join(proj, "src", "app.ts");
  await Deno.writeTextFile(
    entry,
    `// The dev watcher's relaunch boots slowly: the race window, made wide.
if (Deno.env.get("AIO_DEV_SUPERVISED") === "1") {
  await new Promise((r) => setTimeout(r, ${SLOW_CHILD_MS}));
}
const { aio } = await import("${REPO}/mod.ts");
const { c } = await import("./cell.ts");
await aio.run({ cells: [c], appId: "dr", persist: false, client: "server-only" });
`,
  );
  const env = {
    AIO_APPS_DIR: apps,
    XDG_RUNTIME_DIR: rt,
    AIO_AM_NO_DELEGATE: "1",
  };
  const am = async (...a: string[]) => {
    const o = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        "--config",
        join(REPO, "deno.json"),
        `${REPO}/src/am.ts`,
        ...a,
      ],
      cwd: proj,
      env,
      stdin: "null",
    }).output();
    const out = new TextDecoder().decode(o.stdout);
    let json: unknown = null;
    try {
      json = JSON.parse(out);
    } catch { /* not one document */ }
    return {
      code: o.code,
      out: out + new TextDecoder().decode(o.stderr),
      json,
    };
  };
  /** Save a cell file, and wait until the old app has become the supervisor
   *  and its relaunched child exists (two processes run the entry). */
  const saveAndAwaitRelaunch = async () => {
    await Deno.writeTextFile(
      join(proj, "src", "cell.ts"),
      `// saved ${Date.now()}\n`,
      { append: true },
    );
    for (let i = 0; i < 150 && (await procs(entry)).length < 2; i++) {
      await sleep(100);
    }
    assertEquals((await procs(entry)).length, 2, "no relaunch happened");
    await sleep(300);
  };
  /** The processes once the slow child has booted (or been refused). */
  const settled = async () => {
    await sleep(SLOW_CHILD_MS + 1_000);
    let last = await procs(entry);
    for (let i = 0; i < 40 && last.length > 1; i++) {
      await sleep(250);
      last = await procs(entry);
    }
    return last;
  };
  const listed = async () =>
    ((await am("instances", "--json")).json as { pid: number }[] | null ??
      []).map((i) => i.pid);
  const cleanup = async () => {
    await am("stop", "--wait", "--json").catch(() => {});
    for (const pid of await procs(dir)) {
      try {
        Deno.kill(pid, "SIGKILL");
      } catch { /* gone between ps and kill */ }
    }
    await dropTempDir(dir);
  };
  /** The raw lock file of the app's home ("" when there is none). */
  const lockRaw = () => {
    const prev = [
      Deno.env.get("AIO_APPS_DIR"),
      Deno.env.get("XDG_RUNTIME_DIR"),
    ];
    Deno.env.set("AIO_APPS_DIR", apps);
    Deno.env.set("XDG_RUNTIME_DIR", rt);
    try {
      return Deno.readTextFileSync(lockPath("dr"));
    } catch {
      return "";
    } finally {
      if (prev[0] === undefined) Deno.env.delete("AIO_APPS_DIR");
      else Deno.env.set("AIO_APPS_DIR", prev[0]);
      if (prev[1] === undefined) Deno.env.delete("XDG_RUNTIME_DIR");
      else Deno.env.set("XDG_RUNTIME_DIR", prev[1]);
    }
  };
  /** Run the entry by hand for `ms` and return everything it said. */
  const runDirect = async (ms: number) => {
    const c = new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", "--config", join(proj, "deno.json"), entry],
      cwd: proj,
      env,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const out = Promise.all([
      new Response(c.stdout).text(),
      new Response(c.stderr).text(),
    ]);
    await sleep(ms);
    try {
      c.kill("SIGTERM");
    } catch { /* already gone */ }
    await c.status;
    return (await out).join("");
  };
  return {
    lockRaw,
    runDirect,
    dir,
    apps,
    rt,
    entry,
    am,
    saveAndAwaitRelaunch,
    settled,
    listed,
    cleanup,
  };
}

Deno.test({
  name:
    "dev restart race: am restart during the watcher's relaunch leaves ONE process, on the same port",
  ignore: Deno.build.os === "windows",
  sanitizeOps: false, // aio-ok: every process is stopped, then reaped, below
  sanitizeResources: false, // aio-ok: same
  async fn() {
    const w = await world();
    try {
      const s = await w.am("start", "--json");
      assertEquals(s.code, 0, s.out);
      const first = s.json as { pid: number; port: number };
      await w.saveAndAwaitRelaunch();
      const r = await w.am("restart", "--json");
      assertEquals(r.code, 0, r.out);
      const left = await w.settled();
      assertEquals(left.length, 1, `processes left: ${left} (${r.out})`);
      assertEquals(await w.listed(), left, "the one process is not listed");
      const st = await w.am("status", "--json");
      assertEquals(
        (st.json as { port: number }).port,
        first.port,
        "the restart moved the app to a new port",
      );
      const stop = await w.am("stop", "--wait", "--json");
      assertEquals(stop.code, 0, stop.out);
      await sleep(500);
      assertEquals(await procs(w.entry), [], "am stop left a process");
    } finally {
      await w.cleanup();
    }
  },
});

Deno.test({
  name:
    "dev restart race: when another start wins the lock, the watcher's supervisor steps aside",
  ignore: Deno.build.os === "windows",
  sanitizeOps: false, // aio-ok: every process is stopped, then reaped, below
  sanitizeResources: false, // aio-ok: same
  async fn() {
    const w = await world();
    try {
      const s = await w.am("start", "--json");
      assertEquals(s.code, 0, s.out);
      await w.saveAndAwaitRelaunch();
      // Force the OTHER outcome: whatever the relaunch left in the lock slot
      // is gone, so the next start takes the lock before the slow child.
      const prev = [
        Deno.env.get("AIO_APPS_DIR"),
        Deno.env.get("XDG_RUNTIME_DIR"),
      ];
      Deno.env.set("AIO_APPS_DIR", w.apps);
      Deno.env.set("XDG_RUNTIME_DIR", w.rt);
      try {
        Deno.removeSync(lockPath("dr"));
      } catch {
        /* no lock in the slot — the window this test is about */
      } finally {
        if (prev[0] === undefined) Deno.env.delete("AIO_APPS_DIR");
        else Deno.env.set("AIO_APPS_DIR", prev[0]);
        if (prev[1] === undefined) Deno.env.delete("XDG_RUNTIME_DIR");
        else Deno.env.set("XDG_RUNTIME_DIR", prev[1]);
      }
      const c = await w.am("start", "--json");
      assertEquals(c.code, 0, c.out);
      const winner = (c.json as { pid: number }).pid;
      const left = await w.settled();
      assertEquals(left, [winner], `a process besides the winner survived`);
      assert((await w.listed()).includes(winner));
      const stop = await w.am("stop", "--wait", "--json");
      assertEquals(stop.code, 0, stop.out);
      await sleep(500);
      assertEquals(await procs(w.entry), [], "am stop left a process");
    } finally {
      await w.cleanup();
    }
  },
});

Deno.test({
  name:
    "dev restart: a relaunched child killed by SIGKILL leaves its lock, so the next run says it did not shut down cleanly",
  ignore: Deno.build.os === "windows",
  sanitizeOps: false, // aio-ok: every process is stopped, then reaped, below
  sanitizeResources: false, // aio-ok: same
  async fn() {
    const w = await world();
    try {
      const s = await w.am("start", "--json");
      assertEquals(s.code, 0, s.out);
      const first = (s.json as { pid: number }).pid;
      await w.saveAndAwaitRelaunch();
      // The relaunched child has booted and holds its OWN lock.
      let child = 0;
      for (let i = 0; i < 150 && !child; i++) {
        const l = JSON.parse(w.lockRaw() || "null");
        if (l && l.pid !== first && l.status === "started") child = l.pid;
        else await sleep(100);
      }
      assert(child, `the child never took its lock: ${w.lockRaw()}`);
      Deno.kill(child, "SIGKILL"); // an OOM kill, a kill -9
      await sleep(1_500);
      assertEquals(await procs(w.entry), [], "the supervisor outlived it");
      assert(
        w.lockRaw().includes(`"pid":${child}`),
        `the dead child's lock is gone — the abrupt end is now silent: ` +
          `${w.lockRaw() || "<absent>"}`,
      );
      const said = await w.runDirect(6_000);
      assert(said.includes("shut down cleanly"), said);
    } finally {
      await w.cleanup();
    }
  },
});
