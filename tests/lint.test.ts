import { assertEquals } from "@std/assert";
import { lint } from "../src/server/aio.ts";
import { join } from "@std/path";

async function withTmpDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("lint: passes with valid state + config + App.tsx", async () => {
  await withTmpDir(async (dir) => {
    await Deno.writeTextFile(
      join(dir, "App.tsx"),
      "export default function App() { return <div/> }",
    );
    const r = await lint(
      { count: 0 },
      { reduce: () => {}, execute: () => {} },
      dir,
    );
    assertEquals(r.fail.length, 0);
    assertEquals(r.ok.includes("App.tsx"), true);
    assertEquals(r.ok.includes("reduce"), true);
  });
});

Deno.test("lint: fails on null state", async () => {
  await withTmpDir(async (dir) => {
    await Deno.writeTextFile(
      join(dir, "App.tsx"),
      "export default function App() {}",
    );
    const r = await lint(null, { reduce: () => {}, execute: () => {} }, dir);
    assertEquals(r.fail.some((f) => f.includes("null")), true);
  });
});

Deno.test("lint: fails when reduce is not a function", async () => {
  await withTmpDir(async (dir) => {
    await Deno.writeTextFile(
      join(dir, "App.tsx"),
      "export default function App() {}",
    );
    const r = await lint({}, { reduce: "nope", execute: () => {} }, dir);
    assertEquals(r.fail.some((f) => f.includes("reduce")), true);
  });
});

Deno.test("lint: warns when App.tsx missing export default", async () => {
  await withTmpDir(async (dir) => {
    await Deno.writeTextFile(join(dir, "App.tsx"), "function App() {}");
    const r = await lint({}, { reduce: () => {}, execute: () => {} }, dir);
    assertEquals(r.warn.some((w) => w.includes("export default")), true);
  });
});

Deno.test("lint: hints on createRoot in App.tsx", async () => {
  await withTmpDir(async (dir) => {
    await Deno.writeTextFile(
      join(dir, "App.tsx"),
      "export default function App() { createRoot() }",
    );
    const r = await lint({}, { reduce: () => {}, execute: () => {} }, dir);
    assertEquals(r.hint.some((h) => h.includes("createRoot")), true);
  });
});

Deno.test("lint: hints on import React in App.tsx", async () => {
  await withTmpDir(async (dir) => {
    await Deno.writeTextFile(
      join(dir, "App.tsx"),
      "import React from 'react'\nexport default function App() {}",
    );
    const r = await lint({}, { reduce: () => {}, execute: () => {} }, dir);
    assertEquals(r.hint.some((h) => h.includes("import React")), true);
  });
});

Deno.test("lint: fails when App.tsx missing", async () => {
  await withTmpDir(async (dir) => {
    const r = await lint({}, { reduce: () => {}, execute: () => {} }, dir);
    assertEquals(r.fail.some((f) => f.includes("App.tsx not found")), true);
  });
});

Deno.test("lint: prod mode skips App.tsx check", async () => {
  await withTmpDir(async (dir) => {
    const r = await lint(
      {},
      { reduce: () => {}, execute: () => {} },
      dir,
      true,
    );
    assertEquals(r.fail.length, 0);
    assertEquals(r.ok.includes("prod"), true);
  });
});

Deno.test("lint: hints on old dep/aio import paths", async () => {
  await withTmpDir(async (dir) => {
    await Deno.writeTextFile(
      join(dir, "App.tsx"),
      "export default function App() {}",
    );
    await Deno.writeTextFile(
      join(dir, "actions.ts"),
      "import { msg } from '../dep/aio/mod.ts'",
    );
    const r = await lint({}, { reduce: () => {}, execute: () => {} }, dir);
    assertEquals(r.hint.some((h) => h.includes("import from 'aio'")), true);
  });
});

Deno.test("lint: warns on $p/$d reserved state keys with rename suggestion", async () => {
  await withTmpDir(async (dir) => {
    await Deno.writeTextFile(
      join(dir, "App.tsx"),
      "export default function App() {}",
    );
    const r = await lint({ $p: "bad", count: 0 }, {
      reduce: () => {},
      execute: () => {},
    }, dir);
    assertEquals(r.warn.some((w) => w.includes("$p")), true);
    assertEquals(r.warn.some((w) => w.includes("rename")), true);
  });
});

Deno.test("lint: App.tsx error shows exact filepath", async () => {
  await withTmpDir(async (dir) => {
    const r = await lint({}, { reduce: () => {}, execute: () => {} }, dir);
    assertEquals(r.fail.some((f) => f.includes(join(dir, "App.tsx"))), true);
  });
});

