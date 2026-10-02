// `stopEsbuild()` stops the service the dev server started — and it knew the
// service only once the transpiler had finished loading esbuild. A stop that
// arrived while a transpile was still inside that load found nothing to stop
// and returned; the load then landed, the transform spawned esbuild's native
// child, and nobody was left to stop it. The stop now waits for the work in
// flight, so "stopEsbuild() resolved" means "no esbuild child".
//
// A stop that waits must not be a stop that can hang, so the rest of this
// file is every way the wait could fail to end: the service killed under a
// transform, an esbuild that cannot load, two stops at once, and work that
// never settles at all.
//
// The sanitizers are the oracle throughout: a child alive at the end of a
// test, its pending wait, or a timer left armed fails it.
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import {
  _ESBUILD,
  esbuildWork,
  stopEsbuild,
  transpile,
} from "../src/server/server-transpile.ts";
import { _childPids, _stoppedByUs } from "../src/build/esbuild-shared.ts";
import { getLogger, setLogger } from "../src/diagnostics/logger-api.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { join, toFileUrl } from "@std/path";

const linux = Deno.build.os === "linux";

/** A source no earlier test transpiled: the cache cannot answer for esbuild. */
function fresh(): { tag: string; src: string; path: string } {
  const tag = `v${crypto.randomUUID().replaceAll("-", "")}`;
  return {
    tag,
    src: `export const ${tag}: number = 1;\n`,
    path: `/aio-stop-in-flight/${tag}.ts`,
  };
}

/** Services this process had before the test began — not the test's: the
 *  suite runs every file in one process, and another isolate's service (a
 *  worker's, or one an earlier file left) is a child of it too. */
let foreign = new Set<number>();
/** Call first in a test that counts services. */
const onlyOurServices = () => void (foreign = new Set(everyServicePid()));
/** The esbuild service children this test started (Linux; [] elsewhere). */
function servicePids(): number[] {
  return everyServicePid().filter((p) => !foreign.has(p));
}

/** Every esbuild service child of this process (Linux; [] elsewhere). */
function everyServicePid(): number[] {
  if (!linux) return [];
  const tasks = [...Deno.readDirSync("/proc/self/task")].map((t) => t.name);
  return _childPids(
    tasks,
    (tid) => Deno.readTextFileSync(`/proc/self/task/${tid}/children`),
  ).filter((pid) => {
    try {
      const cmd = Deno.readTextFileSync(`/proc/${pid}/cmdline`);
      return cmd.includes("esbuild") && cmd.includes("--service=");
    } catch {
      return false; // gone between the listing and the read
    }
  });
}

/** Still in the process table — a zombie counts: it is not reaped. */
function unreaped(pids: number[]): number[] {
  return pids.filter((pid) => {
    try {
      Deno.statSync(`/proc/${pid}`);
      return true;
    } catch {
      return false;
    }
  });
}

/** One turn of the event loop — a turn, not a duration. */
const turn = () => new Promise<void>((r) => setTimeout(r, 0));

/** Wait until `pids` have left the process table; red if they never do. */
async function reaped(pids: number[]): Promise<void> {
  const t0 = Date.now();
  while (unreaped(pids).length > 0) {
    assert(Date.now() - t0 < 10_000, `pid ${pids} was never reaped`);
    await new Promise((r) => setTimeout(r, 5));
  }
  await turn(); // the exit the runtime has just observed is delivered
}

