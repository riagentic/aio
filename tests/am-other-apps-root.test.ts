// Two `AIO_APPS_DIR` roots whose lock folder has ONE name: `am` under one
// does not act on the other's app.
//
// The lock folder is named after the last 48 ASCII letters and digits of the
// root (a contract between builds, tests/lock-dir-scope-of-a-root.test.ts), so
// two roots that differ only in what that drops share it. The start that
// loses was told so; `am` was not: under root A it read `<appId>.lock` — root
// B's app — as its own, and `am stop` there stopped it, `am dispatch` wrote
// into it. Now every verb that acts refuses, with the start refusal's
// sentence, and `am instances` lists the app marked, with the command that
// does stop it.
//
// Never on missing data: a record with no `home` (written before alpha66),
// an `am` with no AIO_APPS_DIR, and an app whose folder is fixed elsewhere
// (`appDir`, `--home`) are as before.
import "./store-sandbox.ts";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join, resolve } from "@std/path";
import {
  _lockDirParts,
  otherAppsRootOf,
} from "../src/server/single-instance-lock.ts";
import { sameLockFolderNote } from "../src/server/aio-run-helpers.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { ownHome } from "./deno-dir-helper.ts";
import { spec } from "./module-spec-helper.ts";

const REPO = join(import.meta.dirname!, "..");
const CONFIG = join(REPO, "deno.json");
const AM = join(REPO, "src/am.ts");
const MOD = new URL("../mod.ts", import.meta.url).href;
const APP = "twinroot";

Deno.test("other apps root: only a root with THIS lock folder's name, read from a recorded home — never a guess", () => {
  const [mine, other] = [resolve("/srv/rootü1"), resolve("/srv/rooté1")];
  assertEquals(_lockDirParts(mine).scope, _lockDirParts(other).scope);
  assertEquals(otherAppsRootOf({ home: join(other, "todo") }, mine), other);
  // A profile's home sits beside the app's: the same root.
  assertEquals(otherAppsRootOf({ home: join(other, "todo-dev") }, mine), other);
  // This root's own apps.
  assertEquals(otherAppsRootOf({ home: join(mine, "todo") }, mine), null);
  assertEquals(otherAppsRootOf({ home: join(mine, "todo-dev") }, mine), null);
  // A folder fixed elsewhere (`appDir`, `--home`): this scope's app.
  assertEquals(otherAppsRootOf({ home: resolve("/opt/todo") }, mine), null);
  assertEquals(
    otherAppsRootOf({ home: join(mine, "group", "todo") }, mine),
    null,
  );
  // Missing data: a record with no home, an `am` with no AIO_APPS_DIR.
  assertEquals(otherAppsRootOf({}, mine), null);
  assertEquals(otherAppsRootOf({ home: join(other, "todo") }, undefined), null);
  assertEquals(otherAppsRootOf({ home: join(other, "todo") }, ""), null);
});

