// `am` and profiles, end to end on a real app: `am start --profile dev`
// forwards `--profile=dev` as ARGV and records it in launch.json; the instance
// lists as `pr@dev` with a `--profile=dev` stopWith; a bare `am stop` never
// stops it (it is not "the app" — adoptRunningHome skips profiles); and
// `am stop pr@dev` / `--app=pr@dev` / `--profile dev` all reach it.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

/** Last resort: SIGKILL whatever still runs a file under `dir` — a stop that
 *  missed an instance must not leave it running after its home is deleted. */
async function reapUnder(dir: string): Promise<void> {
  const o = await new Deno.Command("ps", {
    args: ["-axo", "pid=,args="],
    stdout: "piped",
    stderr: "null",
  }).output();
  for (const line of new TextDecoder().decode(o.stdout).split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(.*)$/);
    if (!m || !m[2]!.includes(`${dir}/`) || Number(m[1]) === Deno.pid) continue;
    try {
      Deno.kill(Number(m[1]), "SIGKILL");
    } catch { /* gone between ps and kill */ }
  }
}

Deno.test({
  name: "am --profile: start, list, bare stop spares it, pr@dev stops it",
  ignore: Deno.build.os === "windows",
  sanitizeOps: false, // aio-ok: the app am starts is stopped below, by am
  sanitizeResources: false, // aio-ok: same
  async fn() {
    const dir = await tempDir("am-prof-");
    const proj = join(dir, "proj");
    const apps = join(dir, "apps");
    const rt = join(dir, "rt");
    await Deno.mkdir(join(proj, "src"), { recursive: true });
    await Deno.mkdir(rt, { mode: 0o700 });
    const head = JSON.parse(await Deno.readTextFile(join(REPO, "deno.json")));
    const imports: Record<string, string> = {};
    for (
      const [k, v] of Object.entries(head.imports as Record<string, string>)
    ) {
      imports[k] = v.startsWith("./") ? `${REPO}/${v.slice(2)}` : v;
    }
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
await aio.run({ cells: [c], appId: "pr", persist: false, client: "server-only" });
`,
    );
    const env = { AIO_APPS_DIR: apps, XDG_RUNTIME_DIR: rt };
    const am = async (...a: string[]) => {
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
    const list = async () =>
      ((await am("instances", "--json")).json as {
        appId: string;
        profile: string | null;
        stopWith?: string;
        home: string;
      }[]) ?? [];
    try {
      const start = await am("start", "--profile", "dev", "--json");
      assertEquals(start.code, 0, start.out);
      let inst = (await list()).filter((i) => i.appId === "pr");
      assertEquals(inst.length, 1, JSON.stringify(inst));
      assertEquals(inst[0]!.profile, "dev");
      assertEquals(inst[0]!.home, join(apps, "pr-dev"));
      assertStringIncludes(inst[0]!.stopWith ?? "", "--profile=dev");
      // Recorded for `am restart`, as argv.
      const launch = JSON.parse(
        await Deno.readTextFile(join(apps, "pr-dev", "launch.json")),
      );
      assert(
        (launch.flags as string[]).includes("--profile=dev"),
        JSON.stringify(launch),
      );
      // Every spelling targets it.
      for (const a of [["--app=pr@dev"], ["--profile=dev"], ["pr@dev"]]) {
        const st = await am("status", ...a, "--json");
        assertEquals(st.code, 0, `am status ${a}: ${st.out}`);
      }
      // A bare stop is NOT the profile's: dev keeps running.
      await am("stop", "--json");
      inst = (await list()).filter((i) => i.appId === "pr");
      assertEquals(inst.length, 1, "a bare `am stop` stopped the dev profile");
      // `am stop pr@dev` does.
      const stop = await am("stop", "pr@dev", "--wait", "--json");
      assertEquals(stop.code, 0, stop.out);
      const deadline = Date.now() + 20_000;
      while (
        Date.now() < deadline &&
        (await list()).some((i) => i.appId === "pr")
      ) await new Promise((r) => setTimeout(r, 200));
      assertEquals((await list()).filter((i) => i.appId === "pr"), []);

      // `am start --home <dir>` — refused before 1.0.10 — now STARTS there,
      // and `--home` stops exactly it.
      const custom = join(dir, "custom-home");
      const s2 = await am("start", `--home=${custom}`, "--json");
      assertEquals(s2.code, 0, s2.out);
      inst = (await list()).filter((i) => i.appId === "pr");
      assertEquals(inst.map((i) => i.home), [custom]);
      assertStringIncludes(inst[0]!.stopWith ?? "", `--home=${custom}`);
      const st2 = await am("stop", `--home=${custom}`, "--wait", "--json");
      assertEquals(st2.code, 0, st2.out);
    } finally {
      await am("stop", `--home=${join(dir, "custom-home")}`, "--json")
        .catch(() => {});
      await am("stop", "pr@dev", "--json").catch(() => {});
      // The app's OWN home too: when the profile is lost (check:mutations
      // plants exactly that) the child boots bare, and a stop that names
      // only the profile left it running for good — eight of them, each
      // alive for hours, one per mutation run.
      await am("stop", "--wait", "--json").catch(() => {});
      await reapUnder(dir);
      await dropTempDir(dir);
    }
  },
});
