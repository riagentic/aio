#!/usr/bin/env -S deno run --allow-read
// check-env.ts — every environment variable `src/` reads is documented.
//
// A variable that works and is documented nowhere is a feature only its author
// can use. `AIO_BUILD_VERSION` is the supported way a parent build hands a
// version to a child; it worked perfectly and appeared in one comment inside
// aio's own fleet code, so a field report found it by reading the build source
// after shipping three artifacts whose file name, manifest and stamp disagreed.
//
// The rule: if `src/` reads `AIO_FOO`, some page under `docs/` names it. That
// is the whole gate — it cannot check that the prose is GOOD, but it can make
// "nobody wrote it down" impossible, which is the failure that actually
// happened.
//
// Non-aio variables (HOME, TMPDIR, CI, ANDROID_HOME…) are the platform's, not
// ours to document — they are listed on the page anyway, and this gate only
// requires the `AIO_*` ones.
const HERE = new URL("..", import.meta.url).pathname;

/** Every `AIO_*` name read anywhere under `src/`, with where it was read. */
async function readVars(): Promise<Map<string, string[]>> {
  const found = new Map<string, string[]>();
  const walk = async (dir: string): Promise<void> => {
    for await (const e of Deno.readDir(dir)) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory) {
        await walk(p);
      } else if (e.name.endsWith(".ts")) {
        const text = await Deno.readTextFile(p);
        // Both spellings: Deno.env.get("X") and process.env.X (the Electron
        // main script is Node, and it reads AIO_PARENT_PID that way).
        for (
          const m of text.matchAll(
            /(?:Deno\.env\.get\(\s*["'`]|process\.env\.)([A-Z][A-Z0-9_]*)/g,
          )
        ) {
          const name = m[1]!;
          if (!name.startsWith("AIO_")) continue;
          const at = p.slice(HERE.length);
          const list = found.get(name) ?? [];
          if (!list.includes(at)) list.push(at);
          found.set(name, list);
        }
      }
    }
  };
  await walk(`${HERE}src`);
  return found;
}

/** Everything the docs mention, as one blob — a name is documented if any page
 *  contains it. */
async function documented(): Promise<string> {
  let all = "";
  const walk = async (dir: string): Promise<void> => {
    for await (const e of Deno.readDir(dir)) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory) await walk(p);
      else if (e.name.endsWith(".md")) all += await Deno.readTextFile(p);
    }
  };
  await walk(`${HERE}docs`);
  return all;
}

const vars = await readVars();
const docs = await documented();
const missing = [...vars.entries()]
  .filter(([name]) => !docs.includes(name))
  .sort(([a], [b]) => a < b ? -1 : 1);

if (missing.length > 0) {
  console.error(
    `✗ ${missing.length} environment variable(s) read by src/ appear in no ` +
      `doc:\n`,
  );
  for (const [name, at] of missing) {
    console.error(`  ${name}\n      read in ${at.join(", ")}`);
  }
  console.error(
    `\n  Add each to docs/build/environment.md — a variable nobody wrote ` +
      `down is a feature only its author can use.`,
  );
  Deno.exit(1);
}
console.log(
  `✓ env: ${vars.size} AIO_* variable(s) read by src/, all documented`,
);
