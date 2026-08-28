// A refusal that names a command which does not exist is worse than no advice.
//
// The framework's own messages tell app authors what to run — and several
// named the RETIRED per-target task matrix that alpha52 deleted:
// `deno task dev:android`, `compile:android`, `dev:electron`,
// `compile:electron`. A scaffolded app has none of them, so following the hint
// produced `Task not found`, which reads as "aio is broken" rather than "that
// hint is stale". `.katana/updates.md` states the rule for the release path —
// "the commands printed are the commands that work, on every surface that
// prints them" — and it is no less true of every other surface.
//
// So: every `deno task <name>` that appears in a STRING in src/ must name a
// task that exists, either in this repo's deno.json (a message aimed at a
// contributor) or in what `am create` scaffolds (a message aimed at an app
// author). Comments are exempt — they are for the reader of the code, and
// several deliberately name a retired spelling to explain why it is gone.
import { assert, assertEquals } from "@std/assert";
import { standardTasks } from "../src/am/am-cmd-create.ts";

const ROOT = new URL("..", import.meta.url).pathname;

async function* walk(dir: string): AsyncGenerator<string> {
  for await (const e of Deno.readDir(dir)) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory) yield* walk(p);
    else if (/\.tsx?$/.test(e.name)) yield p;
  }
}

/** Strip line and block comments, so a retired name explained in prose is not
 *  read as advice. Crude on purpose: it only has to be right about which lines
 *  are code, and a false EXEMPTION is the only dangerous direction — so a `//`
 *  inside a string (a URL) costs us a missed check, never a false alarm. */
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => {
      const i = l.indexOf("//");
      return i === -1 ? l : l.slice(0, i);
    })
    .join("\n");
}

Deno.test("every `deno task X` a message names is a task that exists", async () => {
  const repo = JSON.parse(
    await Deno.readTextFile(`${ROOT}deno.json`),
  ) as { tasks: Record<string, string> };
  // Every target's scaffold, unioned: a message may speak to any app.
  const scaffolded = new Set<string>();
  for (const t of ["browser", "electron", "android", "cli", "server"]) {
    for (
      const k of Object.keys(
        standardTasks(false, t as "browser"),
      )
    ) scaffolded.add(k);
  }
  const known = new Set([...Object.keys(repo.tasks), ...scaffolded]);
  assert(known.has("dev") && known.has("build"), "the task sets were read");

  const bad: string[] = [];
  for await (const f of walk(`${ROOT}src`)) {
    if (!/\.tsx?$/.test(f)) continue;
    const rel = f.slice(ROOT.length);
    const code = codeOnly(await Deno.readTextFile(f));
    for (const m of code.matchAll(/deno task ([a-z][a-z0-9:-]*)/g)) {
      const name = m[1]!;
      if (!known.has(name)) {
        const line = code.slice(0, m.index).split("\n").length;
        bad.push(`${rel}:${line} — \`deno task ${name}\``);
      }
    }
  }
  assertEquals(
    bad,
    [],
    `these messages name a task nobody has. A hint that fails with "Task not ` +
      `found" reads as a broken framework, not a stale hint:\n  ` +
      bad.join("\n  ") +
      `\n\nKnown: ${[...known].sort().join(", ")}`,
  );
});
