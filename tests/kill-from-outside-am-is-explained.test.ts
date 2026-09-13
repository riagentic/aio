// "All my apps died at once" must have an answer in the log.
//
// Every aio app runs as `deno run … <entry>.ts`, so an agent that ends one by
// matching the process table — `pkill -f app.ts` — ends every aio app on the
// machine: the ones it started, the ones it did not, and the human's own
// long-running work. It is the most hostile thing an agent does on this
// framework, and the app cannot refuse the signal.
//
// What it CAN do is leave the answer where the person will look: one line, on
// SIGTERM, naming the command that would have ended this app alone.
//
// SIGINT is deliberately silent, and that split is the claim worth pinning. A
// human pressing Ctrl-C on an app they are watching knows exactly what they
// did; telling them again is noise, and noise is how a real warning stops
// being read. So this tests both sides on a real process — the line appears
// for the signal that arrives from somewhere else, and does not for the one
// that arrives from the keyboard.
//
// Observe-only in dev and prod alike: the shutdown that follows is byte-for-
// byte the one that happened before this line existed.
import { assert } from "@std/assert";
import { join } from "@std/path";
import { readLock } from "../src/server/single-instance-lock.ts";
import { childEnv, freePort } from "./e2e-app-harness.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

// One identity per test. The singleton lock is on the appId, so two tests
// sharing one could never both boot — and the second would fail for a reason
// that has nothing to do with what it is testing.
const appId = (tag: string) => `killexplain-${tag}-${Deno.pid}`;

const appSource = (port: number, id: string) =>
  `import { aio, cell } from "aio";
const probe = cell("probe", { state: { n: 0 }, methods: { inc(s) { s.n++; } } });
await aio.run({
  appId: ${JSON.stringify(id)},
  cells: [probe],
  client: "server-only",
  persist: false,
  port: ${port},
});
`;

async function bootApp(APP_ID: string): Promise<
  { proc: Deno.ChildProcess; err: () => string; dir: string; port: number }
> {
  const dir = await tempDir("aio-killexplain-");
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
  await Deno.writeTextFile(join(dir, "app.ts"), appSource(port, APP_ID));
  const proc = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", join(dir, "app.ts")],
    cwd: dir,
    env: childEnv(),
    // BOTH streams. The framework logger is free to pick either, and a test
    // that watches only one reports "it never said anything" for a line that
    // was said on the other — which is a test lying about the product.
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  let buf = "";
  const drain = async (r: ReadableStream<Uint8Array>) => {
    for await (const c of r) buf += new TextDecoder().decode(c);
  };
  drain(proc.stdout).catch(() => {});
  drain(proc.stderr).catch(() => {});
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const l = readLock(APP_ID);
    if (l && l.pid === proc.pid && l.status === "started") break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const up = readLock(APP_ID);
  assert(up && up.status === "started", `app never started:\n${buf}`);
  return { proc, err: () => buf, dir, port };
}

Deno.test({
  name: "a SIGTERM nobody asked for names the command that stops one app",
  ignore: Deno.build.os === "windows",
  async fn() {
    const APP_ID = appId("sig");
    const { proc, err, dir } = await bootApp(APP_ID);
    try {
      proc.kill("SIGTERM");
      await proc.status;
      await new Promise((r) => setTimeout(r, 150));
      const out = err();
      assert(
        out.includes("SIGTERM"),
        `no explanation for a SIGTERM:\n${out}`,
      );
      assert(
        out.includes(`am stop --app=${APP_ID}`),
        `the line must name the command that stops THIS app alone:\n${out}`,
      );
      assert(
        out.includes("pkill"),
        `the line must name what the sender probably did:\n${out}`,
      );
    } finally {
      try {
        proc.kill("SIGKILL");
      } catch { /* already gone */ }
      await dropTempDir(dir);
    }
  },
});

Deno.test({
  name: "Ctrl-C says nothing — the person already knows what they pressed",
  ignore: Deno.build.os === "windows",
  async fn() {
    const { proc, err, dir } = await bootApp(appId("sigint"));
    try {
      proc.kill("SIGINT");
      await proc.status;
      await new Promise((r) => setTimeout(r, 150));
      const out = err();
      assert(
        !out.includes("stops this app alone"),
        `SIGINT was lectured at — that is the noise this must not add:\n${out}`,
      );
    } finally {
      try {
        proc.kill("SIGKILL");
      } catch { /* already gone */ }
      await dropTempDir(dir);
    }
  },
});
