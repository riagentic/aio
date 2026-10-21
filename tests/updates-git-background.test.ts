// Every git the update path spawns runs "in the background": it never
// prompts, has a deadline, and leaves nothing behind. The poll's ls-remote got
// that in 6d84cf89; the rebuild's `git clone` (poll → applyGit →
// rebuildFromGit, unattended under `auto`) was a plain spawn — a credential
// challenge ran the askpass GUI, and a stalled remote hung the update forever.
import { assert, assertEquals, assertMatch } from "@std/assert";
import { join } from "@std/path";
import { gitSshEnv } from "../src/server/updates-check.ts";
import { rebuildFromGit } from "../src/server/updates-rebuild.ts";
import type { Log } from "../src/diagnostics/logger.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { EXE, writeProgram } from "./fake-program-helper.ts";
import {
  descendantsIn,
  gitRunsFrom,
  inChildEnv,
  processParents,
} from "./proc-helper.ts";

const silentLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Log;

/** Accepts TCP, reads nothing, answers nothing — until closed. */
function silentHost() {
  const l = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const conns: Deno.Conn[] = [];
  const { promise: connected, resolve } = Promise.withResolvers<void>();
  const loop = (async () => {
    try {
      for await (const c of l) conns.push(c), resolve();
    } catch { /* aio-ok: listener closed by the test */ }
  })();
  return {
    url: `http://127.0.0.1:${(l.addr as Deno.NetAddr).port}`,
    /** Resolves when a client — git's transport helper — has connected. */
    connected,
    async [Symbol.asyncDispose]() {
      l.close();
      for (const c of conns) c.close();
      await loop;
    },
  };
}

/** Every live descendant of this process. */
const descendants = async () => descendantsIn(await processParents(), Deno.pid);

// The deadline under test. Windows has no /proc: one look at its process
// table takes seconds, and the clone must still be running when it is taken.
const STALL_MS = Deno.build.os === "windows" ? 12_000 : 1500;

/** For a git that is expected to FAIL at once (a stand-in `ssh` exits 255):
 *  long enough that the deadline is never what ended it. */
const PATIENT_MS = 60_000;

/** No core.sshCommand from the machine this runs on. */
const noUserConfig = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

// A case about an inherited variable runs in a child (`inChildEnv`): set in
// THIS process's env, an askpass, a PATH with a stand-in `ssh` or a
// GIT_CONFIG_GLOBAL reached every parallel test file's git.
const CHECK = new URL("../src/server/updates-check.ts", import.meta.url).href;
const REBUILD = new URL("../src/server/updates-rebuild.ts", import.meta.url)
  .href;
/** The child's imports, and its silent log. */
const CHILD_HEAD = `import { gitLsRemote } from ${JSON.stringify(CHECK)};
import { rebuildFromGit } from ${JSON.stringify(REBUILD)};
const log = { info() {}, warn() {}, error() {}, debug() {} };`;
type Outcome = { ok: boolean; error?: string };

Deno.test({
  name:
    "git rebuild: a clone from a stalled remote hits its deadline and leaves no process",
  async fn() {
    await using host = silentHost();
    const work = await tempDir("aio-rebuild-stall-");
    try {
      const before = new Set(await descendants());
      const t0 = Date.now();
      const pending = rebuildFromGit({
        source: `${host.url}/repo.git`,
        ref: "main",
        workDir: work,
        log: silentLog,
        timeoutMs: STALL_MS,
      });
      // git's transport helper is up (and git, its parent) once the silent
      // host has a connection.
      await host.connected;
      const spawned = (await descendants()).filter((p) => !before.has(p));
      assert(spawned.length >= 2, `saw only ${spawned.length} process(es)`);
      const r = await pending;
      assert(!r.ok, "a stalled clone must not succeed");
      assertMatch(
        r.error,
        new RegExp(
          `made no progress for ${STALL_MS / 1000}s`.replace(".", "\\."),
        ),
      );
      assert(
        Date.now() - t0 < STALL_MS + 8500,
        `took ${Date.now() - t0}ms`,
      );
      const stillRunning = async () => {
        const live = await processParents();
        return spawned.filter((p) => live.has(p));
      };
      const t1 = Date.now();
      let left = await stillRunning();
      while (left.length > 0 && Date.now() - t1 < 3000) {
        await new Promise((r) => setTimeout(r, 50));
        left = await stillRunning();
      }
      assert(left.length === 0, `still running: ${left.join(", ")}`);
    } finally {
      await dropTempDir(work);
    }
  },
});

