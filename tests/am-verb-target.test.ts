// WHICH instance a process verb acts on — one resolver, read by stop, kill and
// restart, and one definition of "this project's instance".
//
// Four measured failures, all of them "am acted on an app the command did not
// name":
//
//  1. `am kill --port=N` ignored --port entirely (it was read only under
//     --stale) and SIGTERM'd the cwd's app. `am kill --port=1`, a port nobody
//     holds, killed it too.
//  2. `am` in a SUBDIRECTORY of an app derived the app id from the cwd's
//     basename (`src`) while `projectRoot()` walked up — two deciders, so
//     `cd src && am status` reported a stopped app called "src".
//  3. The same app in two checkouts: `am start` refused with "already running"
//     naming neither checkout, `am doctor` said nothing of this project was
//     running, and `am restart` silently stopped the other checkout's process
//     and relaunched the app from this tree.
//  4. With the cwd's app down and some OTHER app up, the "one running instance"
//     fallback let a MUTATION reach that other app after a note on stderr.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  alreadyRunningLine,
  foreignCheckout,
  instancesInProject,
  lockOnPort,
  noLockOnPortMessage,
  resolveLockTarget,
} from "../src/am/am-cmd-process.ts";
import { checkRunningAio } from "../src/am/am-cmd-doctor.ts";
import { cwdIsProject, projectRoot } from "../src/am/am-project.ts";
import {
  _resetTargetGuess,
  resolveAmAppId,
  resolvePort,
} from "../src/am/am-utils.ts";
import { trojanPost } from "../src/am/am-http.ts";
import {
  isProcessAlive,
  type LockData,
  processStartToken,
  writeLock,
} from "../src/server/single-instance-lock.ts";

/** Pin AIO_APPS_DIR (and therefore lockDir) to a throwaway root, and RESTORE
 *  whatever the suite had — never delete it. */
async function withAppsDir<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const prev = Deno.env.get("AIO_APPS_DIR");
  const root = await Deno.makeTempDir({ prefix: "aio-am-verb-" });
  Deno.env.set("AIO_APPS_DIR", root);
  _resetTargetGuess();
  try {
    return await fn(root);
  } finally {
    if (prev === undefined) Deno.env.delete("AIO_APPS_DIR");
    else Deno.env.set("AIO_APPS_DIR", prev);
    _resetTargetGuess();
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
}

/** A lock whose owner is genuinely alive: this test process. */
function fakeLock(appId: string, port: number, cwd: string): LockData {
  const lock: LockData = {
    appId,
    pid: Deno.pid,
    port,
    startedAt: Date.now(),
    status: "started",
    cwd,
    ...(processStartToken(Deno.pid) !== null
      ? { startToken: processStartToken(Deno.pid)! }
      : {}),
  };
  writeLock(lock);
  return lock;
}

/** A directory that looks like an aio project. */
async function project(root: string, name: string): Promise<string> {
  const dir = join(root, name);
  await Deno.mkdir(join(dir, "src"), { recursive: true });
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify({ appId: name, tasks: {} }),
  );
  await Deno.writeTextFile(join(dir, "src", "app.ts"), "// entry\n");
  return dir;
}

async function inDir<T>(dir: string, fn: () => Promise<T> | T): Promise<T> {
  const prev = Deno.cwd();
  Deno.chdir(dir);
  try {
    return await fn();
  } finally {
    Deno.chdir(prev);
  }
}

// ── 1. --port names the app, for every verb ─────────────────────────

Deno.test("am kill/stop/restart: --port=N names the app that HOLDS it", async () => {
  await withAppsDir(async (root) => {
    const alpha = await project(root, "alpha");
    await project(root, "beta");
    fakeLock("alpha", 8101, alpha);
    const betaLock = fakeLock("beta", 8102, join(root, "beta"));

    await inDir(alpha, () => {
      // Standing in alpha, --port names beta's port: the target is BETA.
      assertEquals(lockOnPort(8102)?.appId, "beta");
      const t = resolveLockTarget({ port: 8102 });
      assert(t.kind === "target", `expected a target, got ${t.kind}`);
      assertEquals(t.target.appId, "beta");
      assertEquals(t.target.pf?.pid, betaLock.pid);
      // Without --port it is still alpha's own lock.
      const own = resolveLockTarget({});
      assert(own.kind === "target");
      assertEquals(own.target.appId, "alpha");
      // --app and --port disagreeing is a refusal, not a silent choice.
      const clash = resolveLockTarget({ port: 8102, app: "alpha" });
      assert(clash.kind === "none");
      assertStringIncludes(clash.error, "refusing to act on a different app");
    });
  });
});

