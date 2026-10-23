// `--instance` names, and the shared scope's answers about an app that runs
// in one.
//
//  1. `--instance=hx.1` and `--instance=hx_1` share ONE lock folder (its name
//     keeps only ASCII letters and digits — a contract between builds). The
//     second start was refused "already running" with the fix
//     `--instance=<name>` — the flag it had just passed — and `am instances`
//     listed the one app twice, once under a name it never ran in.
//  2. Outside any instance, `am status` / `am state` answered "not running —
//     start it" about an app running in an instance: an agent that forgot the
//     flag was told to start a second copy on other data.
//  3. `am start --app=<id this project does not have>` started the project's
//     app anyway, under a second lock named after the wrong id.
//  4. Inside an instance, "already running" suggested `--instance=<name>`
//     without saying it must be ANOTHER name.
import "./store-sandbox.ts";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { _lockDirParts } from "../src/server/single-instance-lock.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { ownHome } from "./deno-dir-helper.ts";
import { spec } from "./module-spec-helper.ts";

const REPO = join(import.meta.dirname!, "..");
const CONFIG = join(REPO, "deno.json");
const AM = join(REPO, "src/am.ts");
const MOD = new URL("../mod.ts", import.meta.url).href;
const APP = "hxscope";

async function setup(dir: string) {
  const env: Record<string, string> = {
    ...Deno.env.toObject(),
    ...await ownHome(dir),
    NO_COLOR: "1",
    AIO_AM_NO_DELEGATE: "1",
    XDG_RUNTIME_DIR: join(dir, "run"),
  };
  // The suite exports one for its own spawned apps: these run in none.
  delete env.AIO_APPS_DIR;
  await Deno.mkdir(join(dir, "run"), { mode: 0o700 });
  const am = async (cwd: string, ...args: string[]) => {
    const o = await new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", "--config", CONFIG, AM, ...args],
      env,
      clearEnv: true,
      cwd,
      stdout: "piped",
      stderr: "piped",
      signal: AbortSignal.timeout(60_000),
    }).output();
    const d = new TextDecoder();
    return {
      code: o.code,
      out: d.decode(o.stdout),
      all: d.decode(o.stdout) + d.decode(o.stderr),
    };
  };
  return { env, am, home: env.HOME! };
}

