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
import { lintProject } from "../aiol/mod.ts";

const ROOT = new URL("..", import.meta.url).pathname;

/** The only config hints an example may carry: `examples/targets/*` exist to be
 *  BUILT and BOOTED by CI, not to be a template — they have no test suite.
 *  Everything else in the config area is drift and fails the gate.
 *
 *  `"no build task defined"` used to sit here too. It was allowlisting away
 *  the one finding that described a real gap: the ten target examples carried
 *  the pre-alpha52 `compile` form and no `build` task at all, so aio's own
 *  fixtures were a generation behind the vocabulary aio scaffolds. (It was
 *  also dead weight — the linter counts `compile` as a build task — which is
 *  how it survived: an allowlist entry that never matches is invisible.) They
 *  now carry both, from the fleet pipeline. */
const ALLOWED_HINTS = [
  'no "test" task',
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
          // The standard task vocabulary, so the lint verdict is about the
          // EXAMPLE and not about a synthetic config missing a build task.
          tasks: {
            dev: "deno run -A app.ts",
            test: "deno test -A tests/",
            build:
              `deno run -A ${ROOT}src/build-all.ts --build-spec=${ROOT}src/build.ts`,
          },
        },
        null,
        2,
      ),
    );
    target = tmp;
  }
  try {
    const report = await lintProject(target);
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

// ── target-example parity ────────────────────────────────────────────────────
//
// `examples/targets/electron-remote/` shipped with NO `src/App.tsx` while its
// twin `android-remote/` had one — the two are the same app in two shells, and
// nothing noticed they had diverged. The runtime test named "boots + serves
// connect page" asserted `html.includes("<")` and stayed green over a client
// that could never mount (see tests/examples.test.ts).
//
// A per-file assertion would have caught that one file. This asserts the SHAPE
// every UI-serving fixture must have, so the next missing one is caught the day
// the directory lands.

/** Fixtures whose client is a WebView/browser and therefore MUST render a
 *  component. The headless ones (cli*, service*) are excluded by name — the
 *  same rule aiol applies via `client: "server-only" | "cli"`. */
const UI_TARGETS = [
  "browser",
  "browser-remote",
  "electron",
  "electron-remote",
  "android",
  "android-remote",
];

/** The two thin clients: no local app, just a page that asks for a server URL.
 *  They are one app in two shells and must not drift apart. */
const CONNECT_TARGETS = ["electron-remote", "android-remote"];

for (const t of UI_TARGETS) {
  Deno.test(`example targets/${t}: serves a component`, () => {
    const dir = join(ROOT, "examples/targets", t);
    const app = join(dir, "src/App.tsx");
    assert(
      Deno.statSync(app).isFile,
      `examples/targets/${t}/src/App.tsx is missing — the framework shell ` +
        `imports /App.tsx, so without it the page 404s on its own mount and ` +
        `the client renders nothing. Add it (see targets/android-remote).`,
    );
    const src = Deno.readTextFileSync(app);
    assert(
      /export default function/.test(src),
      `examples/targets/${t}/src/App.tsx has no default export — the shell ` +
        `has nothing to render.`,
    );
    const cfg = JSON.parse(
      Deno.readTextFileSync(join(dir, "deno.json")),
    ) as { compilerOptions?: { jsx?: string; jsxImportSource?: string } };
    assertEquals(
      [cfg.compilerOptions?.jsx, cfg.compilerOptions?.jsxImportSource],
      ["react-jsx", "aio"],
      `examples/targets/${t}/deno.json must declare aio's JSX runtime — a ` +
        `.tsx file without it does not type-check against the framework.`,
    );
  });
}

Deno.test("example targets: the two connect-page clients stay in step", () => {
  const read = (t: string) =>
    Deno.readTextFileSync(
      join(ROOT, "examples/targets", t, "src/App.tsx"),
    ).replace(/ex-[a-z-]+/g, "<name>");
  const [a, b] = CONNECT_TARGETS.map(read);
  assertEquals(
    a,
    b,
    `${CONNECT_TARGETS.join(" and ")} are the same connect page in two ` +
      `shells; they have drifted. Keep them identical apart from the app name.`,
  );
});

// ── the command aio documents as broken must not ship in aio's own examples ──
//
// `src/electron-install.ts` opens by naming `deno install
// --allow-scripts=npm:electron` as "the command that DOES NOT RELIABLY WORK":
// it exits 0 having SKIPPED the lifecycle script whenever deno decides the
// package is not newly added, leaving no `dist/`, so the build then advises
// running the very task that just did nothing. `am fix` repairs it in user
// apps. Both electron examples shipped it anyway, with `examples/README.md`
// pointing readers straight at them.
Deno.test("examples: no example ships the broken electron install command", () => {
  const offenders: string[] = [];
  for (const t of Deno.readDirSync(join(ROOT, "examples/targets"))) {
    if (!t.isDirectory) continue;
    const p = join(ROOT, "examples/targets", t.name, "deno.json");
    const cfg = JSON.parse(Deno.readTextFileSync(p)) as {
      tasks?: Record<string, string>;
    };
    for (const [name, cmd] of Object.entries(cfg.tasks ?? {})) {
      if (/deno install\b[^\n]*\belectron\b/.test(cmd)) {
        offenders.push(`examples/targets/${t.name} → ${name}: ${cmd}`);
      }
    }
  }
  // amui is an aio app in this repo too, and it carried the same task.
  const amui = JSON.parse(
    Deno.readTextFileSync(join(ROOT, "amui/deno.json")),
  ) as { tasks?: Record<string, string> };
  for (const [name, cmd] of Object.entries(amui.tasks ?? {})) {
    if (/deno install\b[^\n]*\belectron\b/.test(cmd)) {
      offenders.push(`amui → ${name}: ${cmd}`);
    }
  }
  assertEquals(
    offenders,
    [],
    "use aio's own installer (`deno run -A <aio>/src/electron-install.ts`) — " +
      "`deno install --allow-scripts=npm:electron` exits 0 leaving no dist/",
  );
});
