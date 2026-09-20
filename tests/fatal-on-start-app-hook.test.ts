// `fatalOnStart: true` ends the process when the APP's `onStart` fails — as
// docs/state/lifecycle.md always said. It only guarded aio's own start hook;
// the app's hook logged and carried on, leaving a half-started app running.
// Child processes, because the promise is an exit code.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const MOD = new URL("../mod.ts", import.meta.url).href;
const CONFIG = new URL("../deno.json", import.meta.url).pathname;

async function boot(onStart: string, fatal: boolean) {
  const dir = await tempDir("aio-fatal-start-");
  try {
    const app = join(dir, "app.ts");
    await Deno.writeTextFile(
      app,
      `import { aio, cell } from ${JSON.stringify(MOD)};
const c = cell("fatalstart", { state: { n: 0 }, methods: { inc(s) { s.n++; } } });
const app = await aio.run({
  appId: "fatal-start-test", cells: [c], client: "server-only",
  appDir: ${JSON.stringify(join(dir, "home"))}, dbPath: ":memory:",
  fatalOnStart: ${fatal},
  ${onStart},
});
// Reached only when onStart did NOT end the process: stop cleanly, exit 7.
setTimeout(async () => { await app.close(); Deno.exit(7); }, 1500);
`,
    );
    const out = await new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", "--config", CONFIG, app, "--port=0"],
      env: { ...Deno.env.toObject(), NO_COLOR: "1" },
      stdout: "piped",
      stderr: "piped",
    }).output();
    const d = new TextDecoder();
    return {
      code: out.code,
      text: d.decode(out.stdout) + d.decode(out.stderr),
    };
  } finally {
    await dropTempDir(dir);
  }
}

Deno.test("fatalOnStart: a THROWING app onStart ends the process with code 1", async () => {
  const r = await boot(`onStart() { throw new Error("seed failed"); }`, true);
  assertEquals(r.code, 1, r.text);
  assert(r.text.includes("fatalOnStart is true"), r.text);
});

Deno.test("fatalOnStart: a REJECTING async app onStart ends the process with code 1", async () => {
  const r = await boot(
    `async onStart() { await Promise.resolve(); throw new Error("late"); }`,
    true,
  );
  assertEquals(r.code, 1, r.text);
  assert(r.text.includes("fatalOnStart is true"), r.text);
});

Deno.test("without fatalOnStart the failure is logged and the app keeps running", async () => {
  const r = await boot(`onStart() { throw new Error("seed failed"); }`, false);
  assertEquals(r.code, 7, r.text);
  assert(r.text.includes("onStart hook error"), r.text);
});