Deno.test("am kill --port=N: a port nobody holds is refused, not redirected", async () => {
  await withAppsDir(async (root) => {
    const alpha = await project(root, "alpha");
    fakeLock("alpha", 8103, alpha);
    await inDir(alpha, () => {
      // THE bug: `am kill --port=1` used to kill alpha. The resolver must not
      // hand back alpha's lock for a port alpha does not hold.
      const t = resolveLockTarget({ port: 1 });
      assertEquals(t.kind, "probe"); // `kill` turns this into a refusal…
      assertStringIncludes(noLockOnPortMessage(1), "no running app holds");
      assertStringIncludes(noLockOnPortMessage(1), "alpha @ :8103");
      // …and never into alpha.
      assert(
        t.kind !== "target",
        "a port with no lock must never resolve to the cwd's app",
      );
    });
  });
});

// ── 2. one app id, from anywhere inside the project ─────────────────

Deno.test("am: a SUBDIRECTORY of an app is still that app", async () => {
  await withAppsDir(async (root) => {
    const alpha = await project(root, "alpha");
    fakeLock("alpha", 8104, alpha);
    await inDir(join(alpha, "src"), () => {
      assertEquals(projectRoot(), alpha);
      assertEquals(cwdIsProject(), true);
      // Was "src": the basename of a directory with no deno.json in it.
      assertEquals(resolveAmAppId(), "alpha");
      const t = resolveLockTarget({});
      assert(t.kind === "target");
      assertEquals(t.target.appId, "alpha");
      assertEquals(t.target.port, 8104);
    });
    // …and outside any project the fallback is still a fallback.
    await inDir(root, () => assertEquals(cwdIsProject(), false));
  });
});

// ── 3. the same app in two checkouts ────────────────────────────────

Deno.test("am: an instance from ANOTHER checkout is named, not hidden", async () => {
  await withAppsDir(async (root) => {
    const a = await project(root, "alpha");
    const b = join(root, "second");
    await Deno.mkdir(join(b, "src"), { recursive: true });
    await Deno.writeTextFile(
      join(b, "deno.json"),
      JSON.stringify({ appId: "alpha" }),
    );
    // One app id, one lock — held by the OTHER checkout.
    const lock = fakeLock("alpha", 8105, a);

    await inDir(b, () => {
      assertEquals(foreignCheckout(lock), a);
      const line = alreadyRunningLine(lock);
      assertStringIncludes(line, "already running: alpha");
      assertStringIncludes(line, `started from ${a}`);
      assertStringIncludes(line, "not this checkout");
      // ONE definition of "this project's instance": status resolves by id,
      // so doctor and stop --all must see it too.
      assertEquals(instancesInProject().map((i) => i.appId), ["alpha"]);
    });
    // From the checkout it actually runs in, there is nothing to say.
    await inDir(a, () => {
      assertEquals(foreignCheckout(lock), null);
      assertEquals(alreadyRunningLine(lock).includes("started from"), false);
    });
  });
});

Deno.test("am doctor: a foreign-checkout instance is checked where it lives", async () => {
  await withAppsDir(async (root) => {
    const a = await project(root, "alpha");
    const b = await project(root, "second");
    const finding = await checkRunningAio(b, {
      appId: "alpha",
      pid: Deno.pid,
      startedAt: Date.now(),
      cwd: a,
    });
    assertStringIncludes(finding.detail, `started from ${a}`);
    assertStringIncludes(finding.detail, "not this checkout");
    // An instance of this very checkout says nothing of the sort.
    const here = await checkRunningAio(b, {
      appId: "second",
      pid: Deno.pid,
      startedAt: Date.now(),
      cwd: b,
    });
    assertEquals(here.detail.includes("not this checkout"), false);
  });
});

// ── 4. a guess may be read from, never written to ───────────────────

Deno.test("am: the cwd's own project id is never a guess", async () => {
  await withAppsDir(async (root) => {
    const alpha = await project(root, "alpha");
    await project(root, "beta");
    fakeLock("beta", 8106, join(root, "beta")); // only BETA is up
    await inDir(alpha, () => {
      // The measured bug: standing in alpha's own directory, resolvePort fell
      // through to "the one that is running" and every verb went to beta.
      let threw: string | null = null;
      try {
        resolvePort(undefined, resolveAmAppId());
      } catch (e) {
        threw = e instanceof Error ? e.message : String(e);
      }
      assert(
        threw !== null,
        "alpha is not running: the answer is 'not running', never 'here is beta'",
      );
      assertStringIncludes(threw, "alpha");
    });
  });
});

Deno.test("am: a MUTATION over a discovered target is refused", async () => {
  await withAppsDir(async (root) => {
    // A directory that is NOT a project — the only case the fallback serves.
    const bare = join(root, "nowhere");
    await Deno.mkdir(bare, { recursive: true });
    await project(root, "beta");
    const beta = fakeLock("beta", 8107, join(root, "beta"));
    await inDir(bare, async () => {
      const id = resolveAmAppId(); // "nowhere", from the directory name
      assertEquals(id, "nowhere");
      const port = resolvePort(undefined, id); // the fallback fires…
      assertEquals(port, beta.port);
      // …and a WRITE through it is refused, whatever route it names.
      const r = await trojanPost(port, "dispatch", { type: "x" }, id);
      assert(!r.ok, "a write over a guessed target must not go through");
      assertStringIncludes(r.error, 'refusing to change "beta"');
      assertStringIncludes(r.error, "--app=beta");
    });
  });
});

