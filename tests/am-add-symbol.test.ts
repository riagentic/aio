// `am add cell|server <name>` must write a file that COMPILES for every name
// it accepts. The identifier was derived by folding only `-<letter>`, so
// `foo--bar` / `foo-` kept a `-`, and `export` / `import` / `cell` /
// `serverFns` were bound verbatim — a syntax or type error, and `am add
// server` imports the module from src/app.ts, so the app stopped booting.
import { assertEquals } from "@std/assert";
import { scaffoldSymbol } from "../src/am/am-cmd-meta.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { fromFileUrl } from "@std/path";
import { spec } from "./module-spec-helper.ts";

const REPO = fromFileUrl(new URL("..", import.meta.url));

Deno.test("scaffoldSymbol: a valid binding for every accepted name", () => {
  assertEquals(scaffoldSymbol("todo-list", "cell"), "todoList");
  assertEquals(scaffoldSymbol("a-1", "cell"), "a1");
  assertEquals(scaffoldSymbol("my_cell", "cell"), "my_cell");
  assertEquals(scaffoldSymbol("foo--bar", "cell"), "fooBar");
  assertEquals(scaffoldSymbol("foo-", "cell"), "foo");
  assertEquals(scaffoldSymbol("export", "cell"), "exportCell");
  assertEquals(scaffoldSymbol("cell", "cell"), "cellCell");
  assertEquals(scaffoldSymbol("import", "serverFns"), "importFns");
  assertEquals(scaffoldSymbol("serverFns", "serverFns"), "serverFnsFns");
  assertEquals(scaffoldSymbol("cell", "serverFns"), "cell");
});

Deno.test("am add: the generated modules type-check for awkward names", async () => {
  const dir = await tempDir("am-add-symbol-");
  try {
    await Deno.mkdir(`${dir}/src`, { recursive: true });
    await Deno.writeTextFile(
      `${dir}/deno.json`,
      JSON.stringify({
        imports: { aio: `${spec(REPO)}mod.ts` },
        compilerOptions: {
          lib: ["deno.ns", "deno.unstable", "dom", "dom.iterable"],
        },
      }),
    );
    await Deno.writeTextFile(`${dir}/src/app.ts`, `export {};\n`);
    const adds = [
      ["cell", "export"],
      ["cell", "foo--bar"],
      ["cell", "foo-"],
      ["cell", "cell"],
      ["server", "import"],
      ["server", "serverFns"],
    ];
    for (const a of adds) {
      const p = await new Deno.Command(Deno.execPath(), {
        args: ["run", "-A", `${REPO}src/am.ts`, "add", ...a],
        cwd: dir,
        env: { AIO_APPS_DIR: `${dir}/.aio-home` },
        stdout: "piped",
        stderr: "piped",
      }).output();
      assertEquals(p.code, 0, new TextDecoder().decode(p.stderr));
    }
    const check = await new Deno.Command(Deno.execPath(), {
      args: ["check", "src/"],
      cwd: dir,
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(
      check.code,
      0,
      "a generated module does not compile:\n" +
        new TextDecoder().decode(check.stderr),
    );
  } finally {
    await dropTempDir(dir);
  }
});
