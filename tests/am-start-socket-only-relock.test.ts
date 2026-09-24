// `am start` on a SOCKET-ONLY app (Electron / UDS, cc §1).
//
// The child takes its lock early with the TCP port it MIGHT bind
// (`{port: N, status: "starting"}`) and rewrites it ~1 s later as
// `{port: 0, socketPath}` once it knows it serves only on the socket. `am`'s
// wait loop latched the FIRST port it read, then fetched
// `http://127.0.0.1:N/` — where nothing ever listened — until the deadline,
// and printed "not responding … listening but did not answer", exit 1, for an
// app that answered on its socket in 0.25 s. An agent reads exit 1 as failure.
//
// Driven through the real `am start` against a fake child that writes exactly
// that lock sequence (no aio boot, no network, isolated AIO_APPS_DIR).
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import { freePort } from "./e2e-app-harness.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { lockPath } from "../src/server/single-instance-lock.ts";

const REPO = dirname(dirname(fromFileUrl(import.meta.url)));
const dec = new TextDecoder();

/** The fake child: lock `{port, starting}` → (socket up) `{port: 0,
 *  socketPath}`. `alive: false` = it then exits without ever listening. */
function childSource(o: {
  lock: string;
  appId: string;
  home: string;
  port: number;
  sock: string;
  alive: boolean;
}): string {
  return `
const o = ${JSON.stringify(o)};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const base = { appId: o.appId, pid: Deno.pid, startedAt: Date.now(), home: o.home };
function write(d) {
  const tmp = o.lock + ".tmp-" + Deno.pid;
  Deno.writeTextFileSync(tmp, JSON.stringify({ ...base, ...d }));
  Deno.renameSync(tmp, o.lock);
}
await sleep(300);
write({ port: o.port, status: "starting" });
await sleep(1200);
if (!o.alive) {
  write({ port: 0, status: "started", socketPath: o.sock });
  await sleep(300);
  Deno.exit(3);
}
const l = Deno.listen({ transport: "unix", path: o.sock });
write({ port: 0, status: "started", socketPath: o.sock });
setTimeout(() => Deno.exit(0), 60_000); // never outlive a hung test
for await (const c of l) c.close();
`;
}

async function run(alive: boolean): Promise<{
  code: number;
  out: string;
  err: string;
  pids: number[];
}> {
  const dir = await tempDir("am-sock-relock-");
  // aio-ok: a socket path must stay short (108-byte limit); removed in finally
  const sockDir = await Deno.makeTempDir({ prefix: "aio-s-" });
  const apps = join(dir, "apps");
  const appId = `sockonly-${crypto.randomUUID().slice(0, 8)}`;
  const prev = Deno.env.get("AIO_APPS_DIR");
  let pids: number[] = [];
  try {
    await Deno.mkdir(apps, { recursive: true });
    Deno.env.set("AIO_APPS_DIR", apps);
    const lock = lockPath(appId);
    if (prev === undefined) Deno.env.delete("AIO_APPS_DIR");
    else Deno.env.set("AIO_APPS_DIR", prev);
    await Deno.mkdir(dirname(lock), { recursive: true, mode: 0o700 });
    await Deno.writeTextFile(join(dir, "deno.json"), "{}\n");
    await Deno.writeTextFile(
      join(dir, "main.ts"),
      childSource({
        lock,
        appId,
        home: join(apps, appId),
        port: freePort(), // declared in the lock, never bound
        sock: join(sockDir, "a.sock"),
        alive,
      }),
    );
    const r = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        join(REPO, "src", "am.ts"),
        "start",
        `--app=${appId}`,
        "--entry=main.ts",
        "--wait=6",
        "--json",
        "--client=server-only",
      ],
      cwd: dir,
      env: {
        ...Deno.env.toObject(),
        AIO_APPS_DIR: apps,
        AIO_AM_NO_DELEGATE: "1",
        AIO_NO_OPEN: "1",
        NO_COLOR: "1",
      },
      stdout: "piped",
      stderr: "piped",
    }).output();
    const out = dec.decode(r.stdout);
    const err = dec.decode(r.stderr);
    pids = [...(out + err).matchAll(/"pid":(\d+)/g)].map((m) => +m[1]!);
    return { code: r.code, out, err, pids };
  } finally {
    for (const pid of pids) {
      try {
        Deno.kill(pid, "SIGTERM");
      } catch { /* gone */ }
    }
    await new Promise((r) => setTimeout(r, 200));
    await Deno.remove(sockDir, { recursive: true }).catch(() => {});
    await dropTempDir(dir);
  }
}

Deno.test({
  name:
    "am start: a child that re-locks {port:N,starting} → {port:0,socketPath} is reported started, exit 0",
  ignore: Deno.build.os === "windows",
  async fn() {
    const r = await run(true);
    assertEquals(r.code, 0, `${r.out}\n${r.err}`);
    assertStringIncludes(r.out, `"status":"started"`);
    assert(!/not responding/.test(r.out + r.err), r.out + r.err);
  },
});

Deno.test({
  name:
    "am start: a socket-only child that dies before listening still fails, exit 1",
  ignore: Deno.build.os === "windows",
  async fn() {
    const r = await run(false);
    assertEquals(r.code, 1, `${r.out}\n${r.err}`);
    assert(!r.out.includes(`"status":"started"`), r.out);
  },
});