// ── 5. the same three verbs, through the real CLI ───────────────────
//
// The resolver above is the fix; these are the symptoms it was measured on.
// A real process, a real lock and a real `am` — an in-process test cannot show
// that `am kill --port=1` sent SIGTERM to the wrong pid.

const AM = new URL("../src/am.ts", import.meta.url).pathname;
const CONFIG = new URL("../deno.json", import.meta.url).pathname;

async function runAm(
  cwd: string,
  apps: string,
  ...args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "--config", CONFIG, AM, ...args],
    cwd,
    env: {
      ...Deno.env.toObject(),
      AIO_APPS_DIR: apps,
      AIO_AM_NO_DELEGATE: "1",
      NO_COLOR: "1",
    },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const dec = new TextDecoder();
  return {
    code: out.code,
    stdout: dec.decode(out.stdout),
    stderr: dec.decode(out.stderr),
  };
}

/** A process that exists only to be (not) killed. */
function victim(): Deno.ChildProcess {
  return new Deno.Command(Deno.execPath(), {
    args: ["eval", "await new Promise((r) => setTimeout(r, 300000))"],
    stdin: "null",
    stdout: "null",
    stderr: "null",
  }).spawn();
}

Deno.test({
  name: "am kill --port=N: a port nobody holds kills NOTHING",
  fn: async () => {
    await withAppsDir(async (root) => {
      const alpha = await project(root, "alpha");
      const apps = Deno.env.get("AIO_APPS_DIR")!;
      const child = victim();
      try {
        writeLock({
          appId: "alpha",
          pid: child.pid,
          port: 8201,
          startedAt: Date.now(),
          status: "started",
          cwd: alpha,
        });
        const r = await runAm(alpha, apps, "kill", "--port=1", "--json");
        assertEquals(r.code, 1, `stdout: ${r.stdout} stderr: ${r.stderr}`);
        assertStringIncludes(r.stdout, "no running app holds port 1");
        // THE regression: alpha's process used to die here.
        assert(
          isProcessAlive(child.pid),
          "the cwd's app must survive a kill that never named it",
        );
        assert(lockOnPort(8201) !== null, "…and keep its lock");
      } finally {
        try {
          child.kill("SIGKILL");
        } catch { /* already gone */ }
        await child.status;
      }
    });
  },
});

Deno.test({
  name: "am restart: refuses to relaunch ANOTHER checkout's instance here",
  fn: async () => {
    await withAppsDir(async (root) => {
      const a = await project(root, "alpha");
      const b = join(root, "second");
      await Deno.mkdir(join(b, "src"), { recursive: true });
      await Deno.writeTextFile(
        join(b, "deno.json"),
        JSON.stringify({ appId: "alpha" }),
      );
      await Deno.writeTextFile(join(b, "src", "app.ts"), "// entry\n");
      const apps = Deno.env.get("AIO_APPS_DIR")!;
      const child = victim();
      try {
        writeLock({
          appId: "alpha",
          pid: child.pid,
          port: 8202,
          startedAt: Date.now(),
          status: "started",
          cwd: a,
        });
        const r = await runAm(b, apps, "restart", "--json");
        assertEquals(r.code, 1, r.stdout);
        const doc = JSON.parse(r.stdout.trim()) as { error: string };
        assertStringIncludes(doc.error, `running from ${a}`);
        assertStringIncludes(doc.error, "--force");
        // It stopped nothing on the way to refusing.
        assert(
          isProcessAlive(child.pid),
          "a refusal must leave the other checkout's process alone",
        );
      } finally {
        try {
          child.kill("SIGKILL");
        } catch { /* already gone */ }
        await child.status;
      }
    });
  },
});

Deno.test({
  name: "am restart --json with nothing running emits ONE document",
  fn: async () => {
    await withAppsDir(async (root) => {
      const alpha = await project(root, "alpha");
      const apps = Deno.env.get("AIO_APPS_DIR")!;
      // Nothing is running: `am restart` used to print an {error} document
      // saying it could not recover the launch flags of an instance that does
      // not exist, and THEN the real result — two JSON documents, one of them
      // about a fact that was not true.
      const r = await runAm(alpha, apps, "restart", "--no-wait", "--json");
      const docs = r.stdout.trim().split("\n").filter((l) => l.trim());
      assertEquals(
        docs.length,
        1,
        `one invocation, one document — got:\n${r.stdout}`,
      );
      JSON.parse(docs[0]!); // …and it is a document
      assertEquals(
        r.stdout.includes("wasn't started by"),
        false,
        "there is no instance whose launch flags could have been missed",
      );
    });
  },
});