Deno.test("lint: hints on execute param order (first param named effect)", async () => {
  await withTmpDir(async (dir) => {
    await Deno.writeTextFile(
      join(dir, "App.tsx"),
      "export default function App() {}",
    );
    await Deno.writeTextFile(
      join(dir, "execute.ts"),
      "export function execute(effect, app) {}",
    );
    const r = await lint({}, { reduce: () => {}, execute: () => {} }, dir);
    assertEquals(r.hint.some((h) => h.includes("execute(app, effect)")), true);
  });
});

Deno.test("lint: no hint when execute param order is correct", async () => {
  await withTmpDir(async (dir) => {
    await Deno.writeTextFile(
      join(dir, "App.tsx"),
      "export default function App() {}",
    );
    await Deno.writeTextFile(
      join(dir, "execute.ts"),
      "export function execute(app, effect) {}",
    );
    const r = await lint({}, { reduce: () => {}, execute: () => {} }, dir);
    assertEquals(r.hint.some((h) => h.includes("execute(app, effect)")), false);
  });
});

Deno.test("lint: warns on npm import in .tsx that won't work in browser", async () => {
  await withTmpDir(async (dir) => {
    await Deno.writeTextFile(
      join(dir, "App.tsx"),
      "import { marked } from 'marked'\nexport default function App() {}",
    );
    const r = await lint({}, { reduce: () => {}, execute: () => {} }, dir);
    assertEquals(
      r.warn.some((w) =>
        w.includes('"marked"') && w.includes("won't work in browser")
      ),
      true,
    );
  });
});

Deno.test("lint: no warn for aio imports in .tsx", async () => {
  await withTmpDir(async (dir) => {
    await Deno.writeTextFile(
      join(dir, "App.tsx"),
      "import { useAio } from 'aio'\nimport { signal } from 'aio/air'\nexport default function App() {}",
    );
    const r = await lint({}, { reduce: () => {}, execute: () => {} }, dir);
    assertEquals(
      r.warn.some((w) => w.includes("won't work in browser")),
      false,
    );
  });
});

Deno.test("lint: no warn for relative imports in .tsx", async () => {
  await withTmpDir(async (dir) => {
    await Deno.writeTextFile(
      join(dir, "App.tsx"),
      "import { helper } from './utils.ts'\nexport default function App() {}",
    );
    const r = await lint({}, { reduce: () => {}, execute: () => {} }, dir);
    assertEquals(
      r.warn.some((w) => w.includes("won't work in browser")),
      false,
    );
  });
});

Deno.test("lint: no warn for npm imports in .ts files (server-side)", async () => {
  await withTmpDir(async (dir) => {
    await Deno.writeTextFile(
      join(dir, "App.tsx"),
      "export default function App() {}",
    );
    await Deno.writeTextFile(
      join(dir, "execute.ts"),
      "import { Database } from 'sqlite3'",
    );
    const r = await lint({}, { reduce: () => {}, execute: () => {} }, dir);
    assertEquals(
      r.warn.some((w) => w.includes("won't work in browser")),
      false,
    );
  });
});

Deno.test("lint: warns on multiple unmapped imports in .tsx", async () => {
  await withTmpDir(async (dir) => {
    await Deno.writeTextFile(
      join(dir, "App.tsx"),
      "import { marked } from 'marked'\nimport hljs from 'highlight.js'\nexport default function App() {}",
    );
    const r = await lint({}, { reduce: () => {}, execute: () => {} }, dir);
    const browserWarns = r.warn.filter((w) =>
      w.includes("won't work in browser")
    );
    assertEquals(browserWarns.length, 2);
  });
});

Deno.test("lint: no warn for import type in .tsx (erased by TS)", async () => {
  await withTmpDir(async (dir) => {
    await Deno.writeTextFile(
      join(dir, "App.tsx"),
      "import type { Options } from 'marked'\nexport default function App() {}",
    );
    const r = await lint({}, { reduce: () => {}, execute: () => {} }, dir);
    assertEquals(
      r.warn.some((w) => w.includes("won't work in browser")),
      false,
    );
  });
});

Deno.test("lint: warns on bare side-effect import in .tsx", async () => {
  await withTmpDir(async (dir) => {
    await Deno.writeTextFile(
      join(dir, "App.tsx"),
      "import 'some-polyfill'\nexport default function App() {}",
    );
    const r = await lint({}, { reduce: () => {}, execute: () => {} }, dir);
    assertEquals(
      r.warn.some((w) =>
        w.includes('"some-polyfill"') && w.includes("won't work in browser")
      ),
      true,
    );
  });
});

Deno.test("lint: browser import check skipped in prod mode", async () => {
  await withTmpDir(async (dir) => {
    await Deno.writeTextFile(
      join(dir, "App.tsx"),
      "import { marked } from 'marked'\nexport default function App() {}",
    );
    const r = await lint(
      {},
      { reduce: () => {}, execute: () => {} },
      dir,
      true,
    );
    assertEquals(
      r.warn.some((w) => w.includes("won't work in browser")),
      false,
    );
  });
});

