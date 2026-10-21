// `am state --offline`: a NON-running app's persisted state, read-only,
// through aio's own store code (src/server/stored-state.ts).
import "./store-sandbox.ts";
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { createDB } from "../src/db/async-db.ts";
import { SKV_SCHEMA, sqliteKv } from "../src/server/skv-sqlite.ts";
import { PERSIST_SCHEMA_VERSION } from "../src/server/persist-schema.ts";
import {
  _storedPersistKey,
  readStoredState,
} from "../src/server/stored-state.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { DENO_DIR } from "./deno-dir-helper.ts";

const SEP = "\x1f";

/** A store as the persistence manager writes it. */
async function store(
  path: string,
  write: (kv: ReturnType<typeof sqliteKv>) => Promise<unknown>,
) {
  const db = createDB(path);
  try {
    await db.execute(SKV_SCHEMA);
    await write(sqliteKv(db));
  } finally {
    await db.close();
  }
}

Deno.test("_storedPersistKey: the default, a lone custom key, none, several", () => {
  assertEquals(_storedPersistKey(["state", "app:__schema"]), "state");
  assertEquals(_storedPersistKey([`state${SEP}a`, `state${SEP}b`]), "state");
  assertEquals(
    _storedPersistKey([`mine${SEP}a`, "app:__versions", "aio:__timeTravel"]),
    "mine",
  );
  assertEquals(_storedPersistKey(["app:__schema"]), null);
  assertEquals(_storedPersistKey([]), null);
  assertThrows(() => _storedPersistKey(["one", "two"]), Error, "persistKey");
});

Deno.test("readStoredState: single, multi and custom-key layouts; parked slices left out; empty → null", async () => {
  const dir = await tempDir("am-offline-");
  try {
    const single = join(dir, "single.db");
    await store(single, async (kv) => {
      await kv.set("state", { counter: { count: 5 }, __parked: { x: 1 } });
      await kv.set("app:__schema", PERSIST_SCHEMA_VERSION);
    });
    assertEquals(await readStoredState(single, "app"), {
      counter: { count: 5 },
    });

    const multi = join(dir, "multi.db");
    await store(
      multi,
      (kv) => kv.setMulti("prefs", { theme: "dark", list: [1] }),
    );
    assertEquals(await readStoredState(multi, "app"), {
      theme: "dark",
      list: [1],
    });

    const empty = join(dir, "empty.db");
    await store(empty, () => Promise.resolve());
    assertEquals(await readStoredState(empty, "app"), null);

    await assertRejects(
      () => readStoredState(join(dir, "nope.db"), "app"),
      Deno.errors.NotFound,
    );
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("readStoredState: a NEWER schema and two different layouts are refused, never guessed", async () => {
  const dir = await tempDir("am-offline-");
  try {
    const newer = join(dir, "newer.db");
    await store(newer, async (kv) => {
      await kv.set("state", { a: 1 });
      await kv.set("app:__schema", PERSIST_SCHEMA_VERSION + 1);
    });
    await assertRejects(() => readStoredState(newer, "app"), Error, "NEWER");

    const both = join(dir, "both.db");
    await store(both, async (kv) => {
      await kv.set("state", { a: 1 });
      await kv.setMulti("state", { a: 2 });
    });
    await assertRejects(
      () => readStoredState(both, "app"),
      Error,
      "BOTH layouts",
    );

    // The same document twice (an interrupted layout migration) is not ambiguous.
    const twin = join(dir, "twin.db");
    await store(twin, async (kv) => {
      await kv.set("state", { b: 2, a: 1 });
      await kv.setMulti("state", { a: 1, b: 2 });
    });
    assertEquals(await readStoredState(twin, "app"), { b: 2, a: 1 });
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("readStoredState: beside a live WAL writer it reads the last commit, and it never writes the file", async () => {
  const dir = await tempDir("am-offline-");
  const path = join(dir, "state.db");
  const writer = createDB(path); // the running app's connection (WAL)
  try {
    await writer.execute(SKV_SCHEMA);
    const kv = sqliteKv(writer);
    await kv.set("state", { n: { v: 1 } });
    assertEquals(await readStoredState(path, "app"), { n: { v: 1 } });
    await kv.set("state", { n: { v: 2 } });
    assertEquals(await readStoredState(path, "app"), { n: { v: 2 } });
  } finally {
    await writer.close();
  }
  try {
    // Stopped: the reader leaves the store byte-identical.
    const before = await Deno.readFile(path);
    assertEquals(await readStoredState(path, "app"), { n: { v: 2 } });
    assertEquals(await Deno.readFile(path), before);
  } finally {
    await dropTempDir(dir);
  }
});

const AM = fromFileUrl(new URL("../src/am.ts", import.meta.url));
const CONFIG = fromFileUrl(new URL("../deno.json", import.meta.url));

Deno.test("am state --offline: a stopped app's stored value by path; a missing path and a missing store exit 1", async () => {
  const base = await tempDir("am-offline-cli-");
  try {
    const home = join(base, "h");
    await Deno.mkdir(join(home, "data"), { recursive: true });
    await store(join(home, "data", "state.db"), async (kv) => {
      await kv.set("state", { tracks: { titles: ["a", "b"] } });
      await kv.set("offapp:__schema", PERSIST_SCHEMA_VERSION);
    });
    const cwd = join(base, "cwd");
    await Deno.mkdir(cwd);
    const run = async (argv: string[]) => {
      const o = await new Deno.Command(Deno.execPath(), {
        args: ["run", "-A", "--config", CONFIG, AM, ...argv],
        cwd,
        env: {
          HOME: base,
          AIO_HOME: base,
          AIO_APPS_DIR: join(base, "apps"),
          AIO_INSTALL_ROOT: join(base, "install"),
          AIO_VERSIONS_DIR: join(base, "versions"),
          AIO_FEEDBACK_DIR: join(base, "feedback"),
          XDG_RUNTIME_DIR: join(base, "run"),
          AIO_AM_NO_DELEGATE: "1",
          PATH: Deno.env.get("PATH") ?? "",
          NO_COLOR: "1",
          DENO_DIR,
        },
        clearEnv: true,
        stdout: "piped",
        stderr: "piped",
      }).output();
      const dec = new TextDecoder();
      return {
        code: o.code,
        out: dec.decode(o.stdout),
        err: dec.decode(o.stderr),
      };
    };
    const ok = await run([
      "state",
      "--offline",
      "tracks.titles",
      "--app=offapp",
      `--home=${home}`,
      "--json",
    ]);
    assertEquals(ok.code, 0, ok.err);
    assertEquals(JSON.parse(ok.out), ["a", "b"]);
    assertStringIncludes(ok.err, "offline:");
    const miss = await run([
      "state",
      "--offline",
      "tracks.nope",
      "--app=offapp",
      `--home=${home}`,
    ]);
    assertEquals(miss.code, 1);
    assertStringIncludes(miss.out + miss.err, "titles");
    const none = await run([
      "state",
      "--offline",
      "--app=ghost",
      `--home=${join(base, "ghost")}`,
    ]);
    assertEquals(none.code, 1);
    assertStringIncludes(none.out + none.err, "no store");
    const watch = await run([
      "state",
      "--offline",
      "--watch",
      "--app=offapp",
      `--home=${home}`,
    ]);
    assertEquals(watch.code, 1);
    assert((watch.out + watch.err).includes("--offline reads the store once"));
  } finally {
    await dropTempDir(base);
  }
});
