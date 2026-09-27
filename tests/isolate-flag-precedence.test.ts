// `--isolate=` overrides `aio.run({ isolate })`.
//
// CliFlags is documented as "CLI flags — overrides config values", and
// config-sources.ts names dbPath as "the one key where [config] does [win]".
// aio.ts resolved isolate as `fc.isolate ?? cliIsolate` — the config won and
// the flag was ignored without a word (the raw-merge gate in
// one-decider.test.ts missed it because the flag was read into a local first;
// it now follows such locals). Precedence lives in `isolateOf`.
import { assert, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { freePort } from "../src/testing/server-test.ts";
import { aioTestDir } from "../src/testing/test-strict.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const AIO_ROOT = new URL("..", import.meta.url).pathname;

const APP = `import { aio, cell } from "${join(AIO_ROOT, "mod.ts")}";
export const alpha = cell("alpha", { state: { n: 0 }, methods: { hi() { return "alpha"; } } });
export const beta = cell("beta", { state: { n: 0 }, methods: { hi() { return "beta"; } } });
await aio.run({ appId: "isolate-flag-precedence", cells: [alpha, beta], isolate: ["alpha"] });
console.log("BOOTED");
Deno.exit(0);
`;

Deno.test("--isolate on the command line overrides aio.run({ isolate })", async () => {
  const dir = await tempDir("isolate-flag-");
  const apps = aioTestDir("isolate-flag-apps-");
  try {
    const entry = join(dir, "app.ts");
    await Deno.writeTextFile(entry, APP);
    const port = await freePort();
    const r = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        `--config=${join(AIO_ROOT, "deno.json")}`,
        entry,
        `--port=${port}`,
        "--client=server-only",
        // A typo in the FLAG: honoured, it must be refused by name
        // (filterCellsByIsolate refuses unknown names).
        "--isolate=betaa",
      ],
      cwd: dir,
      env: { AIO_APPS_DIR: apps },
      stdout: "piped",
      stderr: "piped",
    }).output();
    const out = new TextDecoder().decode(r.stdout);
    const err = new TextDecoder().decode(r.stderr);
    assert(
      !out.includes("BOOTED"),
      `the app booted with config isolate ["alpha"] — the --isolate=betaa ` +
        `flag was ignored entirely (exit ${r.code})`,
    );
    assertStringIncludes(err + out, "betaa");
  } finally {
    await dropTempDir(dir);
    await Deno.remove(apps, { recursive: true }).catch(() => {});
  }
});
