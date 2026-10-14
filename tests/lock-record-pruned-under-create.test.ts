// A lock record published into a dir that was pruned under its temp file.
//
// The record goes in as a temp file and a hard link. On macOS a create that
// races the rmdir of its dir SUCCEEDS, and what it made is in no directory
// (tests/lock-dir-held-after-bind.test.ts has the measurement). An app's
// start has nothing of its own in the scoped lock dir before that temp — no
// hold file where there are no pid namespaces — so a sibling's exit prune
// can take the dir right there: the link then found no temp, the fallback
// create no dir, and the start failed with "the lock DIRECTORY is unusable"
// because another app quit. The dir is looked at after the temp is made, as
// after every other create in it, and a pruned one is made again.
//
// In a child: the prune here removes the whole lock dir, which in this
// process is the one every other test's locks are in.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const REPO = join(import.meta.dirname!, "..");
const MOD = toFileUrl(join(REPO, "src/server/single-instance-lock.ts")).href;

const CHILD = `const m = await import(${JSON.stringify(MOD)});
const prunes = Number(Deno.env.get("PRUNES"));
const dir = m.lockDir();
const create = m._lockDeps.create;
let clock = 0, temps = 0;
m._lockDeps.darwin = () => true;
m._lockDeps.now = () => clock;
m._lockDeps.pause = (ms) => void (clock += ms);
m._lockDeps.create = (path, how) => {
  const f = create(path, how);
  // What macOS does: the create returns, and its file is in no dir.
  if (path.endsWith(".tmp") && temps++ < prunes) {
    Deno.removeSync(dir, { recursive: true });
  }
  return f;
};
const lock = new m.AppLock("pruned");
const out = { temps: 0, clock: 0 };
try {
  out.ok = (await lock.acquire(1)).ok;
  out.pid = m.readLock(lock.key)?.pid;
  out.left = [...Deno.readDirSync(dir)].map((e) => e.name)
    .filter((n) => n.endsWith(".tmp"));
} catch (e) {
  out.error = e.message;
}
out.temps = temps;
out.clock = clock;
out.self = Deno.pid;
lock.release();
console.log("RESULT " + JSON.stringify(out));
`;

async function start(prunes: number): Promise<Record<string, unknown>> {
  const dir = await tempDir("lock-rec-pruned-");
  try {
    const child = join(dir, "child.js");
    await Deno.writeTextFile(child, CHILD);
    const o = await new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", "--config", join(REPO, "deno.json"), child],
      env: { AIO_APPS_DIR: join(dir, "apps"), PRUNES: String(prunes) },
      stdout: "piped",
      stderr: "piped",
    }).output();
    const dec = new TextDecoder();
    const line = dec.decode(o.stdout).trim().split("\n").pop() ?? "";
    assert(
      o.success && line.startsWith("RESULT "),
      `the child failed: ${line}\n${dec.decode(o.stderr).slice(-1500)}`,
    );
    return JSON.parse(line.slice(7));
  } finally {
    await dropTempDir(dir);
  }
}

Deno.test({
  name:
    "lock record, macOS: a dir pruned under the record's temp file is made again — the start takes its lock",
  ignore: Deno.build.os === "windows", // the look after a create reads the dir's identity: Windows has none (`lockDirMoved`)
  async fn() {
    const r = await start(2);
    assertEquals(r.error, undefined);
    assertEquals(r.ok, true);
    assertEquals(r.temps, 3, "pruned under two temps, published by the third");
    assertEquals(
      r.pid,
      r.self,
      "the record at the lock's name is this start's",
    );
    assertEquals(r.left, [], "no temp is left beside it");
  },
});

Deno.test({
  name:
    "lock record, macOS: a dir gone after EVERY temp is refused at the bound, in the words of a replaced dir",
  ignore: Deno.build.os === "windows", // the look after a create reads the dir's identity: Windows has none (`lockDirMoved`)
  async fn() {
    const r = await start(1e9);
    assertEquals(r.ok, undefined);
    assertStringIncludes(String(r.error), "is no longer there");
    assertStringIncludes(String(r.error), "was replaced while");
    const clock = r.clock as number;
    assert(clock > 2_000 && clock < 2_100, `the mutex's wait: ${clock} ms`);
  },
});
