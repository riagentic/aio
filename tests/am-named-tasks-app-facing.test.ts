// Every `deno task <name>` that `am` tells an APP AUTHOR to run must be a task
// an `am create`d app has. tests/named-tasks-exist.test.ts accepts this repo's
// own tasks too (a message aimed at a contributor) — and that is how `am fix`
// shipped "run the aio linter: `deno task lint:aio`": `lint:aio` exists HERE,
// so the check passed, and in every app it answered "Task not found" (exit 1).
// An app's `lint` runs deno lint and aiol both. `am` speaks to app authors, so
// its strings are checked against the scaffold alone.
import "./store-sandbox.ts";
import { assert, assertEquals } from "@std/assert";
import { standardTasks } from "../src/am/am-cmd-create.ts";

const ROOT = new URL("../", import.meta.url);

/** `am lab`'s help names the framework repo's own lab tasks, on purpose: the
 *  labs are a contributor tool, documented as such there. */
const CONTRIBUTOR_ONLY = new Set(["test:wine", "lab"]);

const codeOnly = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").map((l) => {
    const i = l.indexOf("//");
    return i === -1 ? l : l.slice(0, i);
  }).join("\n");

Deno.test("am names only deno tasks a scaffolded app has", async () => {
  const tasks = new Set<string>();
  for (const t of ["browser", "electron", "android", "cli", "server"]) {
    for (const k of Object.keys(standardTasks(false, t as "browser"))) {
      tasks.add(k);
    }
  }
  assert(tasks.has("dev") && tasks.has("lint"), "the task set was read");
  const files = ["src/am.ts"];
  for (const e of Deno.readDirSync(new URL("src/am/", ROOT))) {
    if (e.name.endsWith(".ts")) files.push(`src/am/${e.name}`);
  }
  const bad: string[] = [];
  for (const f of files) {
    const code = codeOnly(await Deno.readTextFile(new URL(f, ROOT)));
    for (const m of code.matchAll(/deno task ([a-z][a-z0-9:-]*)/g)) {
      if (!tasks.has(m[1]!) && !CONTRIBUTOR_ONLY.has(m[1]!)) {
        bad.push(`${f} — \`deno task ${m[1]}\``);
      }
    }
  }
  assertEquals(bad, [], "am tells app authors to run tasks no app has");
});