Deno.test({
  name:
    "am --instance: two names on one lock folder are named, listed once; the shared scope points at the instance",
  fn: async () => {
    const dir = await tempDir("aio-instance-scope-");
    const { env, am, home } = await setup(dir);
    const inst = (n: string) => join(home, ".aio-instances", n);
    assertEquals(
      _lockDirParts(inst("hx.1")).scope,
      _lockDirParts(inst("hx_1")).scope,
    );
    // Another name on the same lock folder, made by an earlier use of it.
    await Deno.mkdir(inst("hx-1"), { recursive: true });
    const port = freePort();
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
      env: { ...env, AIO_APPS_DIR: inst("hx.1") },
      clearEnv: true,
      cwd: dir,
      stdout: "null",
      stderr: "null",
    }).spawn();
    const up = async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/__aio/trojan/state`);
        await r.body?.cancel();
        return r.ok;
      } catch {
        return false; // aio-ok: not up yet — the caller polls
      }
    };
    try {
      for (let i = 0; i < 600 && !await up(); i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      assert(await up(), "the app in --instance=hx.1 never came up");

      // 1. Listed ONCE, under the name it runs in.
      const list = await am(dir, "instances", "--json");
      const rows = (JSON.parse(list.out) as {
        appId: string;
        instance: string;
        stopWith: string;
      }[]).filter((r) => r.appId === APP);
      assertEquals(rows.length, 1, list.all);
      assertEquals(rows[0]!.instance, "hx.1", list.all);
      assertEquals(rows[0]!.stopWith, `am stop --app=${APP} --instance=hx.1`);

      // 1. The colliding name's start: names the holder and why.
      const twin = await am(
        dir,
        "start",
        "--instance=hx_1",
        `--app=${APP}`,
        "--client=server-only",
        "--json",
      );
      assertEquals(twin.code, 1, twin.all);
      const doc = JSON.parse(twin.out) as { error: string; fix: string };
      assertStringIncludes(doc.error, "--instance=hx.1");
      assertStringIncludes(doc.error, "maps to the same lock folder name");
      assertStringIncludes(doc.fix, `differ from "hx.1"`);
      assertStringIncludes(doc.fix, `am stop --app=${APP} --instance=hx.1`);
      assert(!doc.fix.includes("--instance=<name>"), doc.fix);
      assert(await up(), "the refused start touched the running app");

      // 4. The same name: ANOTHER name is the private copy.
      const same = await am(
        dir,
        "start",
        "--instance=hx.1",
        `--app=${APP}`,
        "--client=server-only",
        "--json",
      );
      assertEquals(same.code, 1, same.all);
      assertStringIncludes(
        JSON.parse(same.out).fix,
        "--instance=<a name other than hx.1>",
      );

      // 2. The shared scope: not "start it" — where it runs, with the flag.
      const st = await am(dir, "status", `--app=${APP}`, "--json");
      assertEquals(st.code, 1, st.all);
      assertEquals(JSON.parse(st.out).instances, ["hx.1"], st.all);
      assertStringIncludes(JSON.parse(st.out).hint, "add --instance=hx.1");
      const state = await am(dir, "state", `--app=${APP}`, "--json");
      assertEquals(state.code, 1, state.all);
      assertStringIncludes(JSON.parse(state.out).error, "add --instance=hx.1");
      assert(!state.all.includes("start it"), state.all);

      const stop = await am(dir, "stop", "--instance=hx.1", `--app=${APP}`);
      assertEquals(stop.code, 0, stop.all);
      assertEquals((await app.status).success, true);
    } finally {
      try {
        app.kill("SIGKILL");
      } catch { /* aio-ok: already ended — the stop above did it */ }
      await app.status;
      await dropTempDir(dir);
    }
  },
});

Deno.test({
  name:
    "am start --app=<an id this project does not have> is refused before anything starts, naming the real id",
  fn: async () => {
    const dir = await tempDir("aio-start-wrong-app-");
    const { am } = await setup(dir);
    const proj = join(dir, "proj");
    try {
      await Deno.mkdir(join(proj, "src"), { recursive: true });
      await Deno.writeTextFile(
        join(proj, "deno.json"),
        JSON.stringify({ appId: "realid" }),
      );
      // Exits at once: no server, and never a window, whatever runs it.
      await Deno.writeTextFile(join(proj, "src", "app.ts"), "Deno.exit(0);\n");
      const r = await am(
        proj,
        "start",
        "--instance=wrongapp",
        "--app=nope",
        "--client=server-only",
        "--json",
      );
      assertEquals(r.code, 1, r.all);
      const err = JSON.parse(r.out).error as string;
      assertStringIncludes(err, "--app=nope names no app of this project");
      assertStringIncludes(err, "realid");
      // Nothing was started, so nothing was recorded for either id.
      const logs = join(dir, "home", ".aio-instances", "wrongapp");
      for (const id of ["nope", "realid"]) {
        let there = true;
        try {
          await Deno.stat(join(logs, id));
        } catch {
          there = false;
        }
        assert(!there, `a start ran: ${join(logs, id)} exists — ${r.all}`);
      }
      // Its own id passes this check (and is then started as before).
      const own = await am(
        proj,
        "start",
        "--instance=wrongapp",
        "--app=realid",
        "--client=server-only",
        "--wait=5",
        "--json",
      );
      assert(!own.all.includes("names no app"), own.all);
    } finally {
      await am(proj, "stop", "--instance=wrongapp", "--app=realid");
      await dropTempDir(dir);
    }
  },
});
