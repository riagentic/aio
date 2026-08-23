// The singleton lock lives exactly as long as the process: it is released by
// shutdown's Phase 6, AFTER the final persist, and never at signal time.
//
// It used to go at signal time — measured, the file was gone 1 ms after
// SIGTERM while the app lived on for its whole shutdown (seconds, for a real
// app), listening, flushing, and unlocked. A launch in that window took the
// lock, opened the same state.db and overwrote the first app's final write.
//
// This pins both halves end to end on a real process: an app with an async
// `onStop` (awaited — the other half) is SIGTERMed; its lock must still be
// there, marked `stopping`, while the hook runs, and gone once it has exited.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { lockPath, readLock } from "../src/server/single-instance-lock.ts";
import { childEnv, freePort, kill } from "./e2e-app-harness.ts";

const APP_ID = `lock-lifetime-${Deno.pid}`;

const appSource = (port: number) =>
  `import { aio, cell } from "aio";
const probe = cell("probe", { state: { n: 0 }, methods: { inc(s) { s.n++; } } });
await aio.run({
  appId: ${JSON.stringify(APP_ID)},
  cells: [probe],
  client: "server-only",
  persist: false,
  port: ${port},
  onStop: async () => { await new Promise((r) => setTimeout(r, 1500)); },
});
`;

Deno.test({
  name:
    "lock lifetime: still held (status stopping) while onStop runs; gone at exit",
  ignore: Deno.build.os === "windows",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const dir = await Deno.makeTempDir({ prefix: "aio-lock-lifetime-" });
    const repo = new URL("../", import.meta.url).pathname;
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({
        imports: {
          "aio": `${repo}mod.ts`,
          "aio/": `${repo}src/`,
          "immer": "npm:immer@10.2.0",
          "@std/path": "jsr:@std/path@1.1.2",
        },
      }),
    );
    const port = freePort();
    await Deno.writeTextFile(join(dir, "app.ts"), appSource(port));
    const proc = new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", join(dir, "app.ts")],
      cwd: dir,
      env: childEnv(),
      stdout: "null",
      stderr: "piped",
    }).spawn();
    let err = "";
    (async () => {
      for await (const c of proc.stderr) err += new TextDecoder().decode(c);
    })().catch(() => {});
    try {
      // Up: the app's own lock says started.
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const l = readLock(APP_ID);
        if (l && l.pid === proc.pid && l.status === "started") break;
        await new Promise((r) => setTimeout(r, 100));
      }
      const up = readLock(APP_ID);
      assert(up && up.status === "started", `app never started:\n${err}`);

      // SIGTERM, then look while the 1.5 s onStop is running.
      const t0 = Date.now();
      proc.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 400));
      const mid = readLock(APP_ID);
      assert(
        mid !== null,
        `lock released at signal time — the app is still shutting down, unlocked ` +
          `(${lockPath(APP_ID)})`,
      );
      assertEquals(mid.pid, proc.pid);
      assertEquals(
        mid.status,
        "stopping",
        "the signal marks the lock stopping",
      );

      const status = await proc.status;
      const took = Date.now() - t0;
      assert(
        took >= 1400,
        `exited after ${took}ms — the async onStop was not awaited`,
      );
      assert(
        took < 12_000,
        `shutdown took ${took}ms — over the runtime's budget`,
      );
      assertEquals(status.code, 0, `clean exit expected:\n${err}`);
      assertEquals(readLock(APP_ID), null, "lock released at exit");
    } finally {
      await kill(proc);
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});
