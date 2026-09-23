// A real boot adopts a legacy `./data.db` into `<data>/state.db`.
//
// The data-dir writes (heap stamp, legacy migration, meta.json) moved behind
// the singleton lock so a REFUSED boot writes nothing into data/. The
// migration then read the lock, found a LIVE owner — the booting process
// itself — and refused on every boot ("app is running … stop it and start
// again"); the boot went on to create a fresh state.db, after which the
// legacy data.db could never be adopted. The boot now tells the migration it
// holds the lock. Pinned end to end: `aio.run` in a directory holding a
// legacy data.db moves it, bytes intact, and says nothing about "running".
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import { childEnv, freePort, kill } from "./e2e-app-harness.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const APP_ID = `legacy-db-${Deno.pid}`;
const REPO = new URL("../", import.meta.url).pathname;

Deno.test({
  name: "boot: a legacy ./data.db is moved into data/state.db, data intact",
  ignore: Deno.build.os === "windows",
  async fn() {
    const dir = await tempDir("boot-legacy-db-");
    const apps = join(dir, "apps");
    const port = freePort();
    const cwd = join(dir, "app");
    await Deno.mkdir(cwd, { recursive: true });
    const legacy = new DatabaseSync(join(cwd, "data.db"));
    legacy.exec("CREATE TABLE legacy_marker (v TEXT)");
    legacy.exec("INSERT INTO legacy_marker VALUES ('KEEP ME')");
    legacy.close();
    await Deno.writeTextFile(
      join(cwd, "deno.json"),
      JSON.stringify({
        imports: {
          "aio": `${REPO}mod.ts`,
          "aio/": `${REPO}src/`,
          "immer": "npm:immer@10.2.0",
          "@std/path": "jsr:@std/path@1.1.2",
        },
      }),
    );
    await Deno.writeTextFile(
      join(cwd, "app.ts"),
      `import { aio, cell } from "aio";
const c = cell("c", { state: { n: 0 }, methods: { inc(s) { s.n++; } } });
await aio.run({ appId: ${JSON.stringify(APP_ID)}, cells: [c],
  client: "server-only", port: ${port} });
`,
    );
    const proc = new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", join(cwd, "app.ts")],
      cwd,
      env: childEnv({ AIO_APPS_DIR: apps }),
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    let log = "";
    const dec = new TextDecoder();
    const pump = (s: ReadableStream<Uint8Array>) =>
      (async () => {
        for await (const c of s) log += dec.decode(c);
      })().catch(() => {});
    const pumps = [pump(proc.stdout), pump(proc.stderr)];
    try {
      const home = join(apps, APP_ID);
      // Up = its port answers. (No `readLock` here: that would need this
      // process's AIO_APPS_DIR moved, and env is shared by parallel files.)
      const deadline = Date.now() + 30_000;
      let up = false;
      while (!up && Date.now() < deadline) {
        up = await fetch(`http://127.0.0.1:${port}/`, {
          signal: AbortSignal.timeout(1_000),
        }).then(async (r) => (await r.body?.cancel(), true), () => false);
        if (!up) await new Promise((r) => setTimeout(r, 100));
      }
      assert(up, `app never started:\n${log}`);
      proc.kill("SIGTERM");
      const st = await proc.status;
      await Promise.all(pumps);
      assertEquals(st.code, 0, log);
      assert(!log.includes("is running (pid"), `migration refused:\n${log}`);
      let legacyGone = false;
      try {
        Deno.lstatSync(join(cwd, "data.db"));
      } catch {
        legacyGone = true;
      }
      assert(legacyGone, `legacy data.db was not moved:\n${log}`);
      const db = new DatabaseSync(join(home, "data", "state.db"));
      try {
        const row = db.prepare("SELECT v FROM legacy_marker").get() as
          | { v: string }
          | undefined;
        assertEquals(row?.v, "KEEP ME");
      } finally {
        db.close();
      }
    } finally {
      await kill(proc);
      await dropTempDir(dir);
    }
  },
});
