// `am state 'pool.models[?loaded]'` answered `path "…" not found`: the path
// syntax had `[*]` and `{pick}` but no way to keep only the matching items, so
// an agent wanting "the loaded models" scripted around `am`. `[?k]`,
// `[?k=v]` and `[?k!=v]` filter an array's items, compose with the rest of
// the grammar, and a miss prints the grammar.
import "./store-sandbox.ts";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { PATH_SYNTAX, resolvePath } from "../src/am/am-utils.ts";
import { _missHint } from "../src/am/am-cmd-state.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { ownHome } from "./deno-dir-helper.ts";
import { spec } from "./module-spec-helper.ts";

const MODELS = [
  { name: "a", loaded: true, size: 3, kind: "llm", tags: ["x"] },
  { name: "b", loaded: false, size: 7, kind: "embed" },
  { name: "c", loaded: true, size: 7, kind: "llm" },
  { name: "d", size: 1 },
];
const STATE = { pool: { models: MODELS, empty: [] as unknown[] } };
const get = (p: string) => resolvePath(STATE, p);
const names = (p: string) => {
  const r = get(p);
  assert(r.found, `${p} not found`);
  return (r.value as { name: string }[]).map((m) => m.name);
};

Deno.test("resolvePath [?k]: truthy, =, != — JSON value first, else a string", () => {
  assertEquals(names("pool.models[?loaded]"), ["a", "c"]);
  assertEquals(names("pool.models[?loaded=true]"), ["a", "c"]);
  assertEquals(names("pool.models[?loaded!=true]"), ["b", "d"]);
  assertEquals(names("pool.models[?size=7]"), ["b", "c"]);
  assertEquals(names('pool.models[?kind="llm"]'), ["a", "c"]);
  assertEquals(names("pool.models[?kind=llm]"), ["a", "c"]);
  assertEquals(names('pool.models[?tags=["x"]]'), ["a"]);
  // "7" is JSON for the number, so a string 7 is reached by quoting it.
  assertEquals(names('pool.models[?size="7"]'), []);
});

Deno.test("resolvePath [?k]: composes with picks, wildcards, indexes", () => {
  assertEquals(get("pool.models[?loaded].name"), {
    found: true,
    value: ["a", "c"],
  });
  assertEquals(get("pool.models[?size=7].{name,kind}"), {
    found: true,
    value: [{ name: "b", kind: "embed" }, { name: "c", kind: "llm" }],
  });
  assertEquals(get("[*].models[?loaded].name"), { found: false }); // root not an array
  assertEquals(resolvePath({ g: [STATE.pool] }, "g[*].models[?loaded].name"), {
    found: true,
    value: [["a", "c"]],
  });
  // A bracket after a filter addresses the kept list: `[0]` = first match.
  assertEquals(
    resolvePath({ g: [STATE.pool] }, "g[0].models[?loaded][1].name"),
    {
      found: true,
      value: "c",
    },
  );
  assertEquals(get("pool.models[?loaded][*].size"), {
    found: true,
    value: [3, 7],
  });
  assertEquals(get("pool.models[?kind=llm][?size=7].name"), {
    found: true,
    value: ["c"],
  });
});

Deno.test("resolvePath [?k]: a typo or a non-array is a miss, an empty match is []", () => {
  assertEquals(get("pool.models[?lodaed]"), { found: false });
  assertEquals(get("pool[?loaded]"), { found: false });
  assertEquals(get("pool.models[?loaded].nme"), { found: false });
  assertEquals(get("pool.models[?size=99]"), { found: true, value: [] });
  assertEquals(get("pool.models[?size=99].name"), { found: true, value: [] });
  assertEquals(get("pool.empty[?x]"), { found: true, value: [] });
  // The walk stops AT the filtered array, so the hint counts its items.
  assertEquals(
    _missHint(STATE, "pool.models[?lodaed]"),
    ` ("pool.models" has 4 items: 0..3)`,
  );
});

