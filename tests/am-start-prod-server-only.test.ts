// `am start --prod` of a `client: "server-only"` app reports the app it
// started — and a second `am start` refuses rather than killing it.
//
// am judged "answering" by `GET /` returning 2xx. A prod server with no
// browser bundle — every server-only app — answers `/` with an honest 503
// (the "headless build — no browser UI" page, server-static.ts), so the start
// reported "not responding on port N after 10s — pid P is listening but did
// not answer", exit 1, for an app that was up and serving. The same probe
// guards `am start`'s single-instance check, where "not answering" means
// "zombie — kill it". The app's door answers on `/__aio/health`, which every
// aio server serves in every mode; a refused page is not a dead server.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import {
  isProcessAlive,
  lockPath,
} from "../src/server/single-instance-lock.ts";

const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

Deno.test({
  name:
    "am start --prod: a server-only app (503 at /) is reported started, and a second start refuses instead of killing it",
  ignore: Deno.build.os === "windows",
  sanitizeOps: false, // aio-ok: the app am starts is stopped below, by am
  sanitizeResources: false, // aio-ok: same
  async fn() {
    const dir = await tempDir("am-prod-so-");
    const proj = join(dir, "proj");
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
await aio.run({ cells: [c], appId: "pso", persist: false, client: "server-only" });
`,
    );
    const env = {
      AIO_APPS_DIR: join(dir, "apps"),
      XDG_RUNTIME_DIR: rt,
      AIO_AM_NO_DELEGATE: "1",
    };
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
      return {
        code: o.code,
        out: new TextDecoder().decode(o.stdout),
        err: new TextDecoder().decode(o.stderr),
      };
    };
    let pid = 0;
    try {
      const s = await am("start", "--prod", "--json");
      try {
        pid = JSON.parse(s.out).pid ?? 0;
      } catch { /* the refusal document */ }
      assertEquals(s.code, 0, `am start --prod said:\n${s.out}${s.err}`);
      const doc = JSON.parse(s.out) as { status: string; port: number };
      assertEquals(doc.status, "started");
      // `/` really is the refused page — the premise, pinned.
      const root = await fetch(`http://127.0.0.1:${doc.port}/`);
      await root.body?.cancel();
      assertEquals(root.status, 503);
      // A second start is refused — the running app is NOT a zombie.
      const again = await am("start", "--prod", "--json");
      assertEquals(again.code, 1, again.out + again.err);
      assertStringIncludes(again.out, "already running");
      assert(isProcessAlive(pid), "the second start killed the running app");
      // `starting` (exit 2) is the documented "ask again" answer when the
      // door is slow to answer — under a loaded machine it can be, once.
      let st = await am("status", "--json");
      for (let i = 0; i < 5 && st.code === 2; i++) {
        st = await am("status", "--json");
      }
      assertEquals(JSON.parse(st.out).status, "started", st.out);
      // …and a lock left at `starting` past the boot grace (what the failed
      // verdict used to leave behind) is not a "stuck listener" to kill.
      const prev = [
        Deno.env.get("AIO_APPS_DIR"),
        Deno.env.get("XDG_RUNTIME_DIR"),
      ];
      Deno.env.set("AIO_APPS_DIR", env.AIO_APPS_DIR);
      Deno.env.set("XDG_RUNTIME_DIR", rt);
      try {
        const path = lockPath("pso");
        const l = JSON.parse(Deno.readTextFileSync(path));
        Deno.writeTextFileSync(
          path,
          JSON.stringify({ ...l, status: "starting", startedAt: 0 }),
        );
      } finally {
        if (prev[0] === undefined) Deno.env.delete("AIO_APPS_DIR");
        else Deno.env.set("AIO_APPS_DIR", prev[0]);
        if (prev[1] === undefined) Deno.env.delete("XDG_RUNTIME_DIR");
        else Deno.env.set("XDG_RUNTIME_DIR", prev[1]);
      }
      const stuck = await am("start", "--prod", "--json");
      assertEquals(stuck.code, 1, stuck.out + stuck.err);
      assertStringIncludes(stuck.out, "already running");
      assert(isProcessAlive(pid), "a start killed the running app as stuck");
    } finally {
      await am("stop", "--wait", "--json").catch(() => {});
      if (pid) {
        try {
          Deno.kill(pid, "SIGKILL");
        } catch { /* stopped */ }
      }
      await dropTempDir(dir);
    }
  },
});
