// `--db-path` has ONE decider (feedback/frustration.md F6 — two deciders).
//
// Storage opened `config.dbPath ?? cli.dbPath`, while the shutdown "database
// is GONE" check and the boot report read `config.dbPath` alone. A run with only `--db-path=x.db`
// therefore reported the default file and ended with a false "GONE" alarm
// about a file it never used. A child process, because the flag is argv.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const MOD = new URL("../mod.ts", import.meta.url).href;
const CONFIG = new URL("../deno.json", import.meta.url).pathname;

async function boot(dir: string, cfgDbPath: string | null, flag: string) {
  const app = join(dir, "app.ts");
  await Deno.writeTextFile(
    app,
    `import { aio, cell } from ${JSON.stringify(MOD)};
const c = cell("onedec", { state: { n: 0 }, methods: { inc(s) { s.n++; } } });
const app = await aio.run({
  appId: "onedec-test", cells: [c], libraryMode: true, client: "server-only",
  appDir: ${JSON.stringify(join(dir, "home"))},
  ${cfgDbPath ? `dbPath: ${JSON.stringify(cfgDbPath)},` : ""}
});
await c.inc();
await app.close();
`,
  );
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "--config", CONFIG, app, `--db-path=${flag}`],
    env: { ...Deno.env.toObject(), NO_COLOR: "1" },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const d = new TextDecoder();
  return { code: out.code, text: d.decode(out.stdout) + d.decode(out.stderr) };
}

const exists = (p: string) => Deno.stat(p).then(() => true, () => false);

Deno.test("--db-path: the flag's file is the database — and shutdown does not cry GONE", async () => {
  const dir = await tempDir("aio-onedec-");
  try {
    const flagDb = join(dir, "flag.db");
    const r = await boot(dir, null, flagDb);
    assertEquals(r.code, 0, r.text);
    assert(await exists(flagDb), `the flag's file was not used:\n${r.text}`);
    assert(!r.text.includes("GONE"), `false alarm:\n${r.text}`);
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("--db-path AND a config dbPath: the config wins, as it always did — and the ignored flag is named", async () => {
  // Not flipped: a deployment passing both would open a DIFFERENT database
  // after an upgrade, which looks exactly like data loss. Said out loud.
  const dir = await tempDir("aio-onedec-");
  try {
    const flagDb = join(dir, "flag.db");
    const cfgDb = join(dir, "config.db");
    const r = await boot(dir, cfgDb, flagDb);
    assertEquals(r.code, 0, r.text);
    assert(await exists(cfgDb), `the config's file was not used:\n${r.text}`);
    assert(!await exists(flagDb), "the ignored flag's file was opened too");
    assert(
      r.text.includes(`--db-path=${flagDb} is ignored`),
      `no warning about the ignored flag:\n${r.text}`,
    );
    assert(!r.text.includes("GONE"), `false alarm:\n${r.text}`);
  } finally {
    await dropTempDir(dir);
  }
});
