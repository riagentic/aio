// amui: a project found through a SYMLINKED scan root (AMUI_ROOTS, or a
// symlinked ~/aio-apps) was started fine — but amui said it "failed to start",
// and listed the project twice (an idle entry with a Start button AND a
// running one). The lock records the child's Deno.cwd(), the PHYSICAL path;
// amui compared it with the scanned (symlink) path by string. Every directory
// amui compares is now its physical spelling (scan.server.ts `canonDir`).
//
// The "app" is a stand-in that registers its lock exactly as an aio app does
// (cwd: Deno.cwd()) and stays up.
import { assert } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { testCell } from "../src/testing/cell-test.ts";
import { manager } from "../amui/src/manager.ts";
import {
  instances,
  lockKey,
  removeLock,
} from "../src/server/single-instance-lock.ts";
import { _resetInstanceVerify } from "../src/am/am-http.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const APP = "amui-symroot-fixture";
const REPO = fromFileUrl(new URL("../", import.meta.url));
const LOCK_MOD = `${REPO}src/server/single-instance-lock.ts`;

/** The repo's import map with its local entries made absolute — what lets the
 *  stand-in app import the lock module from a project outside the repo. */
async function repoImports(): Promise<Record<string, string>> {
  const repo = JSON.parse(await Deno.readTextFile(`${REPO}deno.json`));
  return Object.fromEntries(
    Object.entries(repo.imports as Record<string, string>).map(([k, v]) => [
      k,
      v.startsWith("./") ? `${REPO}${v.slice(2)}` : v,
    ]),
  );
}

/** The Deno cache this process uses — kept for the child when HOME moves, so
 *  it does not re-download its modules into the sandbox. */
async function denoDir(): Promise<string> {
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["info", "--json"],
    stdout: "piped",
    stderr: "null",
  }).output();
  return JSON.parse(new TextDecoder().decode(out.stdout)).denoDir;
}

testCell(
  manager,
  "amui: start of a project under a symlinked scan root reports success and lists it once",
  async (t) => {
    const sandbox = await tempDir("amui-symroot-");
    const real = `${sandbox}/real`;
    const proj = `${real}/proj`;
    const link = `${sandbox}/link`;
    await Deno.mkdir(`${proj}/src`, { recursive: true });
    await Deno.mkdir(`${sandbox}/home`);
    await Deno.symlink(real, link);
    await Deno.writeTextFile(
      `${proj}/deno.json`,
      JSON.stringify({
        title: "symproj",
        lock: false,
        entry: "src/app.ts",
        imports: await repoImports(),
      }),
    );
    await Deno.writeTextFile(
      `${proj}/src/app.ts`,
      `import { writeLock } from ${JSON.stringify(LOCK_MOD)};
writeLock({ appId: "${APP}", pid: Deno.pid, port: 0, startedAt: Date.now(),
  status: "started", cwd: Deno.cwd(), home: "${sandbox}/apphome" });
setInterval(() => {}, 1000);
`,
    );
    const keys = ["AMUI_ROOTS", "HOME", "DENO_DIR"] as const;
    const prev = keys.map((k) => Deno.env.get(k));
    Deno.env.set("DENO_DIR", await denoDir());
    Deno.env.set("AMUI_ROOTS", link);
    Deno.env.set("HOME", `${sandbox}/home`);
    _resetInstanceVerify();
    try {
      await t.send.discover();
      const idle = t.getState().projects.find((p) => p.name === "symproj");
      assert(idle, "fixture not discovered through the symlinked root");
      await t.send.start(idle.id);
      const s = t.getState();
      const up = instances(APP).filter((i) => i.alive);
      assert(up.length === 1, `the app did not come up: ${s.actionMsg}`);
      const rows = s.projects.filter((p) => p.name.startsWith("symproj"));
      const report = JSON.stringify({
        actionMsg: s.actionMsg,
        rows: rows.map((r) => [r.path, r.running ? "running" : "stopped"]),
      });
      assert(
        s.actionMsg === "started proj" && rows.length === 1 &&
          rows[0]!.running !== null,
        `expected "started proj" and one running row; got ${report}`,
      );
    } finally {
      for (const i of instances(APP)) {
        try {
          Deno.kill(i.pid, "SIGKILL");
        } catch { /* gone */ }
        removeLock(lockKey(APP, i.home, i.profile));
      }
      keys.forEach((k, i) => {
        const v = prev[i];
        if (v === undefined) Deno.env.delete(k);
        else Deno.env.set(k, v);
      });
      _resetInstanceVerify();
      await dropTempDir(sandbox);
    }
  },
);
