// The dev watcher's sentinel does not outlive its process.
//
// `watch-<pid>.tmp` sits in the lock dir while a dev app watches its files.
// It was removed by the server's shutdown and by nothing else, so an app that
// ends with `Deno.exit()` (no shutdown), and one that is killed, left it
// there for good: 18 in the shared lock dir of a Mac after three suite runs,
// 232 on a Linux box after a week — six a run from `resolve-home.test.ts`
// alone, whose probe boots and exits. In a scoped dir one keeps the dir from
// ever pruning.
//
// Two rules now: the watcher removes its own at process exit, and a watcher
// making its sentinel first removes those whose process is gone.
import { assert, assertEquals } from "@std/assert";
import { fromFileUrl, join, toFileUrl } from "@std/path";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { getLogger, setLogger } from "../src/diagnostics/logger-api.ts";
import { createFileWatcher } from "../src/server/server-watcher.ts";
import {
  _lockDeps,
  lockDir,
  ownPidTag,
} from "../src/server/single-instance-lock.ts";

const REPO = fromFileUrl(new URL("..", import.meta.url));
const mod = (rel: string) => toFileUrl(join(REPO, rel)).href;

/** Boots a dev app (the watcher starts), having planted a sentinel named for
 *  a dead process and one for a live one; says what is in the lock dir while
 *  it runs, and ends WITHOUT a shutdown. */
const APP = `import { aio, cell } from "${mod("mod.ts")}";
import { lockDir, ownPidTag } from "${
  mod("src/server/single-instance-lock.ts")
}";
const tagOf = (pid: string) => ownPidTag().replace(/^\\d+/, pid);
const dir = lockDir();
for (const pid of [Deno.env.get("DEAD_PID")!, String(Deno.ppid)]) {
  Deno.writeTextFileSync(dir + "/watch-" + tagOf(pid) + ".tmp", "");
}
const c = cell("c", { state: { n: 0 }, methods: {} });
await aio.run({ appId: "sentinel-exit", cells: [c], persist: false, client: "server-only", port: 0, singleton: false });
const names = () => [...Deno.readDirSync(dir)].map((e) => e.name).filter((n) => n.startsWith("watch-")).sort();
console.log("DIR " + JSON.stringify({ dir, running: names(), own: "watch-" + ownPidTag() + ".tmp", live: "watch-" + tagOf(String(Deno.ppid)) + ".tmp" }));
Deno.exit(0);
`;

Deno.test("watcher sentinel: gone when the app ends with Deno.exit(), and a dead watcher's is swept", async () => {
  const root = await tempDir("aio-sentinel-exit-");
  try {
    await Deno.mkdir(join(root, "src"));
    await Deno.mkdir(join(root, "run"));
    await Deno.writeTextFile(join(root, "src", "app.ts"), APP);
    await Deno.writeTextFile(
      join(root, "deno.json"),
      JSON.stringify({ title: "sentinel exit" }),
    );
    // A pid that is certainly dead: a child that has exited.
    const gone = new Deno.Command(Deno.execPath(), {
      args: ["eval", ""],
      stdout: "null",
      stderr: "null",
    }).spawn();
    const dead = gone.pid;
    await gone.status;
    const r = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        `--config=${join(REPO, "deno.json")}`,
        join(root, "src", "app.ts"),
      ],
      cwd: root,
      env: {
        // The SHARED lock dir of a runtime base of its own: never pruned, so
        // what the process leaves in it can be read after it is gone.
        AIO_APPS_DIR: "",
        XDG_RUNTIME_DIR: join(root, "run"),
        TEMP: join(root, "run"), // Windows' base for it
        TMP: join(root, "run"),
        HOME: root,
        DEAD_PID: String(dead),
      },
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output();
    const out = new TextDecoder().decode(r.stdout) +
      new TextDecoder().decode(r.stderr);
    assertEquals(r.code, 0, out);
    const line = out.split("\n").find((l) => l.startsWith("DIR "));
    assert(line, out);
    const said = JSON.parse(line.slice(4)) as {
      dir: string;
      running: string[];
      own: string;
      live: string;
    };
    assertEquals(
      said.running,
      [said.own, said.live].sort(),
      "while it ran: its own sentinel and the live process's — the dead " +
        "one's was swept",
    );
    assertEquals(
      [...Deno.readDirSync(said.dir)].map((e) => e.name)
        .filter((n) => n.startsWith("watch-")),
      [said.live],
      "after Deno.exit(): its own is gone, the live process's is not its to take",
    );
  } finally {
    await dropTempDir(root);
  }
});

// The sentinel is created in the lock dir like a socket is: a dir pruned
// under the create (macOS: EINVAL) is made again and the create retried —
// and a sentinel that still cannot be made is SAID. It used to return false
// on any error, and live reload ran without its health check, without a word.
Deno.test({
  name:
    "watcher sentinel: a refused create is retried; one that stays refused is said once and the watcher still starts",
  sanitizeOps: false, // aio-ok: the fs watcher's own read
  sanitizeResources: false, // aio-ok: the fs watcher is closed by its server, after the test
  async fn() {
    const tmp = await tempDir("aio-sentinel-said-");
    const real = { ..._lockDeps };
    const prev = getLogger();
    const warns: string[] = [];
    setLogger(
      {
        ...(prev ?? {}),
        pub: (lvl: string, _cat: string, msg: string) => {
          if (lvl === "warn") warns.push(msg);
        },
      } as unknown as Parameters<typeof setLogger>[0],
    );
    const own = join(lockDir(), `watch-${ownPidTag()}.tmp`);
    const start = (refusals: number) => {
      let tries = 0;
      _lockDeps.darwin = () => true;
      _lockDeps.create = (path, how) => {
        if (path !== own || ++tries > refusals) return real.create(path, how);
        throw new TypeError(`Invalid argument (os error 22): open '${path}'`);
      };
      const w = createFileWatcher({
        absBaseDir: tmp,
        importMapObj: {},
        debug: () => {},
        broadcastWs: () => {},
      });
      const started = w.start();
      const made = exists(own);
      w.shutdown();
      return { started, made, tries };
    };
    try {
      await Deno.writeTextFile(join(tmp, "App.tsx"), "export default 1;\n");
      assertEquals(start(2), { started: true, made: true, tries: 3 });
      assertEquals(warns.filter((w) => w.includes("sentinel")), []);
      assert(!exists(own), "removed on stop");
      const stays = start(Infinity);
      assertEquals([stays.started, stays.made], [true, false]);
      assert(stays.tries > 3, "asked again until the wait was over");
      const said = warns.filter((w) => w.includes("sentinel"));
      assertEquals(said.length, 1, warns.join("\n"));
      const line = said[0]!;
      assert(line.includes(own) && line.includes("os error 22"), line);
    } finally {
      Object.assign(_lockDeps, real);
      setLogger(prev);
      await dropTempDir(tmp);
    }
  },
});

function exists(path: string): boolean {
  try {
    Deno.statSync(path);
    return true;
  } catch {
    return false;
  }
}
