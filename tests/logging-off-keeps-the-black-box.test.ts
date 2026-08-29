// `logging: false` turns off the console logger. It must not turn off the
// black box.
//
// `getLogDir()` fell back to `DEFAULT_LOG_DIR` — the string `.aio/log`, which
// is RELATIVE TO THE CURRENT DIRECTORY — whenever no logger was active. So an
// app that set `logging: false` sent its diagnostics somewhere that usually
// does not exist:
//
//     ERROR action-log  write failed: NotFound: writefile '.aio/log/actions.jsonl'
//     WARN  checkpoint  final write failed: writefile '.aio/log/checkpoint.json.tmp'
//
// once per dispatch — and the action log and the crash checkpoint, the two
// artifacts whose entire job is to explain a crash after the fact, were not
// written at all. Found by the persistence audit round.
import { assert, assertEquals } from "@std/assert";
import { getLogDir, setFallbackLogDir } from "../src/diagnostics/logger-api.ts";
import { aio, cell } from "../mod.ts";

Deno.test("log dir: the app's own dir wins over the relative default", () => {
  const before = getLogDir();
  try {
    setFallbackLogDir("/tmp/some-app/logs");
    assertEquals(getLogDir(), "/tmp/some-app/logs");
    assert(
      !getLogDir().startsWith("."),
      "an absolute dir, not a cwd-relative one",
    );
    setFallbackLogDir(null);
    assertEquals(
      getLogDir(),
      ".aio/log",
      "with no app at all the relative default is still the answer",
    );
  } finally {
    setFallbackLogDir(null);
    void before;
  }
});

Deno.test("log dir: `logging: false` still writes the action log and the checkpoint", async () => {
  const dir = await Deno.makeTempDir({ prefix: "aio-blackbox-" });
  const c = cell("blackbox", {
    state: { n: 0 },
    methods: {
      bump(s) {
        s.n++;
      },
    },
  });
  const app = await aio.run({
    cells: [c],
    client: "server-only",
    singleton: false,
    libraryMode: true,
    baseDir: dir,
    appDir: dir,
    logging: false, // ← the whole point
  });
  try {
    for (let i = 0; i < 3; i++) await c.bump();
    await new Promise((r) => setTimeout(r, 300));
  } finally {
    await app.close();
  }
  const written: string[] = [];
  try {
    for await (const e of Deno.readDir(`${dir}/logs`)) written.push(e.name);
  } catch { /* no logs dir at all is the failure below */ }
  assert(
    written.includes("actions.jsonl"),
    `the action log was not written — logs/ held [${written.join(", ")}]`,
  );
  // …and nothing landed in the current directory.
  const stray = await Deno.stat(".aio/log/actions.jsonl").then(() => true)
    .catch(() => false);
  assertEquals(stray, false, "diagnostics wrote into the current directory");
  await Deno.remove(dir, { recursive: true }).catch(() => {});
});
