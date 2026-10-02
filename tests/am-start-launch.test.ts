// `am start` holds the app's lock while it spawns the app, and the app takes
// it over. Which process may take it over is decided by a secret `am` files in
// the lock and hands the child in `HANDOFF_ENV` — never by pid or parent pid:
// on Windows the launcher (PowerShell `Start-Process`) is an intermediate
// process, and the child there refused to boot, "Already running: <app>
// (pid <am>, still starting)". Every child below is spawned THROUGH an
// intermediate process, so nothing here can pass by parentage.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { childSaid, doorAnswers } from "../src/am/am-cmd-process.ts";
import { runtimeSpelling } from "../src/server/aio-cli.ts";
import { childEnv, freePort, makeApp } from "./e2e-app-harness.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import {
  _handedOver,
  AppLock,
  HANDOFF_ENV,
  readLock,
} from "../src/server/single-instance-lock.ts";

const dec = new TextDecoder();

const LOCK_MOD =
  new URL("../src/server/single-instance-lock.ts", import.meta.url).href;

/** A would-be app, two processes below this one, taking `appId`'s lock. */
async function bootThroughIntermediate(
  appId: string,
  secret: string | undefined,
): Promise<{ ok: boolean; pid: number; owner: number; leaked: string }> {
  const child = `const { AppLock } = await import(${JSON.stringify(LOCK_MOD)});
const l = new AppLock(${JSON.stringify(appId)});
const r = await l.acquire(0);
// The secret does not travel on: not in this env, not in a child's.
const kid = await new Deno.Command(Deno.execPath(), {
  args: ["eval", "console.log(Deno.env.get(" + JSON.stringify(${
    JSON.stringify(HANDOFF_ENV)
  }) + ") ?? '')"],
  stdout: "piped" }).output();
const leaked = (Deno.env.get(${JSON.stringify(HANDOFF_ENV)}) ?? "") +
  new TextDecoder().decode(kid.stdout).trim();
console.log(JSON.stringify({ ok: r.ok, pid: Deno.pid,
  owner: r.ok ? Deno.pid : r.existing.pid, leaked }));
l.release();`;
  const middle = `const o = await new Deno.Command(Deno.execPath(), {
  args: ["eval", ${JSON.stringify(child)}], stderr: "null" }).output();
await Deno.stdout.write(o.stdout);`;
  const env: Record<string, string> = {};
  if (secret !== undefined) env[HANDOFF_ENV] = secret;
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["eval", middle],
    env,
    stderr: "null",
  }).output();
  // A child that inherits a secret from THIS process would prove nothing.
  assertEquals(Deno.env.get(HANDOFF_ENV), undefined);
  return JSON.parse(new TextDecoder().decode(out.stdout));
}

Deno.test("am start's lock: the child it was handed to takes it over — through an intermediate process", async () => {
  const appId = `handoff-${crypto.randomUUID().slice(0, 8)}`;
  const secret = crypto.randomUUID();
  const am = new AppLock(appId);
  try {
    assert((await am.acquire(0, false, { handoff: secret })).ok);
    assertEquals(readLock(appId)?.handoff, secret, "filed with the secret");
    const r = await bootThroughIntermediate(appId, secret);
    assertEquals(r.ok, true, "the handed child boots");
    assertEquals(r.owner, r.pid);
    assert(r.pid !== Deno.pid);
    assertEquals(r.leaked, "", "the secret left the environment");
  } finally {
    am.release();
  }
});

Deno.test("am start's lock: without the secret, or with another one, a live holder's lock is never taken", async () => {
  for (const secret of [undefined, "not-the-secret"]) {
    const appId = `handoff-${crypto.randomUUID().slice(0, 8)}`;
    const am = new AppLock(appId);
    try {
      assert((await am.acquire(0, false, { handoff: crypto.randomUUID() })).ok);
      const r = await bootThroughIntermediate(appId, secret);
      assertEquals(r.ok, false, `secret ${secret}`);
      assertEquals(r.owner, Deno.pid, "it names the live holder");
      assertEquals(readLock(appId)?.pid, Deno.pid, "the lock is untouched");
    } finally {
      am.release();
    }
  }
});

Deno.test("_handedOver: only an equal, non-empty secret", () => {
  assertEquals(_handedOver({ handoff: "s" }, "s"), true);
  assertEquals(_handedOver({ handoff: "s" }, "t"), false);
  assertEquals(_handedOver({ handoff: "s" }, undefined), false);
  assertEquals(_handedOver({}, undefined), false);
  assertEquals(_handedOver({ handoff: "" }, ""), false);
});

// ── a real `am start`, with a launcher as slow as PowerShell's ──────────────
//
// On POSIX `am start` launches through `sh`, which returns in milliseconds —
// long before the child gets to its lock, so the race never showed here. A
// `sh` first on PATH that takes 2 s to return is Windows' `Start-Process`:
// the child reaches the lock while `am` still holds it.

/** A real `am start` of a scaffolded app; the pids it
 *  printed are reaped by {@linkcode reap}. */
