// Every git the update path spawns runs "in the background": it never
// prompts, has a deadline, and leaves nothing behind. The poll's ls-remote got
// that in 6d84cf89; the rebuild's `git clone` (poll → applyGit →
// rebuildFromGit, unattended under `auto`) was a plain spawn — a credential
// challenge ran the askpass GUI, and a stalled remote hung the update forever.
import { assert, assertEquals, assertMatch } from "@std/assert";
import { DELIMITER, join } from "@std/path";
import { gitLsRemote, gitSshEnv } from "../src/server/updates-check.ts";
import { rebuildFromGit } from "../src/server/updates-rebuild.ts";
import type { Log } from "../src/diagnostics/logger.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

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
  const loop = (async () => {
    try {
      for await (const c of l) conns.push(c);
    } catch { /* aio-ok: listener closed by the test */ }
  })();
  return {
    url: `http://127.0.0.1:${(l.addr as Deno.NetAddr).port}`,
    async [Symbol.asyncDispose]() {
      l.close();
      for (const c of conns) c.close();
      await loop;
    },
  };
}

/** Every live descendant of this process (Linux `/proc`). */
function descendants(): number[] {
  const kids = new Map<number, number[]>();
  for (const e of Deno.readDirSync("/proc")) {
    if (!/^\d+$/.test(e.name)) continue;
    try {
      const stat = Deno.readTextFileSync(`/proc/${e.name}/stat`);
      const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      kids.set(ppid, [...(kids.get(ppid) ?? []), Number(e.name)]);
    } catch { /* aio-ok: the process exited mid-scan */ }
  }
  const out: number[] = [];
  const walk = (p: number) =>
    (kids.get(p) ?? []).forEach((c) => (out.push(c), walk(c)));
  walk(Deno.pid);
  return out;
}

function alive(pid: number): boolean {
  try {
    const stat = Deno.readTextFileSync(`/proc/${pid}/stat`);
    return stat.slice(stat.lastIndexOf(")") + 2)[0] !== "Z";
  } catch {
    return false; // aio-ok: gone
  }
}

/** No core.sshCommand from the machine this runs on. */
const noUserConfig = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

/** Run `fn` with env vars set, restoring them after. */
async function withEnv<T>(
  vars: Record<string, string | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = Object.fromEntries(
    Object.keys(vars).map((k) => [k, Deno.env.get(k)]),
  );
  const put = (v: Record<string, string | undefined>) => {
    for (const [k, x] of Object.entries(v)) {
      if (x === undefined) Deno.env.delete(k);
      else Deno.env.set(k, x);
    }
  };
  put(vars);
  try {
    return await fn();
  } finally {
    put(prev);
  }
}

Deno.test({
  name:
    "git rebuild: a clone from a stalled remote hits its deadline and leaves no process",
  ignore: Deno.build.os !== "linux",
  async fn() {
    await using host = silentHost();
    const work = await tempDir("aio-rebuild-stall-");
    try {
      const before = new Set(descendants());
      const t0 = Date.now();
      const pending = rebuildFromGit({
        source: `${host.url}/repo.git`,
        ref: "main",
        workDir: work,
        log: silentLog,
        timeoutMs: 1500,
      });
      await new Promise((r) => setTimeout(r, 1000));
      const spawned = descendants().filter((p) => !before.has(p));
      assert(spawned.length >= 2, `saw only ${spawned.length} process(es)`);
      const r = await pending;
      assert(!r.ok, "a stalled clone must not succeed");
      assertMatch(r.error, /made no progress for 1\.5s/);
      assert(Date.now() - t0 < 10_000, `took ${Date.now() - t0}ms`);
      const t1 = Date.now();
      while (spawned.some(alive) && Date.now() - t1 < 3000) {
        await new Promise((r) => setTimeout(r, 50));
      }
      const left = spawned.filter(alive);
      assert(left.length === 0, `still running: ${left.join(", ")}`);
    } finally {
      await dropTempDir(work);
    }
  },
});

Deno.test({
  name:
    "git rebuild: an auth challenge on the clone never runs an askpass program",
  ignore: Deno.build.os === "windows",
  async fn() {
    const dir = await tempDir("aio-rebuild-askpass-");
    const marker = join(dir, "asked");
    const askpass = join(dir, "askpass.sh");
    await Deno.writeTextFile(askpass, `#!/bin/sh\ntouch "${marker}"\necho x\n`);
    await Deno.chmod(askpass, 0o755);
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
      const r = await withEnv(
        { GIT_ASKPASS: askpass, SSH_ASKPASS: askpass },
        () =>
          rebuildFromGit({
            source: `http://127.0.0.1:${server.addr.port}/repo.git`,
            ref: "main",
            workDir: join(dir, "work"),
            log: silentLog,
            timeoutMs: 10_000,
          }),
      );
      assert(!r.ok);
      assertMatch(r.error, /git clone failed/);
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
  ignore: Deno.build.os === "windows",
  async fn() {
    const dir = await tempDir("aio-git-ssh-env-");
    const argv = join(dir, "argv");
    const bin = join(dir, "bin");
    await Deno.mkdir(bin);
    // A fake `ssh` first on PATH: records its arguments, then fails.
    await Deno.writeTextFile(
      join(bin, "ssh"),
      `#!/bin/sh\necho "$@" >> "${argv}"\nexit 255\n`,
    );
    await Deno.chmod(join(bin, "ssh"), 0o755);
    const path = `${bin}${DELIMITER}${Deno.env.get("PATH") ?? ""}`;
    const source = "ssh://nobody@127.0.0.1/repo.git";
    try {
      await withEnv(
        {
          PATH: path,
          GIT_SSH_COMMAND: undefined,
          GIT_SSH: undefined,
          ...noUserConfig,
        },
        async () => {
          assert(!(await gitLsRemote(source, "main", 10_000)).ok);
          const r = await rebuildFromGit({
            source,
            ref: "main",
            workDir: join(dir, "work"),
            log: silentLog,
            timeoutMs: 10_000,
          });
          assert(!r.ok);
        },
      );
      const calls = (await Deno.readTextFile(argv)).trim().split("\n");
      assertEquals(calls.length, 2, calls.join("\n"));
      for (const c of calls) {
        assertMatch(c, /-o BatchMode=yes/);
        assertMatch(c, /-o ServerAliveInterval=\d+ -o ServerAliveCountMax=3/);
      }
      // The user's own ssh command is left exactly as they set it.
      await Deno.remove(argv);
      await withEnv(
        { PATH: path, GIT_SSH_COMMAND: "ssh -o User=mine", ...noUserConfig },
        () => gitLsRemote(source, "main", 10_000),
      );
      const theirs = (await Deno.readTextFile(argv)).trim();
      assertMatch(theirs, /-o User=mine/);
      assert(!/ServerAlive|BatchMode/.test(theirs), theirs);
    } finally {
      await dropTempDir(dir);
    }
  },
});
