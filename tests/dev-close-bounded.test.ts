// Closing a dev server, in the two cases where something it started was still
// running — a real server, a real child process, and the sanitizers as the
// oracle for what is left behind.
//
// 1. A wedged esbuild service. The stop inside close waits for esbuild work
//    in flight, and for a while that wait had a bound of its own (10 s) inside
//    a close whose whole teardown is 5 s: the server phase ate the budget,
//    SQLite got 1 ms to close ("sqlite did not finish inside the 5000ms
//    teardown budget"), and the wait's warning was printed five seconds after
//    close had returned. The stop's bound is now a share of that one budget.
//
// 2. esbuild wedged BEFORE the boot's graph verdict. Close awaited that
//    validation blind, so it ran until the teardown budget cut the whole
//    server phase. The validation is now esbuild work like any other: ended
//    by the close, waited for inside the stop's bound.
//
// 3. The app's CSS step (`build.css`) still running. Close waited for the
//    step the BOOT started — however long it took — and not at all for one a
//    save started: that subprocess outlived close, and when it finished the
//    closed server broadcast a reload and printed `reloaded …`. Close now
//    ends the step, either one, and returns when its process has exited.
import { assert, assertEquals } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import {
  _ESBUILD,
  normPath,
  transpile,
  transpileCache,
} from "../src/server/server-transpile.ts";
import { _runAppCssStep } from "../src/server/server-css-step.ts";
import { loadEsbuild, stopEsbuild } from "../src/server/server-transpile.ts";
import { toFileUrl } from "@std/path";
import { TEARDOWN_TIMEOUT_MS } from "../src/server/shutdown-budget.ts";
import { spec } from "./module-spec-helper.ts";

const REPO = fromFileUrl(new URL("..", import.meta.url));
const linux = Deno.build.os === "linux";

/** A /proc entry that went away under the read: the file is missing, or —
 *  opened just before its process ended — the read itself says ESRCH ("No
 *  such process (os error 3)", which Deno gives no class of its own). */
function gone(e: unknown): boolean {
  return e instanceof Deno.errors.NotFound ||
    (e instanceof Error && /\(os error 3\)/.test(e.message));
}

/** This process's children as `[pid, command line]` (Linux). */
function children(): [number, string][] {
  const out: [number, string][] = [];
  for (const t of Deno.readDirSync("/proc/self/task")) {
    try {
      const raw = Deno.readTextFileSync(`/proc/self/task/${t.name}/children`);
      for (const p of raw.trim().split(/\s+/)) {
        if (!p) continue;
        const cmd = Deno.readTextFileSync(`/proc/${p}/cmdline`)
          .replaceAll("\0", " ").trim();
        out.push([Number(p), cmd]);
      }
    } catch (e) {
      // A thread or a child that ended between the listing and the read.
      if (!gone(e)) throw e;
    }
  }
  return out;
}
const allServices = () =>
  children().filter(([, c]) => c.includes("--service=")).map(([p]) => p);
/** Services this process had before the test began — not the test's. A suite
 *  runs every file in one process, and another isolate's service (a worker's,
 *  or one an earlier file left running) is a child of it too. */
let foreign = new Set<number>();
const services = () => allServices().filter((p) => !foreign.has(p));
/** Call first in a test that counts services. */
const onlyOurServices = () => void (foreign = new Set(allServices()));
const cssSteps = () =>
  children().filter(([, c]) => /(^|\/)sleep 30$/.test(c)).map(([p]) => p);

/** Wait for `cond`; red, with `what`, if it never holds. */
async function until(
  cond: () => boolean,
  what: string,
  ms = 30_000,
): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    assert(Date.now() - t0 < ms, `never happened: ${what}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

/** The boot's import-graph verdict, from the server itself — `pending`
 *  until the async validation (walk + prod-bundle judge) has landed. */
async function graphVerdict(
  port: number,
): Promise<{ valid: boolean; errors: { message: string }[] }> {
  const t0 = Date.now();
  for (;;) {
    const r = await fetch(`http://127.0.0.1:${port}/__aio/trojan/graph`);
    const g = await r.json();
    if (!g.pending) return g;
    assert(Date.now() - t0 < 30_000, "the graph verdict never landed");
    // Asked 40 times a second: the control plane takes 100.
    await new Promise((r) => setTimeout(r, 25));
  }
}