async function amStart(
  dir: string,
  apps: string,
  args: string[],
  env: Record<string, string> = {},
): Promise<{ code: number; said: string; pids: number[] }> {
  const r = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      join(dir, "dep", "aio", "src", "am.ts"),
      "start",
      "--json",
      `--port=${freePort()}`,
      ...args,
    ],
    cwd: dir,
    env: {
      ...Deno.env.toObject(),
      ...childEnv({ AIO_APPS_DIR: apps }),
      AIO_AM_NO_DELEGATE: "1",
      NO_COLOR: "1",
      ...env,
    },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const said = dec.decode(r.stdout) + dec.decode(r.stderr);
  const pids = [...said.matchAll(/"pid":(\d+)/g)].map((m) => +m[1]!);
  return { code: r.code, said, pids };
}

async function reap(pids: number[]): Promise<void> {
  for (const pid of pids) {
    try {
      Deno.kill(pid, "SIGTERM");
    } catch { /* aio-ok: already gone */ }
  }
  for (const pid of pids) {
    for (let i = 0; i < 50; i++) {
      try {
        Deno.kill(pid, "SIGCONT");
      } catch {
        /* aio-ok: gone — the wait is over */
        break;
      }
      await new Promise((res) => setTimeout(res, 100));
    }
  }
}

Deno.test({
  name:
    "am start through a launcher slower than the app's boot: the app takes am's lock over and starts",
  ignore: Deno.build.os === "windows", // the shim is a shell script
  async fn() {
    const dir = await makeApp("counter", "am-handoff-");
    const apps = await tempDir("am-handoff-apps-");
    const shims = await tempDir("am-handoff-shims-");
    let pids: number[] = [];
    try {
      const sh = join(shims, "sh");
      await Deno.writeTextFile(sh, `#!/bin/sh\n/bin/sh "$@"\nsleep 2\n`);
      await Deno.chmod(sh, 0o755);
      const r = await amStart(dir, apps, ["--client=server-only"], {
        PATH: `${shims}:${Deno.env.get("PATH") ?? ""}`,
      });
      pids = r.pids;
      assertEquals(r.code, 0, r.said);
      assert(!r.said.includes("Already running"), r.said);
      assertStringIncludes(r.said, `"status":"started"`);
    } finally {
      await reap(pids);
      await dropTempDir(shims);
      await dropTempDir(apps);
      await dropTempDir(dir);
    }
  },
});

// ── `--headless` on am's command line ──────────────────────────────────────

Deno.test("runtimeSpelling: the build words that pick a client, and nothing else", () => {
  assertEquals(runtimeSpelling("--headless"), "--client=server-only");
  assertEquals(runtimeSpelling("--service"), "--client=server-only");
  assertEquals(runtimeSpelling("--port=1"), null);
  assertEquals(runtimeSpelling("toString"), null);
});

Deno.test("am start --headless: started as --client=server-only — the app never sees the build word", async () => {
  const dir = await makeApp("counter", "am-headless-");
  const apps = await tempDir("am-headless-apps-");
  let pids: number[] = [];
  try {
    const r = await amStart(dir, apps, ["--headless"]);
    pids = r.pids;
    assertEquals(r.code, 0, r.said);
    assert(!r.said.includes("BUILD flag"), r.said);
    assertStringIncludes(r.said, `"status":"started"`);
  } finally {
    await reap(pids);
    await dropTempDir(apps);
    await dropTempDir(dir);
  }
});

// ── what a child that died left, and where ─────────────────────────────────

Deno.test("childSaid: the reason in `<log>.err` (Windows' stderr) is read and that file named — not 'wrote nothing' about the empty stdout log", async () => {
  const dir = await tempDir("am-child-said-");
  try {
    const log = join(dir, "stdout.log");
    await Deno.writeTextFile(log, "");
    await Deno.writeTextFile(
      `${log}.err`,
      "\x1b[31merror\x1b[0m: Already running: x (pid 7, still starting)\n",
    );
    const got = childSaid(log);
    assertEquals(got.files, [`${log}.err`]);
    assertEquals(got.text, "error: Already running: x (pid 7, still starting)");
    await Deno.writeTextFile(log, "booting\n");
    assertEquals(childSaid(log).files, [log, `${log}.err`]);
    assertEquals(childSaid(join(dir, "none.log")), { text: "", files: [] });
  } finally {
    await dropTempDir(dir);
  }
});

// A declared port can be taken by another app while ours still boots (a
// port picked free, then bound by someone else): its answer was "started".
Deno.test("doorAnswers: another app answering on the port is not ours starting", async () => {
  const ac = new AbortController();
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", signal: ac.signal, onListen() {} },
    (req) =>
      new URL(req.url).pathname === "/__aio/health"
        ? Response.json({ appId: "someone-else" })
        : new Response("page"),
  );
  try {
    const port = server.addr.port;
    assertEquals(await doorAnswers(port, "mine"), false);
    assertEquals(await doorAnswers(port, "someone-else"), true);
    assertEquals(await doorAnswers(port), true, "no name to check");
  } finally {
    ac.abort();
    await server.finished;
  }
});
