// ONE decider per setting with more than one home (feedback/frustration.md F6).
//
// The declared window size lost to `--width` in one place and not another;
// `expose`, the bind address and the database file went the same way — each
// time because two sites answered "which source wins?" with their own `??`
// chain and one drifted. The precedence now lives in src/server/config-sources.ts
// as ordered candidate lists; this file refuses a raw merge anywhere else, and
// pins that the source label and the value come from the same list.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  dbPathOf,
  keepServerOf,
  persistOf,
  pick,
  pickOr,
  sourceLines,
  windowSizeOf,
} from "../src/server/config-sources.ts";
import { bootLines, buildFacts } from "../src/server/boot-facts.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const SRC = new URL("../src/", import.meta.url).pathname;
// A flag read merged with anything by `??`, in either order.
const RAW_MERGE =
  /\b(?:cli|parseCli\([^)]*\))\.\w+\s*\?\?|\?\?\s*(?:cli|parseCli\([^)]*\))\.\w+/;

async function* serverFiles(dir: string): AsyncGenerator<string> {
  for await (const e of Deno.readDir(dir)) {
    const p = join(dir, e.name);
    if (e.isDirectory) yield* serverFiles(p);
    else if (e.name.endsWith(".ts")) yield p;
  }
}

Deno.test("no flag is merged with its config twin outside config-sources.ts", async () => {
  const hits: string[] = [];
  let scanned = 0;
  // Where `cli` is aio's parsed flags. (src/testing has its own `cli` — a
  // client — and src/am its own `flags`.)
  for (const dir of ["server", "electron", "build"]) {
    for await (const file of serverFiles(SRC + dir)) {
      if (file.endsWith("config-sources.ts")) continue;
      scanned++;
      const lines = (await Deno.readTextFile(file)).split("\n");
      lines.forEach((line, i) => {
        const code = line.replace(/\/\/.*$/, "").trim();
        if (code.startsWith("*") || code.startsWith("/*")) return;
        if (RAW_MERGE.test(code)) {
          hits.push(`${file.slice(SRC.length)}:${i + 1}  ${code}`);
        }
      });
    }
  }
  assert(scanned > 100, `scanned only ${scanned} files`);
  assertEquals(
    hits,
    [],
    "a raw `cli.x ?? …` merge decides a setting's precedence outside its one " +
      "resolver — add or use one in src/server/config-sources.ts:\n  " +
      hits.join("\n  "),
  );
});

Deno.test("the gate's pattern: what it catches and what it leaves alone", () => {
  assert(RAW_MERGE.test("width: cli.width ?? ui.width,"));
  assert(RAW_MERGE.test("const d = config.dbPath ?? cli.dbPath;"));
  assert(RAW_MERGE.test("const h = parseCli().host ?? config.host;"));
  assert(!RAW_MERGE.test("const h = hostOf(parseCli(), config)?.value;"));
  assert(!RAW_MERGE.test("if (cli.width !== undefined) asked.push(x);"));
});

Deno.test('pick: `??` semantics — 0, false and "" are answers; null/undefined are not', () => {
  assertEquals(pick(["flag", 0], ["config", 8080]), { value: 0, from: "flag" });
  assertEquals(pick(["flag", undefined], ["config", false]), {
    value: false,
    from: "config",
  });
  assertEquals(pick(["flag", null], ["config", ""]), {
    value: "",
    from: "config",
  });
  assertEquals(pick(["flag", undefined], ["config", null]), undefined);
  assertEquals(pickOr(true, ["flag", undefined]), {
    value: true,
    from: "default",
  });
});

Deno.test("the resolvers keep each key's documented precedence", () => {
  // Flags win…
  assertEquals(windowSizeOf({ width: 420 }, { width: 800, height: 600 }), {
    width: { value: 420, from: "flag" },
    height: { value: 600, from: "config" },
  });
  assertEquals(persistOf({ persist: false }, { persist: true }).value, false);
  assertEquals(keepServerOf({}, true), { value: true, from: "config" });
  // …except the database file, where the config always won (aio.ts warns).
  assertEquals(dbPathOf({ dbPath: "a.db" }, { dbPath: "b.db" }), {
    value: "b.db",
    from: "config",
  });
});

Deno.test("--verbose boot report: one `setting` line per key, unset keys left out", () => {
  const lines = bootLines(buildFacts(), {
    sources: sourceLines([
      ["width", { value: 420, from: "flag" }],
      ["dbPath", undefined],
      ["client", { value: "browser", from: "deno.json" }],
    ]),
  });
  const settings = lines.filter(([k]) => k.startsWith("setting "));
  assertEquals(settings, [
    ["setting width", "420 (flag)"],
    ["setting client", '"browser" (deno.json)'],
  ]);
  assertEquals(
    bootLines(buildFacts(), {}).filter(([k]) => k.startsWith("setting "))
      .length,
    0,
    "without --verbose there is no sources list and no line",
  );
});

Deno.test("a real --verbose boot names the source of each setting", async () => {
  const dir = await tempDir("aio-onedec-verbose-");
  try {
    const app = join(dir, "app.ts");
    await Deno.writeTextFile(
      app,
      `import { aio, cell } from ${
        JSON.stringify(new URL("../mod.ts", import.meta.url).href)
      };
const c = cell("verb", { state: { n: 0 }, methods: {} });
const app = await aio.run({
  appId: "verbose-sources-test", cells: [c], client: "server-only",
  appDir: ${JSON.stringify(join(dir, "home"))}, persist: false,
});
await app.close();
Deno.exit(0);
`,
    );
    const out = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        "--config",
        new URL("../deno.json", import.meta.url).pathname,
        app,
        "--verbose",
        `--db-path=${join(dir, "x.db")}`,
      ],
      env: { ...Deno.env.toObject(), NO_COLOR: "1" },
      stdout: "piped",
      stderr: "piped",
    }).output();
    const d = new TextDecoder();
    const text = d.decode(out.stdout) + d.decode(out.stderr);
    assertEquals(out.code, 0, text);
    for (
      const want of [
        /\bclient\s+server-only \(config\)/,
        /setting persist\s+false \(config\)/,
        new RegExp(
          `setting dbPath\\s+"${
            join(dir, "x.db").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
          }" \\(flag\\)`,
        ),
        /setting expose\s+false \(default\)/,
      ]
    ) {
      assert(want.test(text), `missing ${want} in:\n${text}`);
    }
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("am doctor: a running instance's settings, aligned, with who decided", async () => {
  const { settingsBlock } = await import("../src/am/am-cmd-doctor.ts");
  // aio-ok: the expected block is a literal; it repeats the input values by design
  assertEquals(
    settingsBlock("notes", {
      persist: "false (config)",
      keepServer: "true (flag)",
    }),
    "settings — notes (value, and who decided it)\n" +
      "  persist     false (config)\n" +
      "  keepServer  true (flag)",
  );
  assertEquals(settingsBlock("old", undefined), "", "a pre-1.0.6 lock: silent");
});