function inProcTable(pid: number): boolean {
  try {
    Deno.statSync(`/proc/${pid}`);
    return true;
  } catch {
    return false;
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

/** Every process whose working directory is `dir` — a CSS step's own
 *  children included, which are nobody's children once the step is gone. */
function inDir(dir: string): [number, string][] {
  const out: [number, string][] = [];
  for (const e of Deno.readDirSync("/proc")) {
    if (!/^\d+$/.test(e.name) || Number(e.name) === Deno.pid) continue;
    try {
      if (Deno.readLinkSync(`/proc/${e.name}/cwd`) !== dir) continue;
      const cmd = Deno.readTextFileSync(`/proc/${e.name}/cmdline`)
        .replaceAll("\0", " ").trim();
      out.push([Number(e.name), cmd]);
    } catch (e) {
      // Not ours to read, or gone since the listing.
      if (
        !gone(e) &&
        !(e instanceof Deno.errors.PermissionDenied) &&
        !(e instanceof Deno.errors.NotCapable)
      ) throw e;
    }
  }
  return out;
}

async function accepting(port: number): Promise<boolean> {
  try {
    (await Deno.connect({ port, hostname: "127.0.0.1" })).close();
    return true;
  } catch (e) {
    if (e instanceof Deno.errors.ConnectionRefused) return false;
    // A listener on its way down may still take the connection and drop it.
    if (e instanceof Deno.errors.ConnectionReset) return true;
    throw e;
  }
}

function signal(pid: number, sig: Deno.Signal): void {
  try {
    Deno.kill(pid, sig);
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
}

/** Every console line while `fn` runs, colour stripped. */
async function withLines(
  fn: (lines: string[]) => Promise<void>,
): Promise<void> {
  const lines: string[] = [];
  const orig = { ...console };
  for (const k of ["log", "info", "warn", "error", "debug"] as const) {
    console[k] = (...a: unknown[]) =>
      // deno-lint-ignore no-control-regex
      lines.push(a.map(String).join(" ").replace(/\x1b\[[0-9;]*m/g, ""));
  }
  try {
    await fn(lines);
  } finally {
    Object.assign(console, orig);
  }
}

const APP = (n: number) =>
  `export default function App() { return <main>${n}</main>; }\n`;

Deno.test({
  name:
    "close with a wedged esbuild service: bounded, said before it returns, and the database still closes",
  sanitizeOps: true,
  sanitizeResources: true,
  ignore: !linux, // SIGSTOP, and the child found through /proc
  fn: async () => {
    onlyOurServices();
    const { aio, cell } = await import("../mod.ts");
    const dir = await tempDir("aio-close-wedged-");
    await Deno.writeTextFile(join(dir, "App.tsx"), APP(0));
    const port = freePort();
    let wedged: number | undefined;
    try {
      await withLines(async (lines) => {
        const app = await aio.run({
          cells: [cell("dcbw", { state: { n: 0 }, methods: {} })],
          appId: "test-close-wedged",
          client: "browser",
          persist: true,
          libraryMode: true,
          port,
          baseDir: dir,
        });
        let closed = false;
        try {
          await graphVerdict(port); // the boot's own esbuild work is over
          assertEquals(services().length, 1, "one esbuild service child");
          wedged = services()[0]!;
          await freeze(wedged);
          // esbuild work in flight that cannot settle: the service is stopped.
          // (It is rejected at the very end, when the service is killed.)
          const tag = `v${crypto.randomUUID().replaceAll("-", "")}`;
          transpile(`export const ${tag}: number = 1;\n`, `/${tag}.ts`).then(
            () => {},
            () => {},
          );
          const from = lines.length;
          const t0 = performance.now();
          await app.close();
          closed = true;
          const ms = performance.now() - t0;
          const during = lines.slice(from);
          const atClose = lines.length;
          // The stop's whole share (wait AND reap) is two fifths of the
          // teardown; a second of slack for every other phase of this close.
          assert(
            ms < TEARDOWN_TIMEOUT_MS * 2 / 5 + 1000,
            `close took ${ms.toFixed(0)} ms of a ${TEARDOWN_TIMEOUT_MS} ms ` +
              `teardown:\n${during.join("\n")}`,
          );
          assertEquals(
            during.filter((l) => l.includes("did not finish inside")),
            [],
            "a teardown phase ran out of budget",
          );
          assertEquals(
            during.filter((l) => l.includes("stopping esbuild with")).length,
            1,
            `the give-up is said once, before close returns:\n${
              during.join("\n")
            }`,
          );
          // The service ends; whatever was going to be printed late is in.
          signal(wedged, "SIGCONT");
          signal(wedged, "SIGKILL");
          await until(() => !inProcTable(wedged!), "the service's exit");
          await new Promise((r) => setTimeout(r, 0));
          assertEquals(lines.slice(atClose), [], "printed after close");
        } finally {
          if (!closed) await app.close();
        }
      });
    } finally {
      // Never leave a stopped process behind, whatever failed above.
      if (wedged !== undefined) {
        signal(wedged, "SIGCONT");
        signal(wedged, "SIGKILL");
        await until(() => !inProcTable(wedged!), "the service's exit");
        await new Promise((r) => setTimeout(r, 0));
      }
      await dropTempDir(dir);
    }
  },
});

Deno.test({
  name:
    "close with esbuild wedged before the boot's graph verdict: bounded, said once, nothing after",
  sanitizeOps: true,
  sanitizeResources: true,
  ignore: !linux, // SIGSTOP, and the child found through /proc
  fn: async () => {
    onlyOurServices();
    const { aio, cell } = await import("../mod.ts");
    const dir = await tempDir("aio-close-wedged-boot-");
    // A graph long enough that the verdict cannot land before the service
    // is stopped at its first appearance.
    const names = Array.from({ length: 200 }, (_, i) => `m${i}`);
    for (const n of names) {
      await Deno.writeTextFile(
        join(dir, `${n}.ts`),
        `export const ${n}: number = ${n.slice(1)};\n`,
      );
    }
    await Deno.writeTextFile(
      join(dir, "App.tsx"),
      names.map((n) => `import { ${n} } from "./${n}.ts";\n`).join("") +
        `export default function App() { return <main>{${
          names.join(" + ")
        }}</main>; }\n`,
    );
    const port = freePort();
    let wedged: number | undefined;
    try {
      await withLines(async (lines) => {
        const app = await aio.run({
          cells: [cell("dcbv", { state: { n: 0 }, methods: {} })],
          appId: "test-close-wedged-boot",
          client: "browser",
          persist: true,
          libraryMode: true,
          port,
          baseDir: dir,
        });
        let closed = false;
        try {
          await until(() => services().length === 1, "the esbuild service");
          wedged = services()[0]!;
          await freeze(wedged);
          const r = await fetch(`http://127.0.0.1:${port}/__aio/trojan/graph`);
          assertEquals(
            (await r.json()).pending,
            true,
            "the verdict landed before the service was wedged",
          );
          const from = lines.length;
          const t0 = performance.now();
          await app.close();
          closed = true;
          const ms = performance.now() - t0;
          const during = lines.slice(from);
          const atClose = lines.length;
          assert(
            ms < TEARDOWN_TIMEOUT_MS * 2 / 5 + 1000,
            `close took ${ms.toFixed(0)} ms of a ${TEARDOWN_TIMEOUT_MS} ms ` +
              `teardown:\n${during.join("\n")}`,
          );
          assertEquals(
            during.filter((l) => l.includes("did not finish inside")),
            [],
            "a teardown phase ran out of budget",
          );
          assertEquals(
            during.filter((l) => l.includes("stopping esbuild with")).length,
            1,
            `the give-up is said once, before close returns:\n${
              during.join("\n")
            }`,
          );
          // The service ends, and the walk it was holding with it: whatever
          // a closed server was going to say about that graph is in by now.
          signal(wedged, "SIGCONT");
          signal(wedged, "SIGKILL");
          await until(() => !inProcTable(wedged!), "the service's exit");
          await new Promise((r) => setTimeout(r, 0));
          assertEquals(lines.slice(atClose), [], "printed after close");
          assertEquals(services(), [], "the walk started esbuild again");
        } finally {
          if (!closed) await app.close();
        }
      });
    } finally {
      if (wedged !== undefined) {
        signal(wedged, "SIGCONT");
        signal(wedged, "SIGKILL");
        await until(() => !inProcTable(wedged!), "the service's exit");
        await new Promise((r) => setTimeout(r, 0));
      }
      await dropTempDir(dir);
    }
  },
});

/** An app whose CSS step is instant until `<dir>/slow` exists, then 30 s. */
async function cssApp(
  prefix: string,
  slowAtBoot: boolean,
  slow = "exec sleep 30",
): Promise<string> {
  const dir = await tempDir(prefix);
  await Deno.writeTextFile(join(dir, "App.tsx"), APP(0));
  if (slowAtBoot) await Deno.writeTextFile(join(dir, "slow"), "");
  // The app's own deno.json: the step, and the imports the prod-bundle judge
  // resolves with (a red graph would never reach the step).
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify({
      build: { css: ["sh", "-c", `if [ -f slow ]; then ${slow}; fi`] },
      imports: {
        "aio": `${spec(REPO)}mod.ts`,
        "aio/jsx-runtime": `${REPO}src/jsx-runtime.ts`,
        "immer": "npm:immer@10.2.0",
      },
    }),
  );
  return dir;
}

const STOPPED_AT_CLOSE = "was still running when the server closed";

for (const when of ["boot", "save"] as const) {
  Deno.test({
    name:
      `close while the ${when}'s CSS step runs: the step is ended, said once, and no reload is sent or said`,
    sanitizeOps: true,
    sanitizeResources: true,
    ignore: !linux, // the step's subprocess is found through /proc
    fn: async () => {
      const { aio, cell } = await import("../mod.ts");
      const dir = await cssApp(`aio-close-css-${when}-`, when === "boot");
      try {
        await withLines(async (lines) => {
          const port = freePort();
          const app = await aio.run({
            cells: [cell(`dcbc${when}`, { state: { n: 0 }, methods: {} })],
            appId: `test-close-css-step-${when}`,
            client: "browser",
            persist: false,
            libraryMode: true,
            port,
            baseDir: dir,
          });
          let closed = false;
          try {
            if (when === "save") {
              const verdict = await graphVerdict(port);
              assert(
                verdict.valid,
                `a red graph never reaches the CSS step:\n${
                  verdict.errors.map((e) => e.message).join("\n")
                }`,
              );
              await Deno.writeTextFile(join(dir, "slow"), "");
              await Deno.writeTextFile(join(dir, "App.tsx"), APP(1));
            }
            await until(() => cssSteps().length === 1, "the CSS step");
            const from = lines.length;
            const t0 = performance.now();
            await app.close();
            closed = true;
            const ms = performance.now() - t0;
            assertEquals(cssSteps(), [], "the CSS step outlived close()");
            assert(
              ms < 2000,
              `close waited ${ms.toFixed(0)} ms on a 30 s step`,
            );
            await new Promise((r) => setTimeout(r, 0));
            const said = lines.slice(from);
            const line = said.filter((l) => l.includes(STOPPED_AT_CLOSE));
            assertEquals(
              line.length,
              1,
              `the stopped step is said once:\n${said.join("\n")}`,
            );
            // Ended when asked, nothing left behind: a note, not a warning.
            assert(/\bINFO\b/.test(line[0]!), line[0]);
            assert(line[0]!.includes("it was ended after"), line[0]);
            assert(!line[0]!.includes("STILL RUNNING"), line[0]);
            assertEquals(
              said.filter((l) => /reloaded|restyled|build\.css failed/.test(l)),
              [],
              "a closed server reported a reload, or a failed step",
            );
          } finally {
            if (!closed) await app.close();
          }
        });
      } finally {
        await dropTempDir(dir);
      }
    },
  });
}

// Ending the step is sending it a signal; the close then waits for the EXIT.
// A step that takes a moment to go (a tool flushing its output) is still a
// child of this process until it has, and a close that returned on the
// signal alone would leave it behind.
for (const when of ["boot", "save"] as const) {
  Deno.test({
    name:
      `close while the ${when}'s CSS step runs: a step slow to exit is waited for`,
    sanitizeOps: true,
    sanitizeResources: true,
    ignore: !linux, // the step's subprocess is found through /proc
    fn: async () => {
      const { aio, cell } = await import("../mod.ts");
      // On TERM it takes a moment to leave — inside the grace it is given;
      // until then it idles.
      const dir = await cssApp(
        "aio-close-css-slow-exit-",
        when === "boot",
        `trap "sleep 0.3; exit 0" TERM; while :; do sleep 0.05; done`,
      );
      const steps = () =>
        children().filter(([, c]) => c.includes("trap ")).map(([p]) => p);
      try {
        await withLines(async () => {
          const port = freePort();
          const app = await aio.run({
            cells: [cell(`dcbs${when}`, { state: { n: 0 }, methods: {} })],
            appId: `test-close-css-slow-exit-${when}`,
            client: "browser",
            persist: false,
            libraryMode: true,
            port,
            baseDir: dir,
          });
          let closed = false;
          try {
            const verdict = await graphVerdict(port);
            assert(verdict.valid, "a red graph never reaches the CSS step");
            if (when === "save") {
              await Deno.writeTextFile(join(dir, "slow"), "");
              await Deno.writeTextFile(join(dir, "App.tsx"), APP(1));
            }
            await until(
              () => inDir(dir).some(([, c]) => c === "sleep 0.05"),
              "the CSS step, idling",
            );
            await app.close();
            closed = true;
            assertEquals(steps(), [], "close returned before the step's exit");
          } finally {
            if (!closed) await app.close();
          }
        });
      } finally {
        await dropTempDir(dir);
      }
    },
  });
}

Deno.test({
  name: "a CSS step the close reached before it started says nothing",
  sanitizeOps: true,
  sanitizeResources: true,
  fn: async () => {
    const dir = await cssApp("aio-close-css-unstarted-", true);
    try {
      await withLines(async (lines) => {
        assertEquals(await _runAppCssStep(dir, AbortSignal.abort()), []);
        assertEquals(lines, [], "a step that never ran was reported");
      });
    } finally {
      await dropTempDir(dir);
    }
  },
});

// The boot's graph walk is work the close waits for — every part of it, the
// file reads between two transpiles included. Held at a read (a module that
// is a FIFO nobody has written yet), nothing of it is at esbuild; a close
// that only waited for esbuild's own work would return with the walk still
// running under it.
Deno.test({
  name:
    "close mid boot-validation: the walk is waited for, inside the stop's bound, and named when given up on",
  sanitizeOps: true,
  sanitizeResources: true,
  ignore: !linux, // mkfifo
  fn: async () => {
    const { aio, cell } = await import("../mod.ts");
    const dir = await tempDir("aio-close-boot-walk-");
    const fifo = join(dir, "held.ts");
    await Deno.writeTextFile(join(dir, "first.ts"), "export const a = 1;\n");
    assert(
      (await new Deno.Command("mkfifo", { args: [fifo] }).output()).success,
      "mkfifo",
    );
    await Deno.writeTextFile(
      join(dir, "App.tsx"),
      'import { a } from "./first.ts";\nimport { b } from "./held.ts";\n' +
        "export default function App() { return <main>{a + b}</main>; }\n",
    );
    const budgetMs = _ESBUILD.budgetMs;
    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      await Deno.writeTextFile(fifo, "export const b = 2;\n", {
        create: false,
      });
    };
    try {
      await withLines(async (lines) => {
        const app = await aio.run({
          cells: [cell("dcbf", { state: { n: 0 }, methods: {} })],
          appId: "test-close-boot-walk",
          client: "browser",
          persist: false,
          libraryMode: true,
          port: freePort(),
          baseDir: dir,
        });
        let closed = false;
        try {
          // The walk is past `first.ts` and at the read of the FIFO.
          await until(
            () => transpileCache.has(normPath(join(dir, "first.ts"))),
            "the walk's first module",
          );
          _ESBUILD.budgetMs = 400; // the wait is three quarters of it
          const from = lines.length;
          const t0 = performance.now();
          await app.close();
          closed = true;
          const ms = performance.now() - t0;
          // A timer never fires early: a close that returned sooner did not
          // wait for the walk.
          assert(ms >= 300, `close returned after ${ms.toFixed(0)} ms`);
          assertEquals(
            lines.slice(from).filter((l) =>
              l.includes("stopping esbuild with 1 piece(s) of work")
            ).length,
            1,
            `the walk given up on is named:\n${lines.slice(from).join("\n")}`,
          );
          const atRelease = lines.length;
          await release(); // the walk's read lands, in a server that closed
          await new Promise((r) => setTimeout(r, 0));
          assertEquals(lines.slice(atRelease), [], "printed after close");
          assert(
            !transpileCache.has(normPath(fifo)),
            "the walk transpiled a module after the close",
          );
        } finally {
          if (!closed) await app.close();
        }
      });
    } finally {
      _ESBUILD.budgetMs = budgetMs;
      await release();
      await dropTempDir(dir);
    }
  },
});

// A step the stop does not reach, or that will not go. A shell wrapper that
// does not `exec` is asked to end and does — but the tool it started holds
// the step's output pipes and runs on; a step that ignores the request has to
// be killed. Waiting for either one's pipes to close would be waiting for the
// 30 s the tool takes: the close ran into the teardown's cut, and everything
// after the step in it — closing the listener, stopping esbuild — never ran.
const STUBBORN: Record<
  string,
  { slow: string; says: string[]; left: boolean }
> = {
  "a wrapper that does not exec": {
    slow: "sleep 30; true",
    says: ["it was ended after", "STILL RUNNING"],
    left: true,
  },
  "a wrapper that ignores the request": {
    slow: "trap '' TERM; sleep 30",
    says: ["did not end when asked and was killed after", "STILL RUNNING"],
    left: true,
  },
  // The tool itself ignores it (the ignored signal survives the `exec`):
  // killed, and nothing of it is left.
  "a tool that ignores the request": {
    slow: "trap '' TERM; exec sleep 30",
    says: ["did not end when asked and was killed after"],
    left: false,
  },
};
for (const when of ["boot", "save"] as const) {
  for (const [what, { slow, says, left }] of Object.entries(STUBBORN)) {
    Deno.test({
      name:
        `close while the ${when}'s CSS step runs — ${what}: close is prompt, the port is closed, esbuild is stopped`,
      sanitizeOps: true,
      sanitizeResources: true,
      ignore: !linux, // the step and what it started are found through /proc
      fn: async () => {
        onlyOurServices();
        const { aio, cell } = await import("../mod.ts");
        const dir = await cssApp(
          "aio-close-css-stubborn-",
          when === "boot",
          slow,
        );
        const tool = () => inDir(dir).filter(([, c]) => c === "sleep 30");
        try {
          await withLines(async (lines) => {
            const port = freePort();
            const app = await aio.run({
              cells: [cell(`dcbx${when}`, { state: { n: 0 }, methods: {} })],
              appId: `test-close-css-stubborn-${when}`,
              client: "browser",
              persist: false,
              libraryMode: true,
              port,
              baseDir: dir,
            });
            let closed = false;
            try {
              const verdict = await graphVerdict(port);
              assert(verdict.valid, "a red graph never reaches the CSS step");
              if (when === "save") {
                await Deno.writeTextFile(join(dir, "slow"), "");
                await Deno.writeTextFile(join(dir, "App.tsx"), APP(1));
              }
              await until(() => tool().length === 1, "the step's tool");
              const from = lines.length;
              const t0 = performance.now();
              const closing = app.close();
              if (!left) {
                // The tool lives out its whole grace — and the listener does
                // not wait for it: the parts of the close run side by side.
                while (await accepting(port)) {
                  assert(performance.now() - t0 < 2000, "the port stays open");
                }
                assertEquals(tool().length, 1, "the listener waited for it");
              }
              await closing;
              closed = true;
              const ms = performance.now() - t0;
              const said = lines.slice(from);
              assert(
                ms < 2000,
                `close took ${ms.toFixed(0)} ms:\n${said.join("\n")}`,
              );
              assertEquals(await accepting(port), false, "the port is open");
              assertEquals(services(), [], "esbuild is still a child");
              assertEquals(
                children().filter(([, c]) => c.includes("-f slow")),
                [],
                "the step's own process is still a child",
              );
              const line = said.filter((l) => l.includes(STOPPED_AT_CLOSE));
              assertEquals(line.length, 1, said.join("\n"));
              assert(says.length > 0, "nothing to look for");
              for (const part of says) {
                assert(line[0]!.includes(part), `"${part}" — ${line[0]}`);
              }
              assert(/\bWARN\b/.test(line[0]!), line[0]);
              assertEquals(line[0]!.includes("STILL RUNNING"), left, line[0]);
              assertEquals(tool().length, left ? 1 : 0, "the tool");
              assertEquals(
                said.filter((l) => l.includes("did not finish inside")),
                [],
              );
            } finally {
              if (!closed) await app.close();
            }
          });
        } finally {
          // What the step left running is this test's to end.
          for (const [pid] of inDir(dir)) signal(pid, "SIGKILL");
          await until(() => inDir(dir).length === 0, "the tool's exit");
          await dropTempDir(dir);
        }
      },
    });
  }
}

// The parts of the server's close do not wait for each other. A response
// that never ends keeps the listener from closing — and used to keep esbuild
// running with it, because the line that stops it came after that wait.
Deno.test({
  name:
    "close with a response that never ends: esbuild is stopped without waiting for the listener",
  sanitizeOps: true,
  sanitizeResources: true,
  ignore: !linux, // the service is found through /proc
  fn: async () => {
    onlyOurServices();
    const { aio, cell } = await import("../mod.ts");
    const dir = await tempDir("aio-close-open-response-");
    await Deno.writeTextFile(join(dir, "App.tsx"), APP(0));
    let end: (() => void) | undefined;
    try {
      await withLines(async (lines) => {
        const port = freePort();
        const app = await aio.run({
          cells: [cell("dcbr", { state: { n: 0 }, methods: {} })],
          appId: "test-close-open-response",
          client: "browser",
          persist: false,
          libraryMode: true,
          port,
          baseDir: dir,
          routes: {
            "/held": () =>
              new Response(
                new ReadableStream<Uint8Array>({
                  start(ctl) {
                    ctl.enqueue(new TextEncoder().encode("x"));
                    end = () => ctl.close();
                  },
                }),
              ),
          },
        });
        await graphVerdict(port);
        assertEquals(services().length, 1, "one esbuild service child");
        const held = await fetch(`http://127.0.0.1:${port}/held`);
        const from = lines.length;
        const closing = app.close();
        try {
          // Well inside the teardown: the listener is still waiting for the
          // response, and esbuild is gone all the same.
          await until(
            () => services().length === 0,
            "esbuild stopped while the response is still open",
            3000,
          );
        } finally {
          end?.();
          await held.body?.cancel();
          await closing;
        }
        assertEquals(
          lines.slice(from).filter((l) => l.includes("did not finish inside")),
          [],
        );
      });
    } finally {
      await dropTempDir(dir);
    }
  },
});

// …and a request still in flight when esbuild was stopped may transpile and
// start the service again: it is stopped once more when the listener closes.
Deno.test({
  name:
    "close with a request that transpiles late: the service it starts is stopped too",
  sanitizeOps: true,
  sanitizeResources: true,
  ignore: !linux, // the service is found through /proc
  fn: async () => {
    onlyOurServices();
    const { aio, cell } = await import("../mod.ts");
    const dir = await tempDir("aio-close-late-transpile-");
    await Deno.writeTextFile(join(dir, "App.tsx"), APP(0));
    const go = Promise.withResolvers<void>();
    try {
      await withLines(async () => {
        const port = freePort();
        const tag = `v${crypto.randomUUID().replaceAll("-", "")}`;
        const app = await aio.run({
          cells: [cell("dcbl", { state: { n: 0 }, methods: {} })],
          appId: "test-close-late-transpile",
          client: "browser",
          persist: false,
          libraryMode: true,
          port,
          baseDir: dir,
          routes: {
            "/late": async () => {
              await go.promise;
              return new Response(
                await transpile(
                  `export const ${tag}: number = 1;\n`,
                  `/${tag}.ts`,
                ),
              );
            },
          },
        });
        await graphVerdict(port);
        assertEquals(services().length, 1, "one esbuild service child");
        const late = fetch(`http://127.0.0.1:${port}/late`);
        // The request is in the handler before the close begins.
        await new Promise((r) => setTimeout(r, 0));
        const closing = app.close();
        try {
          await until(() => services().length === 0, "the first stop", 3000);
        } finally {
          go.resolve();
          assert((await (await late).text()).includes(`const ${tag} = 1`));
          await closing;
        }
        assertEquals(services(), [], "the late transpile's service was left");
      });
    } finally {
      await dropTempDir(dir);
    }
  },
});

// A part of the close that FAILS is the close's failure — said, after every
// other part has had its turn.
Deno.test({
  name:
    "close with an esbuild whose stop throws: the failure is reported, and the rest still closes",
  sanitizeOps: true,
  sanitizeResources: true,
  fn: async () => {
    const { aio, cell } = await import("../mod.ts");
    const dir = await tempDir("aio-close-stop-throws-");
    await Deno.writeTextFile(join(dir, "App.tsx"), APP(0));
    const real = _ESBUILD.spec;
    try {
      const fake = join(dir, "fake-esbuild.mjs");
      await Deno.writeTextFile(
        fake,
        'export const stop = () => { throw new Error("stop failed"); };\n',
      );
      await withLines(async (lines) => {
        const port = freePort();
        const app = await aio.run({
          cells: [cell("dcbt", { state: { n: 0 }, methods: {} })],
          appId: "test-close-stop-throws",
          client: "browser",
          persist: false,
          libraryMode: true,
          port,
          baseDir: dir,
        });
        await graphVerdict(port);
        // The next stop is handed a `stop` that throws.
        _ESBUILD.spec = toFileUrl(fake).href;
        await loadEsbuild();
        _ESBUILD.spec = real;
        const from = lines.length;
        await app.close();
        const said = lines.slice(from);
        assertEquals(
          said.filter((l) =>
            l.includes("shutdown: server") && l.includes("stop failed")
          ).length,
          1,
          said.join("\n"),
        );
        assertEquals(await accepting(port), false, "the port is open");
      });
    } finally {
      _ESBUILD.spec = real;
      // The real service was never stopped (its stop was swapped out).
      await loadEsbuild();
      await stopEsbuild();
      await dropTempDir(dir);
    }
  },
});
