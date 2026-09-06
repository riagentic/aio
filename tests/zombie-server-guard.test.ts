// The listener dies BADLY, not cleanly — and the guard has to see that half.
//
// The zombie-server guard exists because event-loop starvation once killed the
// HTTP listener while the process kept spinning. It watched
// `httpServer.finished.then(onFulfilled)`, which only fires when the accept
// loop ends CLEANLY. Measured under `ulimit -n 128`: the accept loop threw
// "Too many open files", `finished` REJECTED, the guard never ran, and the
// rejection surfaced as an unhandled rejection. The process then sat there
// with cells running and nothing listening — `ss` showed no socket, every
// request failed, and no supervisor had a reason to restart it.
//
// A real process under a real descriptor limit, because that is the only way
// to make an accept loop fail the way production does.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const REPO = new URL("..", import.meta.url).pathname;
const MOD = new URL("../mod.ts", import.meta.url).href;

const APP = (dir: string) =>
  `import { aio, cell } from ${JSON.stringify(MOD)};
const box = cell("box", { state: { n: 0 }, methods: { bump(s: { n: number }) { s.n++; } } });
const app = await aio.run({
  cells: [box],
  appId: "zombie",
  client: "server-only",
  singleton: false,
  port: 0,
  appDir: ${JSON.stringify(dir)},
  baseDir: ${JSON.stringify(dir)},
});
console.log("READY " + app.port);
await new Promise(() => {});
`;

/** Boot the app, optionally under a descriptor ceiling; resolve on READY. */
async function boot(dir: string, fdLimit?: number) {
  const file = join(dir, "app.ts");
  await Deno.writeTextFile(file, APP(dir));
  const run = `deno run -A --config ${join(REPO, "deno.json")} ${file}`;
  const child = new Deno.Command("bash", {
    args: ["-c", fdLimit ? `ulimit -n ${fdLimit}; exec ${run}` : `exec ${run}`],
    env: { AIO_APPS_DIR: dir, NO_COLOR: "1" },
    stdout: "piped",
    stderr: "piped",
  }).spawn();

  // Read stdout until READY so the port is known before anything connects.
  const reader = child.stdout.getReader();
  const dec = new TextDecoder();
  let out = "";
  const deadline = Date.now() + 60_000;
  while (!/READY \d+/.test(out) && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    out += dec.decode(value);
  }
  reader.releaseLock();
  const port = Number(/READY (\d+)/.exec(out)?.[1]);
  return { child, port, out };
}

/** Open `n` sockets at once and keep whatever the server accepted. */
function flood(port: number, n: number): Promise<WebSocket[]> {
  const held: WebSocket[] = [];
  return Promise.all(
    Array.from({ length: n }, () =>
      new Promise<void>((res) => {
        const s = new WebSocket(`ws://127.0.0.1:${port}/ws`);
        s.onopen = () => {
          held.push(s);
          res();
        };
        s.onerror = () => res();
      })),
  ).then(() => held);
}

Deno.test({
  // `ulimit` is a POSIX shell builtin; Windows has no equivalent ceiling to
  // push the accept loop past, and the guard is not OS-specific.
  ignore: Deno.build.os === "windows",
  name:
    "server: an accept loop that dies of EMFILE exits the process, instead of leaving it alive with nothing listening",
  fn: async () => {
    const dir = await tempDir("aio-zombie-");
    try {
      const { child, port, out } = await boot(dir, 128);
      assert(
        port > 0,
        `the app must still boot under a 128-descriptor ceiling: ${out}`,
      );
      await flood(port, 300);
      // Bounded: without the guard the process does not exit at all — it sits
      // there with its cells alive and no socket. Waiting forever would turn
      // that into a hang instead of a verdict.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<null>((r) => {
        timer = setTimeout(() => r(null), 15_000);
      });
      const status = await Promise.race([child.status, timeout]);
      clearTimeout(timer);
      if (status === null) {
        child.kill("SIGKILL");
        await child.output();
        throw new Error(
          "the process is STILL RUNNING after its accept loop died — alive " +
            "with nothing listening is the zombie this guard exists to stop",
        );
      }
      const err = new TextDecoder().decode((await child.output()).stderr);
      assertEquals(
        status.code,
        1,
        `it must EXIT so a supervisor restarts it: ${err}`,
      );
      assert(
        /zombie-server guard/.test(err),
        `the exit must name itself: ${err}`,
      );
      assert(
        /os error 24|Too many open files/.test(err),
        `and it must carry the REASON, not an empty detail: ${err}`,
      );
    } finally {
      await dropTempDir(dir);
    }
  },
});

Deno.test({
  ignore: Deno.build.os === "windows",
  name: "server: a healthy listener never trips the guard",
  fn: async () => {
    const dir = await tempDir("aio-zombie-ok-");
    try {
      const { child, port } = await boot(dir);
      assert(port > 0, "the control app must boot");
      const held = await flood(port, 20);
      assertEquals(held.length, 20, "all 20 must connect on a healthy server");
      for (const s of held) s.close();
      child.kill("SIGKILL");
      const { stderr } = await child.output();
      const err = new TextDecoder().decode(stderr);
      assert(
        !/zombie-server guard/.test(err),
        `a live listener must never be called dead: ${err}`,
      );
    } finally {
      await dropTempDir(dir);
    }
  },
});
