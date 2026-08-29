// An aio process leaves when it is done — and a REFUSED boot leaves too.
//
// Three background timers were started at boot and torn down only on the
// shutdown path: the logger's heartbeat, the vitals pressure sampler, and the
// crash-checkpoint debounce. A pending timer holds the event loop, so:
//
//   • a clean embedded app returned from `app.close()` in 53 ms and did not
//     unload until 5,054 ms — every `libraryMode` app, every time; and
//   • a boot that REFUSED (a corrupt `state.db`) printed its refusal and then
//     NEVER EXITED, because a refusal never reaches a shutdown. The caller
//     sees a correct error and a hang, which is the worst of both.
//
// Measured after: 49 ms and 103 ms. None of the three should ever have been a
// reason for a process to stay alive — they are a heartbeat, a sampler and a
// debounce, and each still fires for as long as the app is running.
// Found by the persistence audit round.
import { assert, assertStringIncludes } from "@std/assert";

const ROOT = new URL("..", import.meta.url).pathname;

/** Run `body` as its own process and return how long it took to EXIT. */
async function timeToExit(body: string): Promise<{ ms: number; out: string }> {
  const dir = await Deno.makeTempDir({ prefix: "aio-exit-" });
  const file = `${dir}/probe.ts`;
  await Deno.writeTextFile(
    file,
    `import { aio, cell } from "${ROOT}mod.ts";\n` +
      `const dir = ${JSON.stringify(dir)};\n` + body,
  );
  const t0 = performance.now();
  const out = await new Deno.Command(Deno.execPath(), {
    // The repo's own deno.json, so `@std/path` and friends resolve — the probe
    // lives in a temp dir and has no import map of its own.
    args: ["run", "-A", "--config", `${ROOT}deno.json`, file],
    stdout: "piped",
    stderr: "piped",
  }).output();
  const ms = performance.now() - t0;
  const text = new TextDecoder().decode(out.stdout) +
    new TextDecoder().decode(out.stderr);
  await Deno.remove(dir, { recursive: true }).catch(() => {});
  return { ms, out: text };
}

// Generous: this measures a whole `deno run`, on a machine that may be busy.
// The bug it guards was 5,000 ms and ∞ — an order of magnitude away from any
// plausible noise.
const CEILING_MS = 12_000;

Deno.test({
  name: "exit: a clean embedded boot+close does not linger",
  ignore: Deno.build.os === "windows",
  async fn() {
    const { ms, out } = await timeToExit(`
const c = cell("exitclean", { state: { n: 0 }, methods: { bump(s) { s.n++ } } });
const app = await aio.run({
  cells: [c], client: "server-only", singleton: false, libraryMode: true,
  baseDir: dir, appDir: dir, persist: false,
});
await app.close();
console.log("CLOSED");
`);
    assertStringIncludes(out, "CLOSED");
    assert(
      ms < CEILING_MS,
      `took ${ms.toFixed(0)}ms to exit after close — a background timer is ` +
        `holding the event loop:\n${out.slice(-600)}`,
    );
  },
});

Deno.test({
  name: "exit: a REFUSED boot leaves too",
  ignore: Deno.build.os === "windows",
  async fn() {
    const { ms, out } = await timeToExit(`
await Deno.mkdir(dir + "/data", { recursive: true });
await Deno.writeFile(dir + "/data/state.db", new Uint8Array(4096).fill(0x41));
const c = cell("exitrefused", { state: { n: 0 }, methods: {} });
try {
  const app = await aio.run({
    cells: [c], client: "server-only", singleton: false, libraryMode: true,
    baseDir: dir, appDir: dir,
  });
  await app.close();
  console.log("BOOTED");
} catch (e) {
  console.log("REFUSED:", String(e.message).slice(0, 60));
}
`);
    assertStringIncludes(
      out,
      "REFUSED",
      `a corrupt state.db must be refused, not booted around:\n${
        out.slice(-600)
      }`,
    );
    assert(
      ms < CEILING_MS,
      `took ${ms.toFixed(0)}ms — a refusal that hangs is worse than a crash, ` +
        `because it looks like work:\n${out.slice(-600)}`,
    );
  },
});
