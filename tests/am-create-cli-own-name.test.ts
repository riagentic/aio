// The cli template's help and refusals name THE TOOL, not "todo". They were
// hard-coded: `am create mytool --template=cli` printed "usage: todo add …"
// and "no todo server running — start one: todo serve" — and there is no
// `todo` command. The name is the app's own id (its deno.json title), the
// same name the compiled binary gets. A real run of the scaffold.
import "./store-sandbox.ts";
import { assert, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { scaffold } from "../src/am/am-cmd-create.ts";
import { AIO_ENTRY_PATHS } from "../src/entries.ts";
import { spec } from "./module-spec-helper.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const ROOT = new URL("../", import.meta.url).pathname.replace(/\/$/, "");
const NAME = "aio-cli-own-name-probe";

Deno.test("cli template: usage and no-server refusals name the app, never 'todo'", async () => {
  const dir = await tempDir("aio-create-cli-name-");
  try {
    for (const [rel, content] of Object.entries(scaffold(NAME, "cli", true))) {
      if (rel === "deno.json") continue;
      const path = join(dir, rel);
      await Deno.mkdir(join(path, ".."), { recursive: true });
      await Deno.writeTextFile(path, content);
    }
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({
        title: NAME,
        imports: Object.fromEntries(
          Object.entries(AIO_ENTRY_PATHS).map((
            [k, v],
          ) => [k, `${spec(ROOT)}/${v}`]),
        ),
      }),
    );
    const run = async (...args: string[]) => {
      const o = await new Deno.Command(Deno.execPath(), {
        args: ["run", "-A", "--no-check", "src/app.ts", ...args],
        cwd: dir,
        stdout: "piped",
        stderr: "piped",
      }).output();
      return new TextDecoder().decode(o.stdout) +
        new TextDecoder().decode(o.stderr);
    };
    const usage = await run("add");
    assertStringIncludes(usage, `${NAME} add <text...>`);
    const noServer = await run("list");
    assertStringIncludes(noServer, `start one: ${NAME} serve`);
    const help = await run("--help");
    assertStringIncludes(help, NAME);
    for (const text of [usage, noServer, help]) {
      assert(!/\btodo (serve|add|done)\b/.test(text), text);
    }
  } finally {
    await dropTempDir(dir);
  }
});
