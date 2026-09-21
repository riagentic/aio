// A healthy app run ends `errors=0`.
//
// The other half of counting every error-level line on the stopped summary.
// `errors=N` used to count ONLY async method failures, so an app that lost
// every write to a deleted database still printed `errors=0`; the fix counts
// every `log.error` instead. That fix has an obvious failure mode of its own:
// if ANY routine framework path logs at error level during a normal boot,
// dispatch or shutdown, then every clean run ends with a non-zero count and
// the number stops meaning anything at all — the same way round as before,
// just louder. Nobody would notice, because a number that is always 2 looks
// exactly like a number that is working.
//
// So this is the negative half, and it is deliberately a REAL PROCESS: an
// in-process harness skips the boot and shutdown phases, which are precisely
// where a stray `log.error` would live.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const REPO = new URL("..", import.meta.url).pathname;
const MOD = new URL("../mod.ts", import.meta.url).href;

/** Boot a persisting app, do ordinary work, close it. Returns its `app.log`
 *  plus its stderr — the stopped summary is an INFO line, so it lands in the
 *  log file, while anything that went wrong is on stderr too. Reading both is
 *  what a person does. */
async function cleanRun(dir: string): Promise<string> {
  const file = join(dir, "app.ts");
  await Deno.writeTextFile(
    file,
    `import { aio, cell } from ${JSON.stringify(MOD)};
const box = cell("box", {
  state: { count: 0, items: [] as string[] },
  methods: {
    set(s: { count: number }, n: number) { s.count = n; },
    add(s: { items: string[] }, t: string) { s.items.push(t); },
    async load(s: { items: string[] }) { s.items = [...s.items, "loaded"]; },
  },
});
const app = await aio.run({
  cells: [box],
  appId: "clean",
  client: "server-only",
  libraryMode: true,
  singleton: false,
  port: 0,
  appDir: ${JSON.stringify(dir)},
  baseDir: ${JSON.stringify(dir)},
  persistDebounceMs: 20,
});
await box.set(1);
await box.add("milk");
await box.load();
await new Promise((r) => setTimeout(r, 200));
await app.close();
Deno.exit(0);
`,
  );
  const { stderr } = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "--config", join(REPO, "deno.json"), file],
    env: { AIO_APPS_DIR: dir, NO_COLOR: "1" },
    stdout: "null",
    stderr: "piped",
  }).output();
  const err = new TextDecoder().decode(stderr);
  let app = "";
  for (const p of [join(dir, "logs", "app.log"), join(dir, "app.log")]) {
    app = await Deno.readTextFile(p).catch(() => "");
    if (app) break;
  }
  return `${app}\n${err}`;
}

Deno.test({
  name:
    "logger: a run with nothing wrong ends errors=0, so the count means something",
  fn: async () => {
    const dir = await tempDir("aio-errors-zero-");
    try {
      const err = await cleanRun(dir);

      // The instrument first. If the app never got as far as stopping, an
      // absent `errors=` would "pass" and pin nothing at all.
      const stopped = err.split("\n").filter((l) => /\bstopped\b/.test(l))
        .pop();
      assert(
        stopped,
        `the app never printed a stopped line, so there is no count to ` +
          `check:\n${err.slice(-1200)}`,
      );
      const m = /\berrors=(\d+)/.exec(stopped);
      assert(m, `the stopped line carries no errors= count: ${stopped}`);

      assertEquals(
        Number(m[1]),
        0,
        `an ordinary boot → three dispatches → clean close reported ` +
          `${m[1]} error(s). Either the framework logs at error level on a ` +
          `healthy path — which makes errors= useless, because every clean ` +
          `run then looks like a broken one — or something really is wrong ` +
          `in boot/shutdown. Either way the lines are above:\n` +
          err.split("\n").filter((l) => /ERROR/.test(l)).join("\n"),
      );

      // …and it really did the work, so "0" is not the answer to "nothing ran".
      assert(
        /\bdispatched=([1-9]\d*)/.test(stopped),
        `the run dispatched nothing, so errors=0 proves nothing: ${stopped}`,
      );
    } finally {
      await dropTempDir(dir);
    }
  },
});