Deno.test("boot lint: test files are not linted for browser imports", async () => {
  // They never reach the browser bundle, so advice about their imports is
  // noise — it fired on this repo's own suite when a .test.tsx landed next to
  // a booted app's baseDir.
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      `${dir}/App.tsx`,
      "export default function App() { return null }\n",
    );
    await Deno.writeTextFile(
      `${dir}/thing.test.tsx`,
      `import { assertEquals } from "@std/assert";\nassertEquals(1, 1);\n`,
    );
    const r = await lint({ n: 0 }, {}, dir);
    const noise = [...r.warn, ...r.hint].filter((m) =>
      m.includes("thing.test.tsx")
    );
    assertEquals(noise, [], `test files must be ignored: ${noise.join(" | ")}`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("lint: an npm package the import map DOES resolve is not warned about", async () => {
  // The browser import map maps every `npm:` entry in the app's deno.json to
  // the CDN (buildBrowserImportMap), so this import works. The linter kept its
  // own hand-copied list of the framework defaults and could not see the app's
  // packages, so it warned "won't work in browser — move this import to a
  // server-side .ts file" about working code. Both now ask the same builder.
  await withTmpDir(async (dir) => {
    const app = join(dir, "src");
    await Deno.mkdir(app);
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({ imports: { "chart.js": "npm:chart.js@4.4.0" } }),
    );
    await Deno.writeTextFile(
      join(app, "App.tsx"),
      "import { Chart } from 'chart.js'\nexport default function App() {}",
    );
    const r = await lint({}, { reduce: () => {}, execute: () => {} }, app);
    assertEquals(
      r.warn.filter((w) => w.includes("won't work in browser")),
      [],
    );
    // …and a package that is NOT mapped is still called out.
    await Deno.writeTextFile(
      join(app, "Other.tsx"),
      "import { marked } from 'marked'\nexport default function O() {}",
    );
    const r2 = await lint({}, { reduce: () => {}, execute: () => {} }, app);
    assertEquals(
      r2.warn.some((w) =>
        w.includes('"marked"') && w.includes("won't work in browser")
      ),
      true,
    );
  });
});

Deno.test("import map: a deno.jsonc-only app is told why its imports vanish", async () => {
  // The browser import map is built from deno.json ONLY. An app whose config is
  // deno.jsonc (Deno accepts it, `am` and the file watcher accept it) got an
  // import map with none of its packages and a browser that fails to resolve a
  // specifier the server resolves fine — a blank screen caused by a file
  // extension, with nothing said anywhere.
  const { _resetImportMapWarnings, readAppDenoImports } = await import(
    "../src/server/server-html-importmap.ts"
  );
  const dir = await Deno.makeTempDir({ prefix: "aio-jsonc-" });
  const cwd = Deno.cwd();
  const warned: string[] = [];
  const origWarn = console.warn;
  try {
    await Deno.mkdir(join(dir, "src"));
    await Deno.writeTextFile(
      join(dir, "deno.jsonc"),
      '{ // comment\n  "imports": { "chart.js": "npm:chart.js@4" }\n}',
    );
    _resetImportMapWarnings();
    // cwd is the third candidate, so it has to be the app itself for this to
    // be the real "no readable deno.json anywhere" case.
    Deno.chdir(dir);
    console.warn = (...a: unknown[]) =>
      void warned.push(a.map(String).join(" "));
    const imports = readAppDenoImports(join(dir, "src"));
    assertEquals(imports, {});
  } finally {
    console.warn = origWarn;
    Deno.chdir(cwd);
    await Deno.remove(dir, { recursive: true });
  }
  const all = warned.join("\n");
  assertEquals(all.includes("deno.jsonc"), true, all);
  assertEquals(all.includes("Rename it to deno.json"), true, all);
});

// The boot lint checked a HARDCODED App.tsx, so an app that legitimately named
// its root component something else (`ui.entry`, honoured by the dev server and
// — since R-2 — by the build) failed its own boot check while the
// server was about to serve the right file. One decider, checked here.
Deno.test("lint: ui.entry decides which component must exist", async () => {
  await withTmpDir(async (dir) => {
    await Deno.writeTextFile(
      join(dir, "Status.tsx"),
      "export default function Status() { return <div/> }",
    );
    const ok = await lint(
      { count: 0 },
      { reduce: () => {}, execute: () => {} },
      dir,
      false,
      false,
      true,
      "Status.tsx",
    );
    assertEquals(ok.fail.length, 0);
    assertEquals(ok.ok.includes("Status.tsx"), true);

    // …and the failure names the configured component, not App.tsx.
    const bad = await lint(
      { count: 0 },
      { reduce: () => {}, execute: () => {} },
      dir,
      false,
      false,
      true,
      "Missing.tsx",
    );
    assertEquals(bad.fail.length, 1);
    assertEquals(bad.fail[0]!.startsWith("Missing.tsx not found at"), true);
  });
});