Deno.test("resolvePath: the paths that worked before give the same result", () => {
  assertEquals(get("pool.models[1].name"), { found: true, value: "b" });
  assertEquals(get("pool.models[*].size"), {
    found: true,
    value: [3, 7, 7, 1],
  });
  assertEquals(get("pool.models.0.{name,size}"), {
    found: true,
    value: { name: "a", size: 3 },
  });
  assertEquals(get("pool.models.length"), { found: true, value: 4 });
  // A key the old grammar reached literally is still that key, not a filter.
  const odd = { "x[?y]": 1, x: [{ y: true }], "": { z: 2 }, z: 3 };
  assertEquals(resolvePath(odd, "x[?y]"), { found: true, value: 1 });
  assertEquals(resolvePath(odd, ".z"), { found: true, value: 2 });
});

const REPO = join(import.meta.dirname!, "..");
const CONFIG = join(REPO, "deno.json");
const AM = join(REPO, "src/am.ts");
const MOD = new URL("../mod.ts", import.meta.url).href;

Deno.test({
  name: "am state: [?k=v] filters a live app's state; a miss prints the syntax",
  fn: async () => {
    const dir = await tempDir("aio-am-path-filter-");
    const env: Record<string, string> = {
      ...Deno.env.toObject(),
      ...await ownHome(dir),
      NO_COLOR: "1",
      AIO_AM_NO_DELEGATE: "1",
    };
    delete env.AIO_APPS_DIR;
    const port = freePort();
    await Deno.writeTextFile(
      join(dir, "app.ts"),
      `import { aio, cell } from "${spec(MOD)}";
const pool = cell("pool", { state: { models: ${
        JSON.stringify(MODELS)
      } }, methods: { unload(s, n) { s.models.find((m) => m.name === n).loaded = false; } } });
await aio.run({ cells: [pool], appId: "pathfilter", client: "server-only", port: ${port}, watch: false, baseDir: ${
        JSON.stringify(join(dir, "src-none"))
      } });
`,
    );
    const app = new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", "--config", CONFIG, join(dir, "app.ts")],
      env,
      clearEnv: true,
      cwd: dir,
      stdout: "null",
      stderr: "null",
    }).spawn();
    const am = async (...args: string[]) => {
      const o = await new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "-A",
          "--config",
          CONFIG,
          AM,
          ...args,
          `--port=${port}`,
          "--app=pathfilter",
        ],
        env,
        clearEnv: true,
        cwd: dir,
        stdout: "piped",
        stderr: "piped",
        signal: AbortSignal.timeout(60_000),
      }).output();
      const d = new TextDecoder();
      return {
        code: o.code,
        out: d.decode(o.stdout),
        all: d.decode(o.stdout) + d.decode(o.stderr),
      };
    };
    const up = async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/__aio/trojan/state`);
        await r.body?.cancel();
        return r.ok;
      } catch {
        return false; // aio-ok: not up yet — the caller polls
      }
    };
    try {
      for (let i = 0; i < 600 && !await up(); i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      assert(await up(), "the app never came up");
      const hit = await am("state", "pool.models[?loaded].name", "--json");
      assertEquals(hit.code, 0, hit.all);
      assertEquals(JSON.parse(hit.out), ["a", "c"]);
      const d = await am("dispatch", "pool:unload", "a", "--json");
      assertEquals(d.code, 0, d.all);
      const eq = await am(
        "state",
        'pool.models[?kind="llm"].{name,loaded}',
        "--json",
      );
      assertEquals(eq.code, 0, eq.all);
      assertEquals(JSON.parse(eq.out), [
        { name: "a", loaded: false },
        { name: "c", loaded: true },
      ]);
      const miss = await am("state", "pool.models[?lodaed]", "--json");
      assertEquals(miss.code, 1, miss.all);
      assertStringIncludes(JSON.parse(miss.out).error, PATH_SYNTAX);
      const ex = await am("expect", "pool.models[?loaded].name", "eq", '["c"]');
      assertEquals(ex.code, 0, ex.all);
    } finally {
      try {
        app.kill("SIGKILL");
      } catch { /* aio-ok: already ended */ }
      await app.status;
      await dropTempDir(dir);
    }
  },
});
