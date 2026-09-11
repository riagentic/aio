// Every example must be able to BUILD, not just run.
//
// Five of six could not. `am create` scaffolds `src/app.ts` and five examples
// still carried the flat layout from an older era, so `deno task build` in them
// refused with "src/App.tsx not found — the app dir is the entry's directory".
// Each one declares `build.targets` in its own deno.json, so each one advertises
// a build it could not do, and nothing in the suite ever asked.
//
// The cheap half of the question — does the declared entry resolve? — is what
// every one of those five got wrong, and it costs milliseconds. Running the
// real builds belongs to `test:build`; this is the gate that makes the failure
// impossible to reintroduce without seeing it.
import { assert, assertEquals } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import { DEFAULT_ENTRY } from "../src/server/app-files.ts";

const REPO = dirname(dirname(fromFileUrl(import.meta.url)));
const EXAMPLES = join(REPO, "examples");

type Example = { name: string; dir: string; json: Record<string, unknown> };

async function examples(): Promise<Example[]> {
  const out: Example[] = [];
  for await (const e of Deno.readDir(EXAMPLES)) {
    if (!e.isDirectory) continue;
    const dir = join(EXAMPLES, e.name);
    const text = await Deno.readTextFile(join(dir, "deno.json")).catch(() =>
      null
    );
    if (text === null) continue;
    out.push({ name: e.name, dir, json: JSON.parse(text) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

Deno.test("every example's build entry resolves to a real file", async () => {
  const all = await examples();
  assert(
    all.length >= 5,
    `expected the examples to be there, saw ${all.length}`,
  );
  const broken: string[] = [];
  for (const ex of all) {
    const entry = typeof ex.json.entry === "string"
      ? ex.json.entry
      : DEFAULT_ENTRY;
    const path = join(ex.dir, entry);
    const ok = await Deno.stat(path).then((s) => s.isFile).catch(() => false);
    if (!ok) broken.push(`${ex.name}: entry "${entry}" → ${path} is not there`);
  }
  assertEquals(
    broken,
    [],
    `an example that cannot build is an example nobody can copy:\n  ` +
      broken.join("\n  "),
  );
});

Deno.test("every example's dev task points at its real entry", async () => {
  // The other half of the same mistake: moving the entry and leaving the task
  // behind gives an example that builds and will not run.
  const broken: string[] = [];
  for (const ex of await examples()) {
    const tasks = (ex.json.tasks ?? {}) as Record<string, string>;
    const dev = tasks.dev;
    if (typeof dev !== "string") continue;
    const m = /deno run -A (\S+\.ts)/.exec(dev);
    if (!m) continue;
    const path = join(ex.dir, m[1]!);
    const ok = await Deno.stat(path).then((s) => s.isFile).catch(() => false);
    if (!ok) {
      broken.push(`${ex.name}: dev task runs "${m[1]}", which is not there`);
    }
  }
  assertEquals(broken, [], broken.join("\n  "));
});

Deno.test("the UI entry sits beside the app entry, where dev AND prod look", async () => {
  // WYSIDIWYSIP: the app dir is the entry's directory for both the dev server
  // and the build. An App.tsx anywhere else is served by neither.
  const broken: string[] = [];
  for (const ex of await examples()) {
    const entry = typeof ex.json.entry === "string"
      ? ex.json.entry
      : DEFAULT_ENTRY;
    const appDir = dirname(join(ex.dir, entry));
    const uiEntry = typeof ex.json.uiEntry === "string"
      ? ex.json.uiEntry
      : "App.tsx";
    const hasUi = await Deno.stat(join(appDir, uiEntry)).then((s) => s.isFile)
      .catch(() => false);
    // A headless example (cli/service) legitimately has no UI entry; it says so
    // by not listing a UI-bearing build target.
    const targets = ((ex.json.build ?? {}) as { targets?: string[] }).targets ??
      [];
    const needsUi = targets.some((t) =>
      t === "browser" || t === "electron" || t === "android"
    );
    if (needsUi && !hasUi) {
      broken.push(
        `${ex.name}: targets ${
          targets.join("/")
        } but no ${uiEntry} in ${appDir}`,
      );
    }
  }
  assertEquals(broken, [], broken.join("\n  "));
});
