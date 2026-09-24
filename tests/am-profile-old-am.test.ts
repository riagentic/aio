// What a 1.0.9 `am` — from BEFORE profiles — does with a profile's lock, so
// the upgrade guides say exactly that and nothing kinder. Pinned against the
// actual v1.0.9-beta `liveLock`, read out of the repository's own history
// (skipped where that tag is absent), fed the lock THIS runtime writes.
//
// 1.0.9 matches lock files by the appId before the LAST `@` and validates only
// appId / pid / port — the same matcher 1.0.10 and 1.0.11 still use, so no
// naming or field change can hide a profile from 1.0.9 without hiding it from
// the released 1.0.10 `am` too. The answer is "upgrade am first", and these
// three cases are why (measured — the 1.0.10 guide used to say 1.0.9
// "refuses bare verbs", which only the third case does):
//   - default instance AND `myapp@dev` running → 1.0.9 targets the DEFAULT
//     instance (its own lock is read first) — the right one;
//   - ONLY `myapp@dev` running → 1.0.9 takes the profile AS the app:
//     `am stop myapp` stops the dev profile, `am state` reads its data;
//   - two profiles and no default → refused ("running from 2 data homes").
import { assert, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const CONFIG = join(REPO, "deno.json");
const LOCK_MOD = new URL(
  "../src/server/single-instance-lock.ts",
  import.meta.url,
).href;
const TAG = "v1.0.9-beta";

const tagged = (() => {
  try {
    return new Deno.Command("git", {
      args: ["-C", REPO, "rev-parse", "--verify", "--quiet", `${TAG}^{commit}`],
      stdout: "null",
      stderr: "null",
    }).outputSync().success;
  } catch {
    return false;
  }
})();

/** The v1.0.9 tree's src/ + config, as it shipped, extracted into `dir`. */
async function extractOld(dir: string): Promise<void> {
  const tar = await new Deno.Command("git", {
    args: ["-C", REPO, "archive", "--format=tar", TAG, "src", "deno.json"],
    stdout: "piped",
  }).output();
  assert(tar.success, `git archive ${TAG} failed`);
  const x = new Deno.Command("tar", {
    args: ["-x", "-C", dir],
    stdin: "piped",
  }).spawn();
  const w = x.stdin.getWriter();
  await w.write(tar.stdout);
  await w.close();
  assert((await x.status).success, "tar -x failed");
}

async function deno(
  args: string[],
  env: Record<string, string>,
  cwd: string,
): Promise<string> {
  const o = await new Deno.Command(Deno.execPath(), {
    args,
    env,
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const d = new TextDecoder();
  return d.decode(o.stdout) + d.decode(o.stderr);
}

/** Run the 1.0.9 `liveLock("myapp")` against the locks THIS runtime writes
 *  for `homes` (a live `sleep` as every owner). */
async function oldLiveLock(
  homes: ("default" | "dev" | "qa")[],
): Promise<string> {
  const base = await tempDir("old-am-");
  const sleeper = new Deno.Command("sleep", { args: ["60"] }).spawn();
  try {
    const old = join(base, "old");
    await Deno.mkdir(old);
    await extractOld(old);
    const apps = join(base, "apps");
    await Deno.mkdir(apps);
    const env = {
      AIO_APPS_DIR: apps,
      XDG_RUNTIME_DIR: join(base, "run"),
      AIO_AM_NO_DELEGATE: "1",
    };
    await Deno.mkdir(env.XDG_RUNTIME_DIR, { mode: 0o700 });
    // The CURRENT writer: key, file name and fields are this runtime's own.
    const writer = join(base, "write.ts");
    const locks = homes.map((h, i) => ({
      appId: "myapp",
      pid: sleeper.pid,
      port: 4321 + i,
      startedAt: Date.now(),
      status: "started",
      home: join(apps, h === "default" ? "myapp" : `myapp-${h}`),
      ...(h === "default" ? {} : { profile: h }),
    }));
    await Deno.writeTextFile(
      writer,
      `import { lockKey, writeLock } from ${JSON.stringify(LOCK_MOD)};\n` +
        `for (const l of ${JSON.stringify(locks)}) { writeLock(l); ` +
        `console.log("WROTE " + lockKey(l.appId, l.home, l.profile)); }\n`,
    );
    const wrote = await deno(
      ["run", "-A", "--config", CONFIG, writer],
      env,
      base,
    );
    if (homes.includes("dev")) assertStringIncludes(wrote, "WROTE myapp@dev");
    const probe = join(old, "probe.ts");
    await Deno.writeTextFile(
      probe,
      `import { liveLock } from "./src/am/am-utils.ts";\n` +
        `try { const l = liveLock("myapp");\n` +
        `  console.log(l ? "TAKES " + l.home : "NONE"); }\n` +
        `catch (e) { console.log("REFUSED " + (e as Error).message); }\n`,
    );
    return await deno(
      ["run", "-A", "--config", join(old, "deno.json"), probe],
      env,
      old,
    );
  } finally {
    sleeper.kill();
    await sleeper.status;
    await dropTempDir(base);
  }
}

Deno.test({
  name: "a v1.0.9 am, default + profile running: targets the DEFAULT instance",
  ignore: !tagged,
  async fn() {
    const out = await oldLiveLock(["default", "dev"]);
    assert(/TAKES \S*\/apps\/myapp\s*$/m.test(out), out);
  },
});

Deno.test({
  name: "a v1.0.9 am, ONLY a profile running: takes the profile as the app",
  ignore: !tagged,
  async fn() {
    const out = await oldLiveLock(["dev"]);
    assert(/TAKES \S*myapp-dev\s*$/m.test(out), out);
  },
});

Deno.test({
  name: "a v1.0.9 am, two profiles and no default: bare verbs refused",
  ignore: !tagged,
  async fn() {
    const out = await oldLiveLock(["dev", "qa"]);
    assertStringIncludes(out, "REFUSED");
    assertStringIncludes(out, "running from 2 data homes");
  },
});
