// `am restart`'s verdict is the truth about the app, not about its own child.
//
// Save a cell file and run `am restart` at once: the dev watcher inside the
// running app relaunches it in-process (dev-restart.ts) while `am restart`
// launches its own child. Two launches of ONE identity race for the lock; when
// the watcher's wins, am's child is refused and exits — and `am restart`
// reported "<app> did not start", exit 1, while `am status` showed the app
// running under a new pid. The app WAS up, under the identity restart asked
// for (same appId, same home, this checkout): that is a started app, and the
// verdict now names the instance that is actually serving.
//
// The race is timing (5/5 on four busy cores, 0/10 on two idle ones), so the
// test builds its OUTCOME deterministically: the entry, launched by the
// restart, plays the loser — it lets a second launch of the same app take the
// lock, waits until that one serves, then exits refused, exactly as the
// losing child does.
//
// And it stays ALIVE while the winner already serves — every real loser does,
// for as long as its own boot takes to reach the refusal. `am restart` read
// the winner's door on the reused port as its own child's and named the
// doomed child as the started app (2 runs in 6 on Windows). The loser here
// holds that window open until the `am restart` that launched it is gone
// (or, with the fix, for a bounded time): a verdict given inside it must
// not name it.
import { assert, assertEquals } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { reapUnder } from "./proc-helper.ts";
import { spec } from "./module-spec-helper.ts";
import { freePort } from "../src/testing/server-test.ts";
import { _ofLaunch } from "../src/am/am-cmd-process.ts";

const REPO = fromFileUrl(new URL("..", import.meta.url)).replace(/[\\/]$/, "");

// Both shapes: the app picks its port (am learns it from the lock alone), and
// the app DECLARES one — where am probes that port from the first tick, and
// the winner answering there was read as the child's own door.
for (const declared of [false, true]) {
  Deno.test({
    name:
      `am restart: a racing relaunch that won the lock is reported, not 'did not start'${
        declared ? " (declared port)" : ""
      }`,
    sanitizeOps: false, // aio-ok: the apps am starts are stopped below, by am
    sanitizeResources: false, // aio-ok: same
    async fn() {
      const dir = await tempDir("am-restart-race-");
      const proj = join(dir, "proj");
      const apps = join(dir, "apps");
      const rt = join(dir, "rt");
      const marker = join(dir, "lose-next-start");
      const amPid = join(dir, "restart-pid");
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
        `import { aio, cell } from "${spec(REPO)}/mod.ts";
import { isProcessAlive, readLock, removeLock } from "${
          spec(REPO)
        }/src/server/single-instance-lock.ts";
const marker = ${JSON.stringify(marker)};
let lose = false;
try { lose = !Deno.env.get("RACE_PEER") && Deno.statSync(marker).isFile; } catch { /* no marker */ }
if (lose) {
  Deno.removeSync(marker);
  const until = async (ok: () => boolean) => {
    for (let i = 0; i < 300 && !ok(); i++) await new Promise((r) => setTimeout(r, 50));
  };
  // am's placeholder names THIS pid; the racing relaunch took the lock first.
  await until(() => readLock("rr")?.pid === Deno.pid);
  removeLock("rr");
  const peer = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", import.meta.filename!, ...Deno.args],
    env: { RACE_PEER: "1" },
    stdin: "null", stdout: "null", stderr: "null",
    // Windows ends a child with the parent that started it otherwise.
    detached: Deno.build.os === "windows",
  }).spawn();
  peer.unref();
  await until(() => {
    const l = readLock("rr");
    return l?.pid === peer.pid && l.status === "started";
  });
  // The winner serves and this loser is still alive: am must not call it
  // the app. Held open while the restart that launched it is still deciding.
  const am = Number(Deno.readTextFileSync(${JSON.stringify(amPid)}));
  for (let i = 0; i < 80 && isProcessAlive(am); i++) await new Promise((r) => setTimeout(r, 50));
  console.error("error: already running: rr (pid " + peer.pid + ")");
  Deno.exit(1);
}
const c = cell("c", { state: { n: 1 }, methods: {} });
await aio.run({ cells: [c], appId: "rr", persist: false, client: "server-only" });
`,
      );
      const env: Record<string, string> = {
        AIO_APPS_DIR: apps,
        XDG_RUNTIME_DIR: rt,
        ...(declared ? { AIO_PORT: String(freePort()) } : {}),
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
        const out = new TextDecoder().decode(o.stdout);
        return { code: o.code, out, err: new TextDecoder().decode(o.stderr) };
      };
      try {
        const s = await am("start", "--json", "--wait=60");
        assertEquals(s.code, 0, s.out + s.err);
        const first = JSON.parse(s.out);
        await Deno.writeTextFile(marker, "");
        // Its pid, filed before the loser can ask for it (a boot away).
        const restart = new Deno.Command(Deno.execPath(), {
          args: [
            "run",
            "-A",
            "--config",
            join(REPO, "deno.json"),
            `${REPO}/src/am.ts`,
            "restart",
            "--json",
            "--wait=60",
          ],
          cwd: proj,
          env,
          stdin: "null",
          stdout: "piped",
          stderr: "piped",
        }).spawn();
        await Deno.writeTextFile(amPid, String(restart.pid));
        const ro = await restart.output();
        const r = {
          code: ro.code,
          out: new TextDecoder().decode(ro.stdout),
          err: new TextDecoder().decode(ro.stderr),
        };
        const st = await am("status", "--json");
        assertEquals(st.code, 0, st.out + st.err);
        const now = JSON.parse(st.out) as {
          pid: number;
          port: number;
          status: string;
        };
        assertEquals(now.status, "started");
        assert(now.pid !== first.pid, "the old instance is still the app");
        // The verdict: exit 0, ONE document, naming the instance that serves.
        assertEquals(r.code, 0, `restart said:\n${r.out}${r.err}`);
        const doc = JSON.parse(r.out) as {
          pid: number;
          port: number;
          status: string;
        };
        assertEquals(doc.status, "started", r.out);
        assertEquals(
          doc.pid,
          now.pid,
          "restart named a pid that is not the app",
        );
        assertEquals(
          doc.port,
          now.port,
          "restart named a port the app is not on",
        );
      } finally {
        await am("stop", "--wait", "--json").catch(() => {});
        await reapUnder(dir);
        await dropTempDir(dir);
      }
    },
  });
}

Deno.test("am start: the lock of ITS launch is the child's, or the app that child supervises", () => {
  assert(_ofLaunch({ pid: 7 }, 7));
  // A cell edit made the launched process (7) the dev supervisor of 9.
  assert(_ofLaunch({ pid: 9, supervisor: 7 }, 7));
  // Another launch — its own, or somebody else's supervised app.
  assert(!_ofLaunch({ pid: 9 }, 7));
  assert(!_ofLaunch({ pid: 9, supervisor: 8 }, 7));
  // A lock that predates the field: the pid alone, as before.
  assert(!_ofLaunch({ pid: 9, supervisor: undefined }, 7));
});
