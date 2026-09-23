// `am stop --all` under a stray parent deno.json stopped every project below.
//
// A `deno.json` in `~` makes `~` a project root. From `~/Downloads` (a plain
// folder, no app) `am stop --all` resolved "this project" to `~`, and since an
// instance counted as the project's when it was launched anywhere UNDER the
// root, it stopped `~/p1` and `~/p2` — two other projects, each with its own
// deno.json. Measured: `{"root":".../fh","stopped":[r2stopp1,r2stopp2]}`.
//
// An instance belongs to the NEAREST project above where it was launched.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  instancesInNestedProjects,
  instancesInProject,
} from "../src/am/am-cmd-process.ts";
import {
  isProcessAlive,
  type LockData,
  writeLock,
} from "../src/server/single-instance-lock.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const AM = new URL("../src/am.ts", import.meta.url).pathname;
const CONFIG = new URL("../deno.json", import.meta.url).pathname;

const lock = (appId: string, cwd: string, pid = Deno.pid): LockData => ({
  appId,
  pid,
  port: 1,
  startedAt: Date.now(),
  status: "started",
  cwd,
});

/** `home/{deno.json, p1/deno.json, p2/deno.json, Downloads/, dist/srv/}` */
async function layout(): Promise<{ base: string; home: string }> {
  const base = await tempDir("am-stopall-nested-");
  const home = join(base, "home");
  for (const d of ["p1", "p2", "Downloads", "dist/srv"]) {
    await Deno.mkdir(join(home, d), { recursive: true });
  }
  await Deno.writeTextFile(join(home, "deno.json"), "{}");
  await Deno.writeTextFile(join(home, "p1", "deno.json"), "{}");
  await Deno.writeTextFile(join(home, "p2", "deno.json"), "{}");
  await Deno.mkdir(join(base, "apps"));
  return { base, home };
}

async function withApps<T>(base: string, fn: () => T): Promise<T> {
  const prev = Deno.env.get("AIO_APPS_DIR");
  Deno.env.set("AIO_APPS_DIR", join(base, "apps"));
  try {
    return await fn();
  } finally {
    if (prev === undefined) Deno.env.delete("AIO_APPS_DIR");
    else Deno.env.set("AIO_APPS_DIR", prev);
  }
}

Deno.test("instancesInProject: a nested project's app is not the parent's", async () => {
  const { base, home } = await layout();
  try {
    await withApps(base, () => {
      writeLock(lock("nested-p1", join(home, "p1")));
      writeLock(lock("nested-p2", join(home, "p2")));
      // Launched from the parent's own dist/ — no deno.json of its own.
      writeLock(lock("parent-srv", join(home, "dist", "srv")));
      assertEquals(
        instancesInProject(home, undefined).map((i) => i.appId),
        ["parent-srv"],
      );
      assertEquals(
        instancesInNestedProjects(home).map((i) => i.appId),
        ["nested-p1", "nested-p2"],
      );
      assertEquals(
        instancesInProject(join(home, "p1"), undefined).map((i) => i.appId),
        ["nested-p1"],
      );
    });
  } finally {
    await dropTempDir(base);
  }
});

Deno.test("am stop --all from a plain folder under a stray deno.json stops no other project", async () => {
  const { base, home } = await layout();
  const victims = ["p1", "p2"].map(() =>
    new Deno.Command("sleep", { args: ["60"], stdout: "null", stderr: "null" })
      .spawn()
  );
  try {
    await withApps(base, () => {
      writeLock(lock("victim-p1", join(home, "p1"), victims[0]!.pid));
      writeLock(lock("victim-p2", join(home, "p2"), victims[1]!.pid));
    });
    const out = await new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", "--config", CONFIG, AM, "stop", "--all", "--json"],
      cwd: join(home, "Downloads"),
      env: {
        ...Deno.env.toObject(),
        AIO_APPS_DIR: join(base, "apps"),
        AIO_AM_NO_DELEGATE: "1",
        NO_COLOR: "1",
      },
      stdout: "piped",
      stderr: "piped",
    }).output();
    const d = new TextDecoder();
    const text = d.decode(out.stdout) + d.decode(out.stderr);
    assertEquals(out.code, 1, `expected a refusal, got: ${text}`);
    assertStringIncludes(text, "other projects");
    assertStringIncludes(text, "victim-p1");
    assertStringIncludes(text, "--app=");
    for (const v of victims) {
      assert(
        isProcessAlive(v.pid),
        `stop --all stopped another project: ${text}`,
      );
    }
  } finally {
    for (const v of victims) {
      try {
        v.kill("SIGKILL");
      } catch { /* gone — the failing case */ }
      await v.status;
    }
    await dropTempDir(base);
  }
});
