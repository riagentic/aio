// `am` never writes into a data folder before it knows the folder may be
// used, and it follows the home the CHILD resolved (an `appDir` app's profile
// is `<appDir>-dev`, not `~/.<app>-dev`):
//   · a foreign folder (`--home`) is refused and left byte-identical;
//   · another app's folder (`--profile dev` meeting a real `pa-dev`) is
//     refused and its launch.json / logs are untouched;
//   · `profiles: false`: the child refuses, and the target folder is empty;
//   · an appDir app: `am start` reports started (not "still starting"), and
//     `am start/restart --profile dev` land in `<appDir>-dev`, replay the flag,
//     leave no stray `~/.pc-dev` and no ghost lock; `am instances` sees it
//     right after the restart; bare `am status` names the profile;
//     `am logs pc@dev` reads its log.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

async function project(dir: string, appId: string, extra = "") {
  const proj = join(dir, `proj-${appId}`);
  await Deno.mkdir(join(proj, "src"), { recursive: true });
  const head = JSON.parse(await Deno.readTextFile(join(REPO, "deno.json")));
  const imports: Record<string, string> = {};
  for (
    const [k, v] of Object.entries(head.imports as Record<string, string>)
  ) imports[k] = v.startsWith("./") ? `${REPO}/${v.slice(2)}` : v;
  await Deno.writeTextFile(
    join(proj, "deno.json"),
    JSON.stringify({
      compilerOptions: head.compilerOptions,
      imports,
      nodeModulesDir: head.nodeModulesDir,
    }),
  );
  await Deno.writeTextFile(
    join(proj, "src", "app.ts"),
    `import { aio, cell } from "${REPO}/mod.ts";
const c = cell("c", { state: { n: 1 }, methods: {} });
console.log("hello-from-${appId}");
await aio.run({ cells: [c], appId: "${appId}", persist: false,
  client: "server-only" ${extra} });
`,
  );
  return proj;
}

function amIn(proj: string, env: Record<string, string>) {
  return async (...a: string[]) => {
    const o = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        "--config",
        join(REPO, "deno.json"),
        `${REPO}/src/am.ts`,
        ...a,
      ],
      cwd: proj,
      env,
      stdin: "null",
    }).output();
    const out = new TextDecoder().decode(o.stdout);
    let json: unknown = null;
    try {
      json = JSON.parse(out);
    } catch { /* not json */ }
    return {
      code: o.code,
      out: out + new TextDecoder().decode(o.stderr),
      json,
    };
  };
}

const tree = (d: string): string[] => {
  const out: string[] = [];
  const walk = (p: string, rel: string) => {
    for (const e of Deno.readDirSync(p)) {
      out.push(`${rel}${e.name}`);
      if (e.isDirectory) walk(join(p, e.name), `${rel}${e.name}/`);
    }
  };
  try {
    walk(d, "");
  } catch { /* absent */ }
  return out.sort();
};

