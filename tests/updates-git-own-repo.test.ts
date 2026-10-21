// The update path's git addresses only the repo it names — never one an
// INHERITED environment names — and a slow clone that is still moving is never
// killed.
//
// 1. An app started from a git hook (a post-receive deploy exports GIT_DIR)
//    ran its update clone fine, but `rev-parse HEAD` in the clone answered the
//    HOOK's repo: that commit was recorded as installed, never matched the
//    remote, and `auto` rebuilt and restarted forever. GIT_WORK_TREE made
//    every clone fail; `core.sshCommand` was read from the wrong repo.
// 2. The clone had a fixed 15-min wall: a 150 MB repo over 1 Mbit/s (~20 min)
//    was killed on every check — re-downloaded forever, never installed, and
//    reported as "unreachable or stalled".
import { assert, assertEquals, assertMatch } from "@std/assert";
import { join } from "@std/path";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { EXE, programBytes, writeProgram } from "./fake-program-helper.ts";
import { gitRunsFrom, inChildEnv } from "./proc-helper.ts";

/** Test-side git: the test's own env, minus anything a case sets. */
async function git(args: string[], cwd: string): Promise<string> {
  const out = await new Deno.Command("git", {
    args,
    cwd,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
    env: { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  }).output();
  const text = new TextDecoder().decode(out.success ? out.stdout : out.stderr);
  if (!out.success) throw new Error(`git ${args.join(" ")}: ${text}`);
  return text.trim();
}

/** A committed repo; `files` are written before the commit. */
async function repo(
  dir: string,
  files: Record<string, string | Uint8Array>,
): Promise<string> {
  await Deno.mkdir(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    if (typeof body === "string") {
      await Deno.writeTextFile(join(dir, name), body);
    } else await Deno.writeFile(join(dir, name), body);
  }
  await git(["init", "-q", "-b", "main"], dir);
  await git(["add", "."], dir);
  await git(
    [
      "-c",
      "user.email=t@example.com",
      "-c",
      "user.name=t",
      "commit",
      "-qm",
      "x",
    ],
    dir,
  );
  return await git(["rev-parse", "HEAD"], dir);
}

/** An app whose build records the GIT_DIR it saw into its data contract.
 *  The artifact is a fake program (tests/fake-program-helper.ts): the build
 *  appends its script to `stub.bin` — nothing on unix, the executable that
 *  runs such a script on Windows. */
const app = {
  "deno.json": JSON.stringify({ tasks: { compile: "deno run -A make.ts" } }),
  "stub.bin": await programBytes(""),
  "make.ts": `
await Deno.mkdir("dist", { recursive: true });
const seen = JSON.stringify(Deno.env.get("GIT_DIR") ?? "");
const out = "dist/app${EXE}";
await Deno.writeFile(out, await Deno.readFile("stub.bin"));
await Deno.writeTextFile(out, \`#!/bin/sh
echo '{"schema":1,"cells":{},"gitDir":\${seen}}'
\`, { append: true });
if (Deno.build.os !== "windows") await Deno.chmod(out, 0o755);
`,
};

const REBUILD =
  new URL("../src/server/updates-rebuild.ts", import.meta.url).href;
const CHECK = new URL("../src/server/updates-check.ts", import.meta.url).href;

type Rebuilt = {
  ok: boolean;
  sha?: string;
  error?: string;
  contract?: unknown;
  /** How long the rebuild took, measured in the child. */
  ms: number;
};

/** `rebuildFromGit(opts)` in a child whose environment has `env` — an
 *  inherited variable is the case, and the process's own env is every
 *  parallel test file's (`inChildEnv`). */
function rebuildUnder(
  env: Record<string, string | undefined>,
  opts: Record<string, unknown>,
): Promise<Rebuilt> {
  return inChildEnv<Rebuilt>(
    env,
    `import { rebuildFromGit } from ${JSON.stringify(REBUILD)};`,
    `const log = { info() {}, warn() {}, error() {}, debug() {} };
const t0 = Date.now();
const r = await rebuildFromGit({ ...${JSON.stringify(opts)}, log });
return { ...r, ms: Date.now() - t0 };`,
  );
}

Deno.test({
  name:
    "git rebuild under an inherited GIT_DIR (a hook): records the CLONE's commit, builds without it",
  async fn() {
    const dir = await tempDir("aio-git-own-repo-");
    try {
      const want = await repo(join(dir, "src"), app);
      const other = await repo(join(dir, "hook"), { "x": "other" });
      assert(want !== other);
      const r = await rebuildUnder(
        { GIT_DIR: join(dir, "hook", ".git") },
        { source: join(dir, "src"), ref: "main", workDir: join(dir, "work") },
      );
      assert(r.ok, r.error);
      assertEquals(r.sha, want, "recorded the hook repo's commit");
      assertEquals(
        (r.contract as unknown as { gitDir: string }).gitDir,
        "",
        "the build inherited the hook's GIT_DIR",
      );
    } finally {
      await dropTempDir(dir);
    }
  },
});

Deno.test({
  name: "git rebuild under an inherited GIT_WORK_TREE still clones",
  async fn() {
    const dir = await tempDir("aio-git-own-tree-");
    try {
      const want = await repo(join(dir, "src"), app);
      await Deno.mkdir(join(dir, "elsewhere"));
      const r = await rebuildUnder(
        { GIT_WORK_TREE: join(dir, "elsewhere") },
        { source: join(dir, "src"), ref: "main", workDir: join(dir, "work") },
      );
      assert(r.ok, r.error);
      assertEquals(r.sha, want);
    } finally {
      await dropTempDir(dir);
    }
  },
});

Deno.test({
  name:
    "git over ssh under an inherited GIT_DIR: another repo's core.sshCommand does not switch off BatchMode",
  async fn() {
    const dir = await tempDir("aio-git-own-ssh-");
    try {
      await repo(join(dir, "hook"), { "x": "other" });
      await git(
        ["config", "core.sshCommand", "ssh -o User=hook"],
        join(dir, "hook"),
      );
      const argv = join(dir, "argv");
      const bin = join(dir, "bin");
      await Deno.mkdir(bin);
      await writeProgram(
        join(bin, "ssh" + EXE),
        `#!/bin/sh\necho "$@" >> "${argv}"\nexit 255\n`,
      );
      const r = await inChildEnv<{ ok: boolean; error?: string }>(
        {
          ...gitRunsFrom(bin),
          GIT_DIR: join(dir, "hook", ".git"),
          GIT_SSH_COMMAND: undefined,
          GIT_SSH: undefined,
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
        },
        `import { gitLsRemote } from ${JSON.stringify(CHECK)};`,
        `return await gitLsRemote("ssh://nobody@127.0.0.1/r.git", "main", 60_000);`,
      );
      assert(!r.ok);
      // The fake ssh exits at once; a deadline is only a backstop (a never-run
      // exe's first start on a loaded Windows can stall seconds). A timeout is
      // reported as itself, not as the missing argv file it leaves behind.
      assert(!/did not answer within/.test(r.error ?? ""), r.error);
      const call = (await Deno.readTextFile(argv)).trim();
      assertMatch(call, /-o BatchMode=yes/);
      assert(!/User=hook/.test(call), call);
    } finally {
      await dropTempDir(dir);
    }
  },
});

Deno.test({
  name:
    "git rebuild: a clone slower than the deadline but still MOVING completes",
  async fn() {
    const dir = await tempDir("aio-git-slow-clone-");
    try {
      // ~400 KB of incompressible objects, fed to git 16 KB every 200 ms
      // (~80 KB/s): ~5.5 s of transfer against a 2.5 s deadline. git reports
      // progress only as whole sideband packets (<= 64 KiB) arrive, so a
      // moving clone is silent for ~64 KiB / throughput between bursts —
      // ~0.8 s here. At 4 KB/100 ms that gap was ~1.6 s, above a 1.5 s
      // deadline, and the test passed or failed on scheduling luck.
      const files: Record<string, Uint8Array> = {};
      for (let i = 0; i < 134; i++) {
        files[`f${i}`] = crypto.getRandomValues(new Uint8Array(3000));
      }
      const want = await repo(join(dir, "src"), { ...app, ...files });
      // The slow transport: `git upload-pack`, its output passed on one
      // piece at a time. (The runtime, not `sh`+`dd`+`sleep`: Windows has
      // none of the three.)
      const trickle = join(dir, "trickle.js");
      await Deno.writeTextFile(
        trickle,
        `const up = new Deno.Command("git", {
  args: ["upload-pack", Deno.args[0]],
  stdin: "inherit",
  stdout: "piped",
  stderr: "inherit",
}).spawn();
for await (const chunk of up.stdout) {
  for (let at = 0; at < chunk.length; at += 16384) {
    const piece = chunk.subarray(at, at + 16384);
    for (let n = 0; n < piece.length;) {
      n += await Deno.stdout.write(piece.subarray(n));
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}
Deno.exit((await up.status).code);
`,
      );
      const cfg = join(dir, "gitconfig");
      await Deno.writeTextFile(cfg, `[protocol "ext"]\n\tallow = always\n`);
      const r = await rebuildUnder(
        { GIT_CONFIG_GLOBAL: cfg, GIT_CONFIG_NOSYSTEM: "1" },
        {
          source: `ext::${
            [
              Deno.execPath(),
              "run",
              "-A",
              "--no-config",
              trickle,
              join(dir, "src"),
            ]
              .map((w) => w.replaceAll("%", "%%").replaceAll(" ", "% "))
              .join(" ")
          }`,
          ref: "main",
          workDir: join(dir, "work"),
          timeoutMs: 2500,
        },
      );
      assert(r.ok, r.error);
      assertEquals(r.sha, want);
      assert(
        r.ms > 2 * 2500,
        "the transfer was not slower than the deadline",
      );
    } finally {
      await dropTempDir(dir);
    }
  },
});