Deno.test("other apps root: one directory under two spellings is one root", async () => {
  const dir = await tempDir("aio-other-root-link-");
  try {
    // Two names for one directory that the scope cannot tell apart.
    const real = join(dir, "apps_1"), link = join(dir, "apps-1");
    await Deno.mkdir(real);
    try {
      await Deno.symlink(real, link, { type: "dir" });
    } catch {
      return; // aio-ok: no symlink right here (Windows without Developer Mode) — the case cannot be built
    }
    assertEquals(_lockDirParts(real).scope, _lockDirParts(link).scope);
    assertEquals(otherAppsRootOf({ home: join(link, "todo") }, real), null);
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("other apps root: am under one root lists the other root's app marked, and refuses to stop, kill, restart or write to it — its own root does all of it", async () => {
  const dir = await tempDir("aio-other-root-");
  const rootA = join(dir, "apps_1"), rootB = join(dir, "apps-1");
  assertEquals(_lockDirParts(rootA).scope, _lockDirParts(rootB).scope);
  const port = freePort();
  const base = {
    ...Deno.env.toObject(),
    ...await ownHome(dir),
    NO_COLOR: "1",
    // A lock dir of this test's own (posix; Windows scopes by the root).
    XDG_RUNTIME_DIR: join(dir, "run"),
  };
  await Deno.mkdir(join(dir, "run"), { mode: 0o700 });
  await Deno.writeTextFile(
    join(dir, "app.ts"),
    `import { aio, cell } from "${spec(MOD)}";
const c = cell("c", { state: { n: 0 }, methods: { inc(s) { s.n++; } } });
await aio.run({ cells: [c], appId: "${APP}", client: "server-only", port: ${port}, watch: false, baseDir: ${
      JSON.stringify(join(dir, "src-none"))
    } });
`,
  );
  const app = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "--config", CONFIG, join(dir, "app.ts")],
    env: { ...base, AIO_APPS_DIR: rootB },
    cwd: dir,
    stdout: "null",
    stderr: "null",
  }).spawn();
  const am = async (root: string, ...args: string[]) => {
    const o = await new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", "--config", CONFIG, AM, ...args],
      env: { ...base, AIO_APPS_DIR: root },
      cwd: dir,
      stdout: "piped",
      stderr: "piped",
    }).output();
    return {
      code: o.code,
      out: new TextDecoder().decode(o.stdout),
      err: new TextDecoder().decode(o.stderr),
      all: new TextDecoder().decode(o.stdout) +
        new TextDecoder().decode(o.stderr),
    };
  };
  const n = async (): Promise<number | null> => {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/__aio/trojan/state`);
      return r.ok ? (await r.json()).c.n : (await r.body?.cancel(), null);
    } catch {
      return null; // aio-ok: not up (yet, or any more) — the caller polls
    }
  };
  try {
    for (let i = 0; i < 600 && await n() === null; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assertEquals(await n(), 0, "the app under root B never came up");
    const note = sameLockFolderNote(rootB, rootA).split(" — ")[0]!;

    // Listed, marked, with the command that DOES stop it.
    const list = await am(rootA, "instances", "--json");
    const row = JSON.parse(list.out).find((i: { appId: string }) =>
      i.appId === APP
    );
    assertEquals(row.otherAppsDir, rootB, list.all);
    assertStringIncludes(row.stopWith, rootB);
    // The table (a terminal's rendering — a pipe is JSON) marks the row.
    assertStringIncludes(
      await Deno.readTextFile(join(REPO, "src/am/am-cmd-status.ts")),
      '(otherAppsRootOf(inst) ? " (other apps dir)" : "")',
    );

    // Every verb that acts is refused, by the start refusal's sentence.
    for (
      const args of [
        ["stop", `--app=${APP}`],
        ["kill", `--app=${APP}`],
        ["restart", `--app=${APP}`],
        ["dispatch", `--app=${APP}`, "c:inc"],
      ]
    ) {
      const r = await am(rootA, ...args);
      assert(r.code !== 0, `${args[0]} exited 0: ${r.all}`);
      // The answer is JSON on a pipe: a Windows path's `\\` is escaped in it.
      const inJson = (t: string) => JSON.stringify(t).slice(1, -1);
      assertStringIncludes(r.all, inJson(note), args[0]);
      assertStringIncludes(r.all, inJson(`AIO_APPS_DIR=${rootB}`), args[0]);
      assertEquals(await n(), 0, `${args[0]} reached the app: ${r.all}`);
    }

    // A verb that only reads still answers (1.0.19 did) — and says whose
    // answer it is: on stderr, once, never in the JSON on stdout.
    const said = `runs under ANOTHER apps dir, ${rootB} — not under this ` +
      `one (${rootA})`;
    for (const verb of ["status", "state", "logs", "surface", "timeline"]) {
      const there = await am(rootA, verb, `--app=${APP}`, "--json");
      assertEquals(
        there.err.split(said).length - 1,
        1,
        `${verb}: ${there.all}`,
      );
      assert(!there.out.includes("ANOTHER apps dir"), `${verb}: ${there.out}`);
      const here = await am(rootB, verb, `--app=${APP}`, "--json");
      assert(!here.all.includes("ANOTHER apps dir"), `${verb}: ${here.all}`);
      // The same answer as under its own root, by the same exit code.
      assertEquals(there.code, here.code, `${verb}: ${there.all}`);
      if (verb === "state") {
        assertEquals(JSON.parse(there.out), JSON.parse(here.out));
      }
      if (verb === "status") {
        assertEquals(JSON.parse(there.out).otherAppsDir, rootB);
        assertEquals(JSON.parse(here.out).otherAppsDir, undefined);
        assertEquals(JSON.parse(there.out).status, "started");
      }
    }

    // `am kill --stale` asks every recorded port who answers: the other
    // root's app is accounted for by its lock — not killed, its lock kept.
    const stale = await am(
      rootA,
      "kill",
      "--stale",
      `--port=${port}`,
      "--json",
    );
    assertEquals(stale.code, 0, stale.all);
    assertEquals(JSON.parse(stale.out).killed, [], stale.all);
    assertEquals(await n(), 0, `kill --stale reached the app: ${stale.all}`);
    assertEquals(
      JSON.parse((await am(rootB, "instances", "--json")).out)[0]?.appId,
      APP,
      "kill --stale under root A removed root B's lock",
    );

    // Under its own root: written to, and stopped.
    const inc = await am(rootB, "dispatch", `--app=${APP}`, "c:inc");
    assertEquals(inc.code, 0, inc.all);
    assertEquals(await n(), 1);
    const mine = JSON.parse((await am(rootB, "instances", "--json")).out)[0];
    assertEquals(mine.otherAppsDir, undefined);
    const stop = await am(rootB, "stop", `--app=${APP}`);
    assertEquals(stop.code, 0, stop.all);
    assertEquals((await app.status).success, true);
  } finally {
    try {
      app.kill("SIGKILL");
    } catch { /* aio-ok: already ended — the stop above did it */ }
    await app.status;
    await dropTempDir(dir);
  }
});
