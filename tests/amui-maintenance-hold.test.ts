// A registry entry held by `am backup` / `am restore` is not an app: port 0,
// nothing to shut down, and its pid IS the maintenance op. amui listed it as a
// running app and its Stop / Restart fell through to SIGTERM — killing the
// user's backup or restore mid-copy. `am stop` refuses exactly this; so must
// amui. Sandboxed: AIO_APPS_DIR scopes the lock registry to a temp dir, so no
// real running app is ever seen or touched.
import { assert, assertStringIncludes } from "@std/assert";
import { testCell } from "../src/testing/cell-test.ts";
import { manager } from "../amui/src/manager.ts";
import { removeLock, writeLock } from "../src/server/single-instance-lock.ts";
import { _resetInstanceVerify } from "../src/am/am-http.ts";
import { isProcessAlive } from "../src/server/single-instance-lock.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

async function withHold(
  fn: (dir: string, pid: number) => Promise<void>,
): Promise<void> {
  const sandbox = await tempDir("amui-hold-");
  const dir = `${sandbox}/proj`;
  await Deno.mkdir(dir);
  await Deno.writeTextFile(
    `${dir}/deno.json`,
    JSON.stringify({ name: "held", imports: { aio: "../mod.ts" } }),
  );
  const prev = {
    apps: Deno.env.get("AIO_APPS_DIR"),
    roots: Deno.env.get("AMUI_ROOTS"),
  };
  Deno.env.set("AIO_APPS_DIR", `${sandbox}/apps`);
  Deno.env.set("AMUI_ROOTS", dir);
  const op = new Deno.Command("sleep", {
    args: ["120"],
    stdin: "null",
    stdout: "null",
    stderr: "null",
  }).spawn();
  writeLock({
    appId: "amui-fixture-held",
    pid: op.pid,
    port: 0,
    startedAt: Date.now(),
    status: "starting",
    cwd: dir,
    maintenance: { op: "am backup", since: Date.now() },
  });
  _resetInstanceVerify();
  try {
    await fn(dir, op.pid);
  } finally {
    removeLock("amui-fixture-held");
    try {
      op.kill("SIGKILL");
    } catch { /* gone */ }
    await op.status;
    for (
      const [k, v] of [["AIO_APPS_DIR", prev.apps], ["AMUI_ROOTS", prev.roots]]
    ) {
      if (v === undefined) Deno.env.delete(k!);
      else Deno.env.set(k!, v);
    }
    _resetInstanceVerify();
    await dropTempDir(sandbox);
  }
}

testCell(
  manager,
  "amui stop refuses a maintenance hold instead of SIGTERMing am backup",
  async (t) => {
    await withHold(async (dir, pid) => {
      await t.send.discover();
      const p = t.getState().projects.find((x) => x.path === dir);
      assert(p?.running?.maintenance, "the hold is discovered as a hold");
      await t.send.stop(dir);
      assert(isProcessAlive(pid), "amui killed the running `am backup`");
      assertStringIncludes(t.getState().actionMsg ?? "", "am backup");
    });
  },
);

testCell(
  manager,
  "amui restart refuses a maintenance hold instead of SIGTERMing am backup",
  async (t) => {
    await withHold(async (dir, pid) => {
      await t.send.discover();
      await t.send.restart(dir);
      assert(isProcessAlive(pid), "amui killed the running `am backup`");
      assertStringIncludes(t.getState().actionMsg ?? "", "am backup");
    });
  },
);
