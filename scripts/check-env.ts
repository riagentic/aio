#!/usr/bin/env -S deno run --allow-read
// check-env.ts — every environment variable `src/` reads is documented, on the
// page that promises to list them all.
//
// A variable that works and is documented nowhere is a feature only its author
// can use. `AIO_BUILD_VERSION` is the supported way a parent build hands a
// version to a child; it worked perfectly and appeared in one comment inside
// aio's own fleet code, so a field report found it by reading the build source
// after shipping three artifacts whose file name, manifest and stamp disagreed.
//
// The rule: if `src/` reads `AIO_FOO`, `docs/build/environment.md` names it.
// That is the whole gate — it cannot check that the prose is GOOD, but it can
// make "nobody wrote it down" impossible, which is the failure that actually
// happened.
//
// TWO WAYS THIS GATE USED TO MISS THE THING IT EXISTS FOR:
//
//  1. It matched only `Deno.env.get("LITERAL")`. Its own motivating case is
//     read as `Deno.env.get(BUILD_VERSION_ENV)` in three files, and a variable
//     behind a wrapper (`safeEnv("AIO_DISCOVERY_PORT")`) was equally invisible
//     — deleting either row from the docs left the gate reporting "all
//     documented". So a name now counts as read when it is an `AIO_*` string
//     literal passed to ANY call (which covers every wrapper without this
//     script having to know their names), a `process.env.AIO_*` access, or an
//     identifier the project resolves to an `AIO_*` literal.
//  2. It accepted the name on ANY page under `docs/`. `AIO_DISCOVERY_PORT`
//     appeared only on the Electron client page while
//     `docs/build/environment.md` opened with "Every `AIO_*` variable the
//     framework reads, in one table" — a promise the gate did not hold anyone
//     to. The page that makes the promise is the page that is checked.
//
// Non-aio variables (HOME, TMPDIR, CI, ANDROID_HOME…) are the platform's, not
// ours to document — they are listed on the page anyway, and this gate only
// requires the `AIO_*` ones.
const HERE = new URL("..", import.meta.url).pathname;
/** THE page — the one that promises to name every variable. */
const PAGE = "docs/build/environment.md";

/** Every `.ts` file under `src/`, as text. */
export async function sources(
  root: string = HERE,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const walk = async (dir: string): Promise<void> => {
    for await (const e of Deno.readDir(dir)) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory) await walk(p);
      else if (e.name.endsWith(".ts")) out.set(p, await Deno.readTextFile(p));
    }
  };
  await walk(`${root}src`);
  return out;
}

/** `const BUILD_VERSION_ENV = "AIO_BUILD_VERSION"` — project-wide, because the
 *  constant and the read are routinely in different files (that IS the case
 *  the gate missed). Last definition wins; a name bound twice to different
 *  values would be its own bug. */
export function envConstants(
  files: Map<string, string>,
): Map<string, string> {
  const consts = new Map<string, string>();
  for (const text of files.values()) {
    for (
      const m of text.matchAll(
        /\b([A-Za-z_$][\w$]*)\s*=\s*["'`](AIO_[A-Z0-9_]*)["'`]/g,
      )
    ) consts.set(m[1]!, m[2]!);
  }
  return consts;
}

/** Every `AIO_*` name ONE file reads. Pure — `tests/check-env-gate.test.ts`
 *  drives it directly, because a gate nobody points at its own blind spot is
 *  how this one reported "all documented" while missing its motivating case. */
export function envNamesIn(
  text: string,
  consts: Map<string, string> = new Map(),
): string[] {
  const names = new Set<string>();
  const hit = (name: string) => {
    if (name.startsWith("AIO_")) names.add(name);
  };
  // (a) An `AIO_*` literal passed to any call — `Deno.env.get("AIO_PORT")`,
  //     `safeEnv("AIO_DISCOVERY_PORT")`, `env("AIO_SUPERVISED")`. Naming the
  //     accessors instead is how a wrapper slips through.
  //     Quoted with ' or " only: a comment writing prose about a variable
  //     spells it as a backtick code span — (`AIO_DDL_STEPS`) in a doc
  //     comment is not a read, and a gate that cries about one gets ignored.
  for (const m of text.matchAll(/\(\s*["'](AIO_[A-Z0-9_]*)["']/g)) hit(m[1]!);
  // (b) `process.env.AIO_FOO` / `process.env["AIO_FOO"]` — the Electron main
  //     script is Node.
  for (
    const m of text.matchAll(/process\.env(?:\.|\[\s*["'`])([A-Z][A-Z0-9_]*)/g)
  ) hit(m[1]!);
  // (c) An identifier handed to an env accessor, resolved through the
  //     constants above. An identifier that resolves to nothing is a genuinely
  //     dynamic read (`Deno.env.get(name)` inside a wrapper) — its callers pass
  //     literals, which rule (a) already caught, so it is not an error here.
  for (
    const m of text.matchAll(
      /(?:Deno\.env\.(?:get|has|set)\(|process\.env\[)\s*([A-Za-z_$][\w$]*)/g,
    )
  ) {
    const resolved = consts.get(m[1]!);
    if (resolved) hit(resolved);
  }
  return [...names];
}

/** Every `AIO_*` name read anywhere under `src/`, with where it was read. */
export async function readVars(
  root: string = HERE,
): Promise<Map<string, string[]>> {
  const files = await sources(root);
  const consts = envConstants(files);
  const found = new Map<string, string[]>();
  for (const [p, text] of files) {
    const at = p.slice(root.length);
    for (const name of envNamesIn(text, consts)) {
      const list = found.get(name) ?? [];
      if (!list.includes(at)) list.push(at);
      found.set(name, list);
    }
  }
  return found;
}

/** The names `page` does not name, sorted. `page` is THE page — a mention on
 *  some other doc is where a reader ends up AFTER the table told them the
 *  variable exists, which is why the table is what is checked. */
export function missingFrom(
  vars: Map<string, string[]>,
  page: string,
): [string, string[]][] {
  // Whole-name match: `page.includes("AIO_DEV")` is satisfied by a row for
  // `AIO_DEV_SUPERVISED`, which is a different variable — the substring test
  // documented one and excused the other.
  const named = (name: string) => new RegExp(`${name}(?![A-Z0-9_])`).test(page);
  return [...vars.entries()]
    .filter(([name]) => !named(name))
    .sort(([a], [b]) => a < b ? -1 : 1);
}

if (import.meta.main) {
  const vars = await readVars();
  const page = await Deno.readTextFile(HERE + PAGE);
  const missing = missingFrom(vars, page);

  if (missing.length > 0) {
    console.error(
      `✗ ${missing.length} environment variable(s) read by src/ are not ` +
        `named on ${PAGE}:\n`,
    );
    for (const [name, at] of missing) {
      console.error(`  ${name}\n      read in ${at.join(", ")}`);
    }
    console.error(
      `\n  Add each to ${PAGE} — that page promises "every AIO_* variable ` +
        `the framework reads, in one table", and a variable nobody wrote ` +
        `down is a feature only its author can use. Another page may explain ` +
        `it further; the table is where readers are told it exists.`,
    );
    Deno.exit(1);
  }
  console.log(
    `✓ env: ${vars.size} AIO_* variable(s) read by src/, all named on ${PAGE}`,
  );
}
