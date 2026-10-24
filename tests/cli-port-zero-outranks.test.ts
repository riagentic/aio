// `--port=0` is "let the OS pick a free one" — an ANSWER on the flag rung, so
// it outranks `AIO_PORT` and `aio.run({ port })` like any other `--port`.
// parseCli used to drop it (`port` undefined), and an app declaring
// `port: 8123` booted on 8123 under `--port=0` without a word — the exact
// escape the port-clash refusal recommends (`suggests --port=0`).
import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { parseCli } from "../src/server/aio-cli.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

Deno.test("parseCli: --port=0 is kept as an answer (0), not dropped", () => {
  assertEquals(parseCli(["--port=0"]).port, 0);
  assertEquals(parseCli(["--port=3000"]).port, 3000);
});

Deno.test("a real boot: --port=0 beats aio.run({ port }) and AIO_PORT", async () => {
  const dir = await tempDir("aio-port-zero-");
  try {
    const declared = freePort();
    const envPort = freePort();
    const app = join(dir, "app.ts");
    await Deno.writeTextFile(
      app,
      `import { aio, cell } from ${
        JSON.stringify(new URL("../mod.ts", import.meta.url).href)
      };
const c = cell("pz", { state: { n: 0 }, methods: {} });
const app = await aio.run({
  appId: "port-zero-test", cells: [c], client: "server-only",
  appDir: ${JSON.stringify(join(dir, "home"))}, persist: false,
  port: ${declared},
});
console.log("BOUND " + app.port);
await app.close();
Deno.exit(0);
`,
    );
    const out = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        "--config",
        fromFileUrl(new URL("../deno.json", import.meta.url)),
        app,
        "--port=0",
      ],
      env: {
        ...Deno.env.toObject(),
        NO_COLOR: "1",
        AIO_PORT: String(envPort),
      },
      stdout: "piped",
      stderr: "piped",
    }).output();
    const d = new TextDecoder();
    const text = d.decode(out.stdout) + d.decode(out.stderr);
    assertEquals(out.code, 0, text);
    const bound = Number(text.match(/BOUND (\d+)/)?.[1]);
    assert(bound > 0, `no bound port in:\n${text}`);
    assertNotEquals(bound, declared, `--port=0 lost to config:\n${text}`);
    assertNotEquals(bound, envPort, `--port=0 lost to AIO_PORT:\n${text}`);
    assert(/\bport\s+\d+ \(flag\)/.test(text), `not labelled flag:\n${text}`);
  } finally {
    await dropTempDir(dir);
  }
});