Deno.test({
  name:
    "git rebuild: an auth challenge on the clone never runs an askpass program",
  async fn() {
    const dir = await tempDir("aio-rebuild-askpass-");
    const marker = join(dir, "asked");
    // A program every OS can run (a real executable on Windows): were it a
    // `.sh` there, "never ran" would hold whatever git was told.
    const askpass = join(dir, `askpass${EXE}`);
    await writeProgram(askpass, `#!/bin/sh\ntouch "${marker}"\necho x\n`);
    const ac = new AbortController();
    const server = Deno.serve(
      { hostname: "127.0.0.1", port: 0, signal: ac.signal, onListen() {} },
      () =>
        new Response("no", {
          status: 401,
          headers: { "WWW-Authenticate": 'Basic realm="r"' },
        }),
    );
    try {
      const opts = JSON.stringify({
        source: "http://127.0.0.1:" + server.addr.port + "/repo.git",
        ref: "main",
        workDir: join(dir, "work"),
        timeoutMs: 10_000,
      });
      const r = await inChildEnv<Outcome>(
        { GIT_ASKPASS: askpass, SSH_ASKPASS: askpass },
        CHILD_HEAD,
        `return await rebuildFromGit({ ...${opts}, log });`,
      );
      assert(!r.ok);
      assertMatch(r.error ?? "", /git clone failed/);
      let asked = true;
      try {
        await Deno.stat(marker);
      } catch {
        asked = false; // aio-ok: the marker's absence IS the pass
      }
      assert(!asked, "the rebuild's clone ran GIT_ASKPASS — a GUI prompt");
    } finally {
      ac.abort();
      await server.finished;
      await dropTempDir(dir);
    }
  },
});

Deno.test("gitSshEnv: BatchMode + keepalives unless the user chose their own ssh", () => {
  assertEquals(gitSshEnv({}, "", 60), {
    GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o ConnectTimeout=60 " +
      "-o ServerAliveInterval=20 -o ServerAliveCountMax=3",
  });
  assertMatch(
    gitSshEnv({}, "", 1).GIT_SSH_COMMAND ?? "",
    /ServerAliveInterval=1 /,
  );
  // Theirs outranks ours: GIT_SSH_COMMAND, core.sshCommand, GIT_SSH.
  assertEquals(gitSshEnv({ GIT_SSH_COMMAND: "ssh -i k" }, "", 60), {});
  assertEquals(gitSshEnv({}, "ssh -i k", 60), {});
  assertEquals(gitSshEnv({ GIT_SSH: "/usr/bin/plink" }, "", 60), {});
});

Deno.test({
  name:
    "git over ssh: the poll and the clone both hand ssh BatchMode + keepalives",
  async fn() {
    const dir = await tempDir("aio-git-ssh-env-");
    const argv = join(dir, "argv");
    const bin = join(dir, "bin");
    await Deno.mkdir(bin);
    // A fake `ssh` first on PATH: records its arguments, then fails.
    await writeProgram(
      join(bin, "ssh" + EXE),
      `#!/bin/sh\necho "$@" >> "${argv}"\nexit 255\n`,
    );
    const first = gitRunsFrom(bin);
    const source = "ssh://nobody@127.0.0.1/repo.git";
    try {
      // A deadline no first start of a just-written program reaches: at
      // 10 s a busy Windows ended the poll before the stand-in `ssh` had
      // recorded anything (one call seen, the clone's), and `!ok` could
      // not tell that from the refusal this test is about. It fails in
      // about a second either way.
      const { ls, r } = await inChildEnv<{ ls: Outcome; r: Outcome }>(
        {
          ...first,
          GIT_SSH_COMMAND: undefined,
          GIT_SSH: undefined,
          ...noUserConfig,
        },
        CHILD_HEAD,
        `const source = ${JSON.stringify(source)};
const ls = await gitLsRemote(source, "main", ${PATIENT_MS});
const r = await rebuildFromGit({
  source,
  ref: "main",
  workDir: ${JSON.stringify(join(dir, "work"))},
  log,
  timeoutMs: ${PATIENT_MS},
});
return { ls, r };`,
      );
      assert(!ls.ok);
      assert(!/did not answer within/.test(ls.error ?? ""), ls.error);
      assert(!r.ok);
      assertMatch(r.error ?? "", /git clone failed/);
      const calls = (await Deno.readTextFile(argv)).trim().split("\n");
      assertEquals(calls.length, 2, calls.join("\n"));
      for (const c of calls) {
        assertMatch(c, /-o BatchMode=yes/);
        assertMatch(c, /-o ServerAliveInterval=\d+ -o ServerAliveCountMax=3/);
      }
      // The user's own ssh command is left exactly as they set it.
      await Deno.remove(argv);
      await inChildEnv(
        { ...first, GIT_SSH_COMMAND: "ssh -o User=mine", ...noUserConfig },
        CHILD_HEAD,
        `return await gitLsRemote(${
          JSON.stringify(source)
        }, "main", ${PATIENT_MS});`,
      );
      const theirs = (await Deno.readTextFile(argv)).trim();
      assertMatch(theirs, /-o User=mine/);
      assert(!/ServerAlive|BatchMode/.test(theirs), theirs);
    } finally {
      await dropTempDir(dir);
    }
  },
});
