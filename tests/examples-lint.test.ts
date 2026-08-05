// Every shipped example must pass the linter aio ships with.
//
// `.katana/examples.md`: examples are "correct and working", "up-to-date using
// latest aio API", "using optimal aio approach". Nothing checked that. The boot
// gate proves an example STARTS; type-check proves it COMPILES; neither notices
// an example that still carries config the framework retired, imports a symbol
// that moved, or writes a shape the current API deprecates. Examples are the
// code people copy, so drift there teaches the wrong thing at scale — and the
// linter already knows every one of those facts (`src/state/removals.ts` feeds
// it, so a FUTURE removal shows up here the day its row lands).
//
// What this found on arrival: all ten target examples still declared
// `"unstable": ["kv"]`, obsolete since alpha28 — aio's own examples carrying
// config aio's own linter flags.
//
// Bar: no ERRORS, no WARNINGS, and no `config`-area finding at any severity —
// obsolete config is exactly the drift that arrives as a HINT ("unstable: kv is
// no longer needed"), so a gate that only reads errors would have watched that
// one land. `build`-area findings are excluded (they are about the machine —
// esbuild/Electron not installed — not the code), matching
// `tests/scaffold-lints-clean.test.ts`, and two config hints are allowlisted
// below because they are inherent to a build smoke fixture, not drift.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { lint } from "../aiol/mod.ts";

const ROOT = new URL("..", import.meta.url).pathname;

/** The only config hints an example may carry: `examples/targets/*` exist to be
 *  BUILT and BOOTED by CI, not to be a template — they have no test suite and
 *  one `compile` task rather than per-target ones. Everything else in the
 *  config area is drift and fails the gate. */
const ALLOWED_HINTS = [
  'no "test" task',
  "no compile tasks defined",
];

/** Every example app: a directory under examples/ (or examples/targets/) that
 *  holds TypeScript sources. Discovered, never typed out — a new example is
 *  covered the moment it lands. */
function discoverExamples(): string[] {
  const out: string[] = [];
  const hasSource = (dir: string): boolean => {
    for (const e of Deno.readDirSync(dir)) {
      if (e.isFile && /\.tsx?$/.test(e.name)) return true;
      if (
        e.isDirectory && e.name !== "node_modules" && !e.name.startsWith(".")
      ) {
        if (hasSource(join(dir, e.name))) return true;
      }
    }
    return false;
  };
  const scan = (rel: string) => {
    for (const e of Deno.readDirSync(join(ROOT, rel))) {
      if (!e.isDirectory || e.name.startsWith(".")) continue;
      const dir = `${rel}/${e.name}`;
      if (rel === "examples" && e.name === "targets") {
        scan(dir);
        continue;
      }
      if (hasSource(join(ROOT, dir))) out.push(dir);
    }
  };
  scan("examples");
  return out.sort();
}

async function copyDir(from: string, to: string): Promise<void> {
  for (const e of Deno.readDirSync(from)) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const s = join(from, e.name), d = join(to, e.name);
    if (e.isDirectory) {
      Deno.mkdirSync(d, { recursive: true });
      await copyDir(s, d);
    } else await Deno.copyFile(s, d);
  }
}

/** The import map an in-repo example resolves against, with every relative
 *  specifier made absolute so the example can be linted from a temp dir. */
function repoImports(): Record<string, string> {
  const cfg = JSON.parse(Deno.readTextFileSync(join(ROOT, "deno.json"))) as {
    imports: Record<string, string>;
  };
  return Object.fromEntries(
    Object.entries(cfg.imports).map((
      [k, v],
    ) => [k, v.startsWith("./") ? ROOT + v.slice(2) : v]),
  );
}

/** Lint one example the way a user would meet it. `examples/targets/*` carry
 *  their own deno.json and are linted in place. The four template/worked
 *  examples deliberately don't (they run against the repo's map, from inside
 *  the repo), so they are linted in a copy that carries exactly that map —
 *  otherwise every finding would be about the deno.json they don't have. */
async function lintExample(dir: string): Promise<string[]> {
  const src = join(ROOT, dir);
  let target = src;
  let tmp: string | null = null;
  try {
    Deno.statSync(join(src, "deno.json"));
  } catch {
    tmp = await Deno.makeTempDir({ prefix: "aiol-example-" });
    await copyDir(src, tmp);
    const name = dir.split("/").pop()!;
    await Deno.writeTextFile(
      join(tmp, "deno.json"),
      JSON.stringify(
        {
          title: name,
          version: "0.1.0",
          nodeModulesDir: "auto",
          compilerOptions: { jsx: "react-jsx", jsxImportSource: "aio" },
          imports: repoImports(),
          tasks: { dev: "deno run -A app.ts", test: "deno test -A tests/" },
        },
        null,
        2,
      ),
    );
    target = tmp;
  }
  try {
    const report = await lint(target);
    return report.issues
      .filter((i) =>
        i.area !== "build" && (i.severity !== "hint" || i.area === "config") &&
        !ALLOWED_HINTS.some((a) => i.message.includes(a))
      )
      .map((i) => `${i.severity} [${i.area}] ${i.message}`);
  } finally {
    if (tmp) await Deno.remove(tmp, { recursive: true });
  }
}

const EXAMPLES = discoverExamples();

Deno.test("examples: the lint gate covers every example", () => {
  // A guard on the guard — a broken scan would make this file pass by linting
  // nothing. Every target in `.katana/examples.md` has an example, and the
  // template + worked examples are all here.
  for (
    const must of [
      "examples/counter",
      "examples/todo",
      "examples/contacts",
      "examples/disk",
      ...[
        "browser",
        "browser-remote",
        "electron",
        "electron-remote",
        "cli",
        "cli-remote",
        "android",
        "android-remote",
        "service",
        "service-remote",
      ].map((t) => `examples/targets/${t}`),
    ]
  ) {
    assert(
      EXAMPLES.includes(must),
      `${must} is not covered by the example lint gate (found: ${
        EXAMPLES.join(", ")
      })`,
    );
  }
});

for (const dir of EXAMPLES) {
  Deno.test(`example ${dir}: lints clean`, async () => {
    assertEquals(
      await lintExample(dir),
      [],
      `${dir} is flagged by the linter it ships with`,
    );
  });
}
