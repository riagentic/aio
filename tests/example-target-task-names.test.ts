// The target fixtures' header comments named tasks that no longer exist —
// `compile:browser:remote`, `compile:android`, … (the pre-alpha52 per-target
// matrix). Each fixture has ONE `compile` task that passes `--targets=<t>`. A
// comment that sends a reader to `deno task compile:browser:remote` gets
// "task not found", so every task a fixture's entry names must be real.
import { assert, assertEquals } from "@std/assert";

const ROOT = new URL("../examples/targets/", import.meta.url);

Deno.test("target fixtures name only tasks their deno.json defines", async () => {
  const dirs: string[] = [];
  for await (const e of Deno.readDir(ROOT)) {
    if (e.isDirectory) dirs.push(e.name);
  }
  assert(dirs.length >= 9, `fixtures found: ${dirs.join(", ")}`);
  const bad: string[] = [];
  for (const d of dirs.sort()) {
    const tasks = Object.keys(
      JSON.parse(await Deno.readTextFile(new URL(`${d}/deno.json`, ROOT)))
        .tasks ?? {},
    );
    let src = "";
    const walk = async (dir: URL): Promise<void> => {
      for await (const e of Deno.readDir(dir)) {
        if (e.isDirectory) await walk(new URL(`${e.name}/`, dir));
        else if (/\.tsx?$/.test(e.name)) {
          src += await Deno.readTextFile(new URL(e.name, dir));
        }
      }
    };
    await walk(new URL(`${d}/src/`, ROOT));
    assert(src.length > 0, `${d} has sources`);
    // `deno task <name>` anywhere, and any backticked `compile:…`/`dev:…`.
    const named = [
      ...[...src.matchAll(/deno task ([\w:-]+)/g)].map((m) => m[1]!),
      ...[...src.matchAll(/`((?:compile|dev|build):[\w:-]+)`/g)].map((m) =>
        m[1]!
      ),
    ];
    for (const t of named) {
      if (!tasks.includes(t)) bad.push(`${d}/src names "${t}"`);
    }
  }
  assertEquals(bad, []);
});
