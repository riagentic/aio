// `"build": { "minify": true }`, end to end: a scaffolded app (aio reached
// through its `dep/aio` symlink, the layout `am create` writes) built by the
// real builder. The artifact must carry none of the server's comments or local
// names — and still boot from a foreign cwd, run a method, and keep its state
// (the SQLite worker is found by `new URL(…, import.meta.url)`, which is what
// a one-file bundle broke). The unminified control build proves the byte
// search can see the marker at all.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  childEnv,
  freePort,
  makeApp,
  placedBinary,
  task,
} from "./e2e-app-harness.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const GATE = Deno.env.get("AIO_BUILD_E2E") === "1";
const COMMENT = "SERVER-DESIGN-NOTE-7731";
const LOCAL = "serverSecretLocalName";

function contains(bin: Uint8Array, text: string): boolean {
  const needle = new TextEncoder().encode(text);
  outer: for (
    let i = bin.indexOf(needle[0]!);
    i >= 0;
    i = bin.indexOf(needle[0]!, i + 1)
  ) {
    for (let j = 1; j < needle.length; j++) {
      if (bin[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}

async function build(
  dir: string,
): Promise<{ bin: Uint8Array; log: string; path: string }> {
  const r = await task(dir, "compile");
  assertEquals(r.code, 0, `compile failed:\n${r.out}\n${r.err}`);
  const path = placedBinary(dir);
  return { bin: await Deno.readFile(path), log: r.out + r.err, path };
}

Deno.test({
  name:
    "build e2e: build.minify ships no server comment or local name, and the binary still boots, runs a method and keeps its state",
  ignore: !GATE,
  sanitizeResources: false, // aio-ok: the compiled app is a child process; this test kills and awaits it
  sanitizeOps: false, // aio-ok: the compiled app is a child process; this test kills and awaits it
  async fn() {
    const dir = await makeApp("counter", "build-e2e-minify-");
    const sandbox = await tempDir("build-e2e-minify-home-");
    try {
      await Deno.writeTextFile(
        join(dir, "src", "app.ts"),
        `\n// ${COMMENT}: why this server works the way it does\n` +
          `const ${LOCAL} = 41;\nif (${LOCAL} + 1 !== 42) throw new Error("math");\n`,
        { append: true },
      );

      // Control: without minify the marker IS in the binary.
      const plain = await build(dir);
      assert(
        contains(plain.bin, COMMENT),
        "the byte search cannot see the comment",
      );
      assert(
        contains(plain.bin, LOCAL),
        "the byte search cannot see the local",
      );
      assert(
        /\.app\.js\.map[^\n]*goes into the binary/.test(plain.log),
        "the control build's map line is not where this test looks",
      );

      // Kept aside: the minified build replaces it in place.
      const plainBin = join(sandbox, "plain-bin");
      await Deno.copyFile(plain.path, plainBin);
      await Deno.chmod(plainBin, 0o755);

      const cfgPath = join(dir, "deno.json");
      const cfg = JSON.parse(await Deno.readTextFile(cfgPath));
      cfg.build = { ...cfg.build, minify: true };
      await Deno.writeTextFile(cfgPath, JSON.stringify(cfg, null, 2));
      const min = await build(dir);
      assertStringIncludes(min.log, "server modules minified");
      // The build's own words about the client map match what it ships.
      assertStringIncludes(min.log, "build.minify leaves it out of the binary");
      assert(
        !/\.app\.js\.map[^\n]*goes into the binary/.test(min.log),
        "the log says the map ships",
      );
      assert(!contains(min.bin, COMMENT), "a server comment shipped");
      assert(!contains(min.bin, LOCAL), "a server local name shipped");
      await Deno.stat(join(dir, ".aio", "minify-stage")).then(
        () => assert(false, "the minify stage was left behind"),
        () => {},
      );

      // Boot from a foreign cwd, run a method, restart, read it back.
      await Deno.writeTextFile(
        join(dir, "probe.ts"),
        `import { connectCli } from "aio/server";
import { counter } from "./src/cell.ts";
const app = connectCli(Deno.args[0], { readyTimeoutMs: 10_000 });
await app.ready;
app.bind(counter);
for (let i = 0; i < Number(Deno.args[1]); i++) await counter.increment(2);
console.log("COUNT " + JSON.stringify(app.state));
app.close();
Deno.exit(0);
`,
      );
      const foreign = join(sandbox, "elsewhere");
      await Deno.mkdir(foreign);
      const env = childEnv({
        HOME: join(sandbox, "home"),
        AIO_APPS_DIR: join(sandbox, "apps"),
        PATH: Deno.env.get("PATH") ?? "",
      });
      const run = async (
        calls: number,
        bin = min.path,
      ): Promise<string> => {
        const port = freePort();
        const child = new Deno.Command(bin, {
          args: [`--port=${port}`, "--client=server-only"],
          cwd: foreign,
          env,
          clearEnv: true,
          stdout: "piped",
          stderr: "piped",
        }).spawn();
        const out = child.output();
        try {
          let up = false;
          for (let i = 0; i < 150 && !up; i++) {
            up = await fetch(`http://127.0.0.1:${port}/__aio/health`).then(
              async (r) => (await r.body?.cancel(), r.ok),
              () => false,
            );
            if (!up) await new Promise((r) => setTimeout(r, 200));
          }
          assert(up, "the minified binary never served");
          const p = await new Deno.Command(Deno.execPath(), {
            args: [
              "run",
              "-A",
              "probe.ts",
              `ws://127.0.0.1:${port}/ws`,
              String(calls),
            ],
            cwd: dir,
            stdout: "piped",
            stderr: "piped",
          }).output();
          const text = new TextDecoder().decode(p.stdout);
          return text.split("\n").find((l) => l.startsWith("COUNT ")) ??
            `no COUNT: ${text}${new TextDecoder().decode(p.stderr)}`;
        } finally {
          child.kill("SIGTERM");
          const o = await out;
          const err = new TextDecoder().decode(o.stderr);
          assert(!/Module not found|ERROR/.test(err), err);
        }
      };
      // Turning minify ON keeps the app's identity, so its data: the state the
      // unminified binary saved is what the minified one starts from.
      assertEquals(await run(1, plainBin), 'COUNT {"counter":{"count":2}}');
      assertEquals(await run(2), 'COUNT {"counter":{"count":6}}');
      assertEquals(
        await run(0),
        'COUNT {"counter":{"count":6}}',
        "state was not kept",
      );
    } finally {
      await dropTempDir(dir);
      await dropTempDir(sandbox);
    }
  },
});