/** Signal a child that may already be gone. */
function signal(pid: number, sig: Deno.Signal): void {
  try {
    Deno.kill(pid, sig);
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
}

/** SIGSTOP a child and return once it IS stopped. The signal is only a
 *  request: until `/proc/<pid>/stat` says `T` the process is still running,
 *  and under load it answers whatever is sent to it in between. */
async function freeze(pid: number): Promise<void> {
  Deno.kill(pid, "SIGSTOP");
  const t0 = Date.now();
  for (;;) {
    const stat = Deno.readTextFileSync(`/proc/${pid}/stat`);
    // "<pid> (<comm>) <state> …" — the state follows the LAST ")".
    if (stat.slice(stat.lastIndexOf(")") + 2)[0] === "T") return;
    assert(Date.now() - t0 < 10_000, `pid ${pid} never stopped`);
    await new Promise((r) => setTimeout(r, 1));
  }
}

/** Run `fn` with `console.warn` captured — where the reap's note goes. */
async function warned(fn: () => Promise<void>): Promise<string[]> {
  const said: string[] = [];
  const warn = console.warn;
  console.warn = (...a: unknown[]) => said.push(a.map(String).join(" "));
  try {
    await fn();
  } finally {
    console.warn = warn;
  }
  return said;
}

const strict = { sanitizeOps: true, sanitizeResources: true };

Deno.test({
  name: "stopEsbuild: a transpile in flight at the stop leaves no service",
  ...strict,
  fn: async () => {
    onlyOurServices();
    await stopEsbuild(); // a clean slate: the next transpile loads esbuild
    let landed = false;
    const f = fresh();
    const inFlight = transpile(f.src, f.path).then((code) => {
      landed = true;
      return code;
    });
    assert(!landed, "the transpile is still in flight when the stop is asked");
    await stopEsbuild();
    assert(landed, "the stop waited for the transpile in flight");
    assertStringIncludes(await inFlight, `const ${f.tag} = 1`);
    assertEquals(servicePids(), []);
  },
});

Deno.test({
  name:
    "stopEsbuild: the service killed under a transform — the transform rejects and the stop returns",
  ...strict,
  ignore: !linux, // the child is found through /proc
  fn: async () => {
    onlyOurServices();
    const up = fresh();
    await transpile(up.src, up.path); // the service is running
    const pids = servicePids();
    assertEquals(pids.length, 1, "one esbuild service child");
    const f = fresh();
    const inFlight = transpile(f.src, f.path);
    // Same turn as the call: esbuild cannot have answered yet.
    Deno.kill(pids[0]!, "SIGKILL");
    const stopped = stopEsbuild();
    await assertRejects(() => inFlight);
    await stopped;
    assertEquals(servicePids(), []);
    // …and the next transpile starts a service that works.
    const again = fresh();
    assertStringIncludes(
      await transpile(again.src, again.path),
      `const ${again.tag} = 1`,
    );
    await stopEsbuild();
    assertEquals(servicePids(), []);
  },
});

Deno.test({
  name:
    "stopEsbuild: an esbuild that cannot load — the transpile rejects and the stop returns",
  ...strict,
  fn: async () => {
    onlyOurServices();
    await stopEsbuild();
    const real = _ESBUILD.spec;
    _ESBUILD.spec = `file:///aio-no-such-esbuild-${crypto.randomUUID()}.js`;
    try {
      const f = fresh();
      const inFlight = transpile(f.src, f.path);
      const stopped = stopEsbuild();
      await assertRejects(() => inFlight);
      await stopped;
    } finally {
      _ESBUILD.spec = real;
    }
    // The failed load poisoned nothing: the real one transpiles.
    const f = fresh();
    assertStringIncludes(await transpile(f.src, f.path), `const ${f.tag} = 1`);
    await stopEsbuild();
    assertEquals(servicePids(), []);
  },
});

Deno.test({
  name: "stopEsbuild: twice, at once, and around a new transpile",
  ...strict,
  fn: async () => {
    onlyOurServices();
    const a = fresh();
    await transpile(a.src, a.path);
    // At once: the second caller's stop is as true as the first's.
    const pids = servicePids();
    if (linux) assertEquals(pids.length, 1, "one esbuild service child");
    const first = stopEsbuild();
    const second = stopEsbuild();
    await second;
    assertEquals(
      unreaped(pids),
      [],
      "the service is reaped once the SECOND stop resolved",
    );
    await first;
    // Twice in a row, with nothing to stop.
    await stopEsbuild();
    await stopEsbuild();
    // Stop, a new transpile, stop: the service that transpile started is ended.
    const b = fresh();
    const stopping = stopEsbuild();
    const inFlight = transpile(b.src, b.path);
    await stopping;
    assertStringIncludes(await inFlight, `const ${b.tag} = 1`);
    await stopEsbuild();
    assertEquals(servicePids(), []);
  },
});

Deno.test({
  name:
    "stopEsbuild: work that never settles is given up on, by name, and the stop returns",
  ...strict,
  fn: async () => {
    onlyOurServices();
    await stopEsbuild();
    const said: string[] = [];
    const prev = getLogger();
    const budgetMs = _ESBUILD.budgetMs;
    setLogger({
      logDir: "",
      pub: (level: string, cat: string, msg: string) => {
        if (level === "warn" && cat === "esbuild") said.push(msg);
      },
      perf: () => {},
      flush: () => Promise.resolve(),
      // deno-lint-ignore no-explicit-any
    } as any);
    _ESBUILD.budgetMs = 200; // three quarters of it is the wait
    try {
      void esbuildWork(new Promise<never>(() => {})); // no event will end it
      const f = fresh();
      await transpile(f.src, f.path); // …and a service is running
      await stopEsbuild();
      assertEquals(said.length, 1, said.join("\n"));
      assertStringIncludes(said[0]!, "1 piece(s) of work still in flight");
      assertStringIncludes(said[0]!, "after 150 ms");
      assertEquals(servicePids(), [], "the service is stopped all the same");
      // Given up on once: the next stop neither waits for it nor says it again.
      await stopEsbuild();
      assertEquals(said.length, 1, said.join("\n"));
    } finally {
      setLogger(prev);
      _ESBUILD.budgetMs = budgetMs;
    }
  },
});

Deno.test({
  name:
    "stopEsbuild: work that starts while a stop is waiting is waited for too",
  ...strict,
  fn: async () => {
    onlyOurServices();
    const up = fresh();
    await transpile(up.src, up.path); // a service to stop
    const first = Promise.withResolvers<void>();
    void esbuildWork(first.promise);
    const stopped = stopEsbuild();
    await turn(); // the stop is now waiting for `first`, and only for it
    const go = Promise.withResolvers<void>();
    const f = fresh();
    const second = esbuildWork(
      go.promise.then(() => transpile(f.src, f.path)),
    );
    first.resolve();
    // A stop that had looked once would be past its wait by now, and the
    // transpile below would start the service again behind it.
    await turn();
    go.resolve();
    await stopped;
    assertStringIncludes(await second, `const ${f.tag} = 1`);
    assertEquals(servicePids(), []);
  },
});

Deno.test({
  name:
    "stopEsbuild: a stop that throws is its caller's, and the next stop still stops",
  ...strict,
  fn: async () => {
    onlyOurServices();
    await stopEsbuild();
    const dir = await tempDir("aio-fake-esbuild-");
    const real = _ESBUILD.spec;
    try {
      const fake = join(dir, "esbuild.mjs");
      await Deno.writeTextFile(
        fake,
        "export const transform = async (code) => ({ code, warnings: [] });\n" +
          'export const stop = () => { throw new Error("stop failed"); };\n',
      );
      _ESBUILD.spec = toFileUrl(fake).href;
      const f = fresh();
      await transpile(f.src, f.path);
      await assertRejects(() => stopEsbuild(), Error, "stop failed");
    } finally {
      _ESBUILD.spec = real;
      await dropTempDir(dir);
    }
    // The queue is not poisoned: the real service is started and stopped.
    const f = fresh();
    assertStringIncludes(await transpile(f.src, f.path), `const ${f.tag} = 1`);
    await stopEsbuild();
    assertEquals(servicePids(), []);
  },
});

Deno.test({
  name: "stopEsbuild: a child that is not the service is not waited for",
  ...strict,
  ignore: !linux, // the scan under test reads /proc
  fn: async () => {
    onlyOurServices();
    const up = fresh();
    await transpile(up.src, up.path);
    // "esbuild" is in its command line and it is not esbuild's service.
    const decoy = new Deno.Command("sh", {
      args: ["-c", "read x", "esbuild"],
      stdin: "piped",
      stdout: "null",
      stderr: "null",
    }).spawn();
    const budgetMs = _ESBUILD.budgetMs;
    _ESBUILD.budgetMs = 200;
    try {
      const said = await warned(() => stopEsbuild());
      assertEquals(said, [], "the stop named a child it had not stopped");
      assertEquals(servicePids(), []);
    } finally {
      _ESBUILD.budgetMs = budgetMs;
      await decoy.stdin.close();
      await decoy.status;
    }
  },
});

Deno.test({
  name:
    "stopEsbuild: a service that does not exit is named, and the stop returns",
  ...strict,
  ignore: !linux, // SIGSTOP, and the child found through /proc
  fn: async () => {
    onlyOurServices();
    const up = fresh();
    await transpile(up.src, up.path);
    const pids = servicePids();
    assertEquals(pids.length, 1, "one esbuild service child");
    const budgetMs = _ESBUILD.budgetMs;
    _ESBUILD.budgetMs = 200;
    await freeze(pids[0]!); // wedged: the kill stays pending
    try {
      const said = await warned(() => stopEsbuild());
      assertEquals(said.length, 1, said.join("\n"));
      assertStringIncludes(
        said[0]!,
        `note: esbuild's service process (pid ${pids[0]}) was told to stop ` +
          `and is still there 0.2 s later`,
      );
    } finally {
      _ESBUILD.budgetMs = budgetMs;
      signal(pids[0]!, "SIGCONT"); // the pending kill lands
      signal(pids[0]!, "SIGKILL");
      await reaped(pids);
    }
  },
});

Deno.test({
  name:
    "stopEsbuild: returns when the service is REAPED, not a fixed moment later",
  ...strict,
  ignore: !linux, // SIGSTOP, and the child found through /proc
  fn: async () => {
    onlyOurServices();
    const up = fresh();
    await transpile(up.src, up.path);
    const pids = servicePids();
    assertEquals(pids.length, 1, "one esbuild service child");
    // Held past any fixed wait: the service cannot exit until it is
    // continued, and it is continued by a timer armed BEFORE the stop — so a
    // stop that only waits a turn returns first, by timer order, not by luck.
    await freeze(pids[0]!);
    const cont = setTimeout(() => signal(pids[0]!, "SIGCONT"), 50);
    try {
      const said = await warned(() => stopEsbuild());
      assertEquals(unreaped(pids), [], "the stop returned before the exit");
      assertEquals(said, [], "…and inside its budget");
    } finally {
      clearTimeout(cont);
      signal(pids[0]!, "SIGCONT");
      signal(pids[0]!, "SIGKILL");
      await reaped(pids);
    }
  },
});

// Another esbuild instance in the same process — a worker's isolate loads its
// own copy of the package — has a service of its own, a child of the same OS
// process. The stop used to wait for EVERY service child to leave: it waited
// its whole reap for one it had never asked to stop, then named it in a
// `note:`. In a suite run one such service made every dev-server close after
// it 2 s slower and wrong about which process was stuck.
Deno.test({
  name:
    "stopEsbuild: a service another esbuild instance owns is neither waited for nor named",
  ...strict,
  ignore: !linux, // the services are told apart through /proc
  fn: async () => {
    onlyOurServices();
    const w = new Worker(
      new URL("./fixtures/esbuild-other-instance.ts", import.meta.url).href,
      { type: "module" },
    );
    const said = (what: string) =>
      new Promise<void>((r) => {
        w.onmessage = (e) => e.data === what && r();
      });
    let theirs: number[] = [];
    try {
      await said("up");
      theirs = servicePids();
      assertEquals(theirs.length, 1, "the worker's own service");
      onlyOurServices();
      const { src, path } = fresh();
      await transpile(src, path); // ours, beside it
      assertEquals(servicePids().length, 1, "our service");
      const t0 = performance.now();
      const notes = await warned(() => stopEsbuild());
      const ms = performance.now() - t0;
      assertEquals(notes, [], "a service the stop never touched was named");
      assert(ms < 1000, `the stop waited ${ms.toFixed(0)} ms`);
      assertEquals(servicePids(), [], "ours is gone");
      assertEquals(unreaped(theirs), theirs, "theirs was left alone");
    } finally {
      const stopped = said("stopped");
      w.postMessage("stop");
      await stopped;
      w.terminate();
    }
  },
});

Deno.test("stopEsbuild: what the stop ended is told by the pipe it closed", () => {
  const stdin: Record<number, string> = {
    1: "pipe:[10]", // ours: stop() destroyed our end
    2: "pipe:[20]", // another instance's: its end is still open here
  };
  const read = (pid: number) => {
    if (!(pid in stdin)) throw new Error("gone"); // a zombie's fd/ is empty
    return stdin[pid]!;
  };
  assertEquals(
    _stoppedByUs([1, 2, 3], read, () => new Set(["pipe:[20]", "/dev/null"])),
    [1, 3],
  );
  assertEquals(_stoppedByUs([], read, () => new Set()), []);
});
