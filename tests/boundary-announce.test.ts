// Stillness at the boundary (llama.master).
//
// Two facts an app can be WRONG about with no error anywhere: which aio it is
// actually RUNNING, and whether a framework default has taken over its layout.
// Both were diagnosed in the field by symptom — six releases of pin drift found
// by "why did the semantics change", and a re-laid-out window found by "why is
// my UI in half the screen". The framework knew both answers at boot and said
// neither.
//
// `dep/aio` is commonly a SYMLINK to a live checkout, so an app's "installed
// version" is whatever that tree is this minute; `deno.json` says alpha55 while
// the process is alpha61 plus uncommitted work. A lint the developer must
// remember to run is not the same as the runtime saying so.
import { assert, assertEquals } from "@std/assert";
import { VERSION } from "../src/server/aio-cli.ts";

const AIO = new URL("..", import.meta.url).pathname;

async function boot(aioVersion: string | null): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "aio-pin-" });
  try {
    await Deno.mkdir(`${dir}/src`, { recursive: true });
    await Deno.writeTextFile(
      `${dir}/deno.json`,
      JSON.stringify({
        title: "pinprobe",
        ...(aioVersion === null ? {} : { aioVersion }),
      }),
    );
    await Deno.writeTextFile(
      `${dir}/src/app.ts`,
      `import { aio, cell } from "${AIO}mod.ts";\n` +
        `cell("pinprobe", { state: { n: 0 }, methods: {} });\n` +
        `const app = await aio.run({ cells: [], port: 0, client: "server-only", singleton: false });\n` +
        `await app.stop?.();\nDeno.exit(0);\n`,
    );
    const out = await new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", "--config", `${AIO}deno.json`, `${dir}/src/app.ts`],
      env: { AIO_APPS_DIR: `${dir}/home`, NO_COLOR: "1" },
      stdout: "piped",
      stderr: "piped",
    }).output();
    return new TextDecoder().decode(out.stdout) +
      new TextDecoder().decode(out.stderr);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

const PIN_LINE = /version: this app pins aio/;

Deno.test("boot says so when the app is running an aio it did not pin", async () => {
  const out = await boot("v1.0.0-alpha55");
  assert(PIN_LINE.test(out), `no drift warning in:\n${out}`);
  // Both numbers, and the two ways out — a warning that does not say what to
  // do is a line people learn to skip.
  assert(out.includes("v1.0.0-alpha55"), "must name the DECLARED pin");
  assert(out.includes(VERSION), "must name what is actually running");
  assert(out.includes("am pin"), "must name the fix");
});

Deno.test("boot is silent when the pin is right, absent, or deliberate", async () => {
  // matching pin
  assertEquals(PIN_LINE.test(await boot(`v${VERSION}`)), false);
  // no pin declared at all — nothing to disagree with
  assertEquals(PIN_LINE.test(await boot(null)), false);
  // `path:` IS "whatever that tree is", by the developer's own choice
  assertEquals(PIN_LINE.test(await boot("path:/somewhere/aio")), false);
});
