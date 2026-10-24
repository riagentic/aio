// SQLite answers a pragma NAME it does not know with silence, and a VALUE it
// does not know with its default. Measured: `dbPragmas: ["PRAGMA synchronus =
// FULL"]` (typo) and `"PRAGMA synchronous = FUL"` both booted at synchronous
// = NORMAL — the power-cut durability the docs tell an app to ask for, not
// there, not a word — and `"PRAGMA journal_mode = WALL"` replaced the default
// WAL and opened the file in rollback-journal mode. Boot now names each one.
import { assertEquals, assertStringIncludes } from "@std/assert";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { fromFileUrl, join } from "@std/path";
import { createDB, pragmaRefusals } from "../src/db/async-db.ts";

// aio-ok: checkBoth (below) asserts every refusal
Deno.test("pragmaRefusals: an unknown name or value is named; a taken one is not", async () => {
  const dir = await tempDir("aio-pragma-");
  const asked = [
    "PRAGMA synchronus = FULL",
    "PRAGMA synchronous = FUL",
    "PRAGMA journal_mode = WALL",
  ];
  try {
    await checkBoth(dir, asked);
  } finally {
    await dropTempDir(dir);
  }
});

async function checkBoth(dir: string, asked: string[]): Promise<void> {
  const db = createDB(join(dir, "a.db"), { pragmas: asked });
  try {
    const why = await pragmaRefusals(db, asked);
    assertEquals(why.length, 3, why.join("\n"));
    assertStringIncludes(why[0]!, `no pragma "synchronus"`);
    assertStringIncludes(why[1]!, "synchronous = 1");
    assertStringIncludes(why[2]!, "journal_mode = delete");
  } finally {
    await db.close();
  }
  const fine = [
    "PRAGMA synchronous = FULL",
    "PRAGMA main.foreign_keys = off",
    "PRAGMA cache_size=-2000;",
    "PRAGMA temp_store = MEMORY",
    "PRAGMA journal_mode = wal",
  ];
  const ok = createDB(join(dir, "b.db"), { pragmas: fine });
  try {
    assertEquals(await pragmaRefusals(ok, fine), []);
  } finally {
    await ok.close();
  }
}

Deno.test("boot: a dbPragmas entry SQLite did not take is logged as an error", async () => {
  const dir = await tempDir("aio-pragma-boot-");
  const script = join(dir, "app.ts");
  const mod = new URL("../mod.ts", import.meta.url).href;
  await Deno.writeTextFile(
    script,
    `import { aio, cell } from "${mod}";
const app = await aio.run({
  cells: [cell("c", { state: { n: 0 }, methods: {} })],
  appId: "pragmaboot", client: "server-only", libraryMode: true,
  singleton: false, port: 0 as never, appDir: ${JSON.stringify(dir)},
  baseDir: ${JSON.stringify(dir)}, dbPragmas: ["PRAGMA synchronus = FULL"],
});
await app.close();
`,
  );
  try {
    const out = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        "--config",
        fromFileUrl(new URL("../deno.json", import.meta.url)),
        script,
      ],
      stdout: "piped",
      stderr: "piped",
      env: { NO_COLOR: "1" },
    }).output();
    const text = new TextDecoder().decode(out.stdout) +
      new TextDecoder().decode(out.stderr);
    assertEquals(out.code, 0, text);
    assertStringIncludes(text, `dbPragmas: "PRAGMA synchronus = FULL"`);
  } finally {
    await dropTempDir(dir);
  }
});
