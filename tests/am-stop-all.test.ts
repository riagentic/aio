// `am stop --all` — and, more importantly, what it must NOT stop.
//
// The lock directory is machine-wide: every aio app a developer has running is
// in it, from every project. So the dangerous version of this feature is the
// obvious one — stop everything in `instances()` — and it is dangerous in a way
// that does not show up when you try it in a repo with one app. Somebody tidies
// up in project A, project B's server goes down, and nothing in either place
// says why.
//
// These tests are mostly about the boundary, therefore: what counts as "this
// project", and what sits just outside it.

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  instancesInProject,
  isUnder,
  projectRoot,
} from "../src/am/am-cmd-process.ts";
import {
  type LockData,
  writeLock,
} from "../src/server/single-instance-lock.ts";

async function withAppsDir<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const prev = Deno.env.get("AIO_APPS_DIR");
  const root = await Deno.makeTempDir({ prefix: "aio-stop-all-" });
  Deno.env.set("AIO_APPS_DIR", root);
  try {
    return await fn(root);
  } finally {
    if (prev === undefined) Deno.env.delete("AIO_APPS_DIR");
    else Deno.env.set("AIO_APPS_DIR", prev);
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
}

/** A lock for an app that is genuinely alive — this process, so the liveness
 *  check in `instances()` passes without spawning anything. */
const lock = (appId: string, cwd: string, port: number): LockData => ({
  appId,
  pid: Deno.pid,
  port,
  startedAt: Date.now(),
  status: "started",
  cwd,
});

// ── what counts as "inside this project" ──────────────────────────────────

Deno.test("isUnder: a sibling with a shared prefix is NOT inside", () => {
  // The string-prefix bug, which would have `rimote-old` inside `rimote`.
  assertEquals(isUnder("/home/u/rimote", "/home/u/rimote-old"), false);
  assertEquals(isUnder("/home/u/rimote", "/home/u/rimote"), true);
  assertEquals(isUnder("/home/u/rimote", "/home/u/rimote/dist/server"), true);
  assertEquals(isUnder("/home/u/rimote", "/home/u"), false);
});

Deno.test("projectRoot: walks UP to the deno.json", async () => {
  const root = await Deno.makeTempDir({ prefix: "aio-proj-" });
  try {
    await Deno.writeTextFile(join(root, "deno.json"), "{}");
    const deep = join(root, "dist", "myapp");
    await Deno.mkdir(deep, { recursive: true });

    // This is the case that matters: a compiled app is launched from inside
    // its own dist/, and its lock records THAT directory.
    assertEquals(projectRoot(deep), await Deno.realPath(root));
    assertEquals(projectRoot(root), await Deno.realPath(root));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("projectRoot: no deno.json anywhere is the cwd itself", async () => {
  const dir = await Deno.makeTempDir({ prefix: "aio-noproj-" });
  try {
    // Not a throw and not "/" — either would make `--all` either useless or
    // catastrophic.
    assertEquals(projectRoot(dir), dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ── the scope `--all` actually acts on ────────────────────────────────────

Deno.test("stop --all: another project's app is never in scope", async () => {
  await withAppsDir(async () => {
    const mine = await Deno.makeTempDir({ prefix: "aio-mine-" });
    const theirs = await Deno.makeTempDir({ prefix: "aio-theirs-" });
    try {
      await Deno.writeTextFile(join(mine, "deno.json"), "{}");
      await Deno.writeTextFile(join(theirs, "deno.json"), "{}");
      const dist = join(mine, "dist", "server");
      await Deno.mkdir(dist, { recursive: true });

      writeLock(lock("my-control", mine, 8012));
      writeLock(lock("my-server", dist, 8000)); // launched from dist/
      writeLock(lock("someone-elses-app", theirs, 8090));

      const scoped = instancesInProject(mine).map((i) => i.appId);
      assertEquals(scoped, ["my-control", "my-server"]);
      assert(
        !scoped.includes("someone-elses-app"),
        "stopping a fleet must never reach into another project",
      );
    } finally {
      await Deno.remove(mine, { recursive: true });
      await Deno.remove(theirs, { recursive: true });
    }
  });
});

Deno.test("stop --all: an app launched from a subdirectory is in scope", async () => {
  await withAppsDir(async () => {
    const root = await Deno.makeTempDir({ prefix: "aio-sub-" });
    try {
      await Deno.writeTextFile(join(root, "deno.json"), "{}");
      const deep = join(root, "dist", "rimote-server");
      await Deno.mkdir(deep, { recursive: true });
      writeLock(lock("rimote-server", deep, 8000));

      // Resolved from the subdirectory, as if `am stop --all` were run there.
      assertEquals(
        instancesInProject(projectRoot(deep)).map((i) => i.appId),
        ["rimote-server"],
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });
});

Deno.test("stop --all: nothing running is an empty list, not an error", async () => {
  await withAppsDir(async () => {
    const root = await Deno.makeTempDir({ prefix: "aio-empty-" });
    try {
      assertEquals(instancesInProject(root), []);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });
});

Deno.test("stop --all: the list is ordered, so output is stable", async () => {
  await withAppsDir(async () => {
    const root = await Deno.makeTempDir({ prefix: "aio-order-" });
    try {
      await Deno.writeTextFile(join(root, "deno.json"), "{}");
      for (
        const [id, port] of [["zeta", 8003], ["alpha", 8001], [
          "mid",
          8002,
        ]] as const
      ) {
        writeLock(lock(id, root, port));
      }
      assertEquals(
        instancesInProject(root).map((i) => i.appId),
        ["alpha", "mid", "zeta"],
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });
});