Deno.test({
  name:
    "am: a refused home is never written; an appDir app's profile lands in <appDir>-dev",
  ignore: Deno.build.os === "windows",
  sanitizeOps: false, // aio-ok: the apps am starts are stopped below, by am
  sanitizeResources: false, // aio-ok: same
  async fn() {
    const dir = await tempDir("am-homes-");
    const apps = join(dir, "apps");
    const rt = join(dir, "rt");
    await Deno.mkdir(rt, { mode: 0o700 });
    await Deno.mkdir(apps);
    const env = { AIO_APPS_DIR: apps, XDG_RUNTIME_DIR: rt };
    const fixed = join(dir, "fixed");
    const pc = amIn(
      await project(dir, "pc", `, appDir: ${JSON.stringify(fixed)}`),
      env,
    );
    try {
      // ── refusals: nothing written ──
      const pa = amIn(await project(dir, "pa"), env);
      const foreign = join(dir, "foreign");
      await Deno.mkdir(foreign);
      await Deno.writeTextFile(join(foreign, "notes.txt"), "mine");
      const r1 = await pa("start", `--home=${foreign}`, "--json");
      assertEquals(r1.code, 1, r1.out);
      assertEquals(tree(foreign), ["notes.txt"], "the foreign folder changed");
      // `pa-dev` is a REAL app's folder.
      const other = join(apps, "pa-dev");
      await Deno.mkdir(join(other, "data"), { recursive: true });
      await Deno.mkdir(join(other, "logs"));
      await Deno.writeTextFile(
        join(other, "data", "meta.json"),
        JSON.stringify({ appId: "pa-dev", aio: "x" }),
      );
      await Deno.writeTextFile(join(other, "launch.json"), '{"flags":["x"]}');
      await Deno.writeTextFile(join(other, "logs", "stdout.log"), "live");
      const before = tree(other);
      const r2 = await pa("start", "--profile", "dev", "--json");
      assertEquals(r2.code, 1, r2.out);
      assertStringIncludes(r2.out, "belongs to app");
      assertEquals(tree(other), before);
      assertEquals(
        await Deno.readTextFile(join(other, "launch.json")),
        '{"flags":["x"]}',
      );
      assertEquals(
        await Deno.readTextFile(join(other, "logs", "stdout.log")),
        "live",
      );
      // profiles:false — the CHILD refuses; the target folder stays empty.
      const po = amIn(await project(dir, "po", ", profiles: false"), env);
      const r3 = await po("start", "--profile", "dev", "--json");
      assertEquals(r3.code, 1, r3.out);
      assertStringIncludes(r3.out, "profiles: false");
      assertEquals(tree(join(apps, "po-dev")), []);

      // ── an appDir app, plain: STARTED, and no ghost lock ──
      const s0 = await pc("start", "--json");
      assertEquals(s0.code, 0, s0.out);
      assertEquals((s0.json as { status?: string }).status, "started");
      const keys = () =>
        [...Deno.readDirSync(rt)].filter((e) => e.isDirectory)
          .flatMap((e) =>
            [...Deno.readDirSync(join(rt, e.name))]
              .map((f) => f.name).filter((n) => n.endsWith(".lock"))
          ).filter((n) => n.startsWith("pc")).sort();
      assertEquals(keys().length, 1, `ghost lock: ${keys()}`);
      assertEquals((await pc("stop", "--wait", "--json")).code, 0);

      // ── an appDir app's PROFILE ──
      const s1 = await pc("start", "--profile", "dev", "--json");
      assertEquals(s1.code, 0, s1.out);
      assertEquals(keys(), ["pc@dev.lock"], "a ghost placeholder was left");
      assert(
        tree(join(apps, "pc-dev")).length === 0,
        `a stray ~/.pc-dev: ${tree(join(apps, "pc-dev"))}`,
      );
      const launch = JSON.parse(
        await Deno.readTextFile(join(`${fixed}-dev`, "launch.json")),
      );
      assert((launch.flags as string[]).includes("--profile=dev"));
      assertStringIncludes(
        await Deno.readTextFile(join(`${fixed}-dev`, "logs", "stdout.log")),
        "hello-from-pc",
      );
      // Bare status: the app itself is stopped — and names its profile.
      const st = await pc("status", "--json");
      assertEquals((st.json as { status?: string }).status, "stopped");
      assertStringIncludes(st.out, "am stop --app=pc@dev");
      // `am logs pc@dev` — the positional form.
      const lg = await pc("logs", "pc@dev", "--lines=50");
      assertStringIncludes(lg.out, "hello-from-pc");
      // Restart: the flag replays, it comes back in <appDir>-dev, and the
      // very next `am instances` sees it.
      const rs = await pc("restart", "pc@dev", "--json");
      assertEquals(rs.code, 0, rs.out);
      const inst = (await pc("instances", "--json")).json as {
        appId: string;
        profile: string | null;
        home: string;
      }[];
      const mine = inst.filter((i) => i.appId === "pc");
      assertEquals(mine.map((i) => [i.profile, i.home]), [[
        "dev",
        `${fixed}-dev`,
      ]]);
      assertEquals(keys(), ["pc@dev.lock"]);
      // …and a bare stop still does not touch it.
      await pc("stop", "--json");
      assertEquals(
        ((await pc("instances", "--json")).json as { appId: string }[])
          .filter((i) => i.appId === "pc").length,
        1,
      );
    } finally {
      await pc("stop", "pc@dev", "--wait", "--json").catch(() => {});
      await pc("stop", "--wait", "--json").catch(() => {});
      await dropTempDir(dir);
    }
  },
});
