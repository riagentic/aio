// `--safe-fix` promises, in aiol's own words: "Only harmless changes: missing
// config, unused imports. Never changes behavior."
//
// A wrong autofix is far worse than a missed lint — the linter edits code you
// then trust, and the damage shows up as a compile error or a blank screen
// somewhere else. Each case here was a fix that broke the file it "fixed":
//
//   • `import React, { useState } from "react"` — the whole LINE was deleted,
//     taking `useState` with it, and the file stopped compiling.
//   • `import { createRoot } from "react-dom/client"` — the import was removed
//     while `createRoot(...)` was still called: a ReferenceError at runtime.
//   • the JSX config fix wrote `jsxImportSource: "react"` over an aio app —
//     the exact opposite of what `am fix` enforces (`"aio"`), which repoints
//     every JSX element in the app at React's runtime.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { lint } from "../aiol/mod.ts";

const IMPORTS = { "aio": "jsr:@riagentic/aio@1.0.0" };

const project = (files: Record<string, string>): Record<string, string> => ({
  "deno.json": JSON.stringify(
    {
      title: "fixme",
      version: "0.1.0",
      nodeModulesDir: "auto",
      compilerOptions: { jsx: "react-jsx", jsxImportSource: "aio" },
      imports: IMPORTS,
      tasks: { dev: "deno run -A src/app.ts", test: "deno test -A tests/" },
    },
    null,
    2,
  ),
  "src/app.ts":
    `import { aio } from "aio";\nimport { counter } from "./cell.ts";\nawait aio.run({ appId: "fixme", cells: { counter } });\n`,
  "src/cell.ts":
    `import { cell } from "aio";\nexport const counter = cell("counter", {\n  state: { count: 0 },\n  methods: { increment(s: { count: number }) { s.count++; } },\n});\n`,
  ...files,
});

/** Run aiol, apply every safe fix it offers, return the resulting files. */
async function safeFixed(
  files: Record<string, string>,
): Promise<{ files: Record<string, string>; applied: string[] }> {
  const dir = await Deno.makeTempDir({ prefix: "aiol-safefix-" });
  try {
    for (const [rel, src] of Object.entries(files)) {
      const p = join(dir, rel);
      await Deno.mkdir(p.replace(/[^/\\]+$/, ""), { recursive: true });
      await Deno.writeTextFile(p, src);
    }
    const report = await lint(dir);
    const applied: string[] = [];
    for (const issue of report.issues.filter((i) => i.safeFix)) {
      if (await issue.safeFix!(dir)) applied.push(issue.message);
    }
    const out: Record<string, string> = {};
    for (const rel of Object.keys(files)) {
      out[rel] = await Deno.readTextFile(join(dir, rel));
    }
    return { files: out, applied };
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("safe-fix: removing `import React` keeps the other bindings", async () => {
  const { files } = await safeFixed(project({
    "src/App.tsx": `import React, { useState } from "react";

export default function App() {
  const [n, set] = useState(0);
  return <button onClick={() => set(n + 1)}>{n}</button>;
}
`,
  }));
  const app = files["src/App.tsx"]!;
  assert(
    app.includes("useState"),
    `the fix deleted a binding the file still uses:\n${app}`,
  );
  assertStringIncludes(app, 'from "react"');
  assert(
    !/import\s+React\b/.test(app),
    `the React default binding should be gone:\n${app}`,
  );
});

Deno.test("safe-fix: `import React` is left alone when React is still used", async () => {
  const src = `import React from "react";

export default function App() {
  return <React.Fragment>hi</React.Fragment>;
}
`;
  const { files } = await safeFixed(project({ "src/App.tsx": src }));
  assertEquals(
    files["src/App.tsx"],
    src,
    "removing the import would break React.Fragment — the fix must decline",
  );
});

Deno.test("safe-fix: a sole `import React` line is still removed", async () => {
  const { files } = await safeFixed(project({
    "src/App.tsx": `import React from "react";

export default function App() {
  return <div>hi</div>;
}
`,
  }));
  assert(
    !/import\s+React\b/.test(files["src/App.tsx"]!),
    "an unused React import is exactly what this fix is for",
  );
});

Deno.test("safe-fix: createRoot's import survives while createRoot is called", async () => {
  const src = `import { createRoot } from "react-dom/client";

export default function App() {
  return <div>hi</div>;
}

export const mount = () => createRoot(document.body).render(<App />);
`;
  const { files } = await safeFixed(project({ "src/App.tsx": src }));
  assertEquals(
    files["src/App.tsx"],
    src,
    "dropping the import while the call remains is a ReferenceError, not a fix",
  );
});

Deno.test("safe-fix: an unused createRoot import IS removed", async () => {
  const { files } = await safeFixed(project({
    "src/App.tsx": `import { createRoot } from "react-dom/client";

export default function App() {
  return <div>hi</div>;
}
`,
  }));
  assert(
    !files["src/App.tsx"]!.includes("createRoot"),
    "an unused mounting import is dead code — that one is safe to remove",
  );
});

// `am fix` (src/am/am-cmd-fix.ts) is the decider for what an aio app's JSX
// config must say: jsxImportSource "aio". aiol writing "react" over it made
// the two tools disagree about the same key, and the app that ran `--safe-fix`
// compiled its JSX against React's runtime instead of AIR's.
Deno.test("safe-fix: the JSX fix never repoints jsxImportSource away from aio", async () => {
  const dj = JSON.parse(
    project({})["deno.json"]!,
  ) as {
    imports: Record<string, string>;
    compilerOptions: Record<string, string>;
  };
  dj.imports["react"] = "npm:react@^18";
  dj.compilerOptions = { jsx: "preserve", jsxImportSource: "aio" };
  const { files } = await safeFixed(project({
    "deno.json": JSON.stringify(dj, null, 2),
    "src/App.tsx": `export default function App() { return <div>hi</div>; }\n`,
  }));
  const co = (JSON.parse(files["deno.json"]!) as {
    compilerOptions: Record<string, string>;
  }).compilerOptions;
  assertEquals(
    co["jsx"],
    "react-jsx",
    "the transform is what the hint asks for",
  );
  assertEquals(
    co["jsxImportSource"],
    "aio",
    "aio renders JSX — repointing it at react breaks every component",
  );
});

Deno.test("safe-fix: the JSX fix fills in a MISSING jsxImportSource with aio", async () => {
  const dj = JSON.parse(
    project({})["deno.json"]!,
  ) as { imports: Record<string, string>; compilerOptions?: unknown };
  dj.imports["react"] = "npm:react@^18";
  delete dj.compilerOptions;
  const { files } = await safeFixed(project({
    "deno.json": JSON.stringify(dj, null, 2),
    "src/App.tsx": `export default function App() { return <div>hi</div>; }\n`,
  }));
  const co = (JSON.parse(files["deno.json"]!) as {
    compilerOptions: Record<string, string>;
  }).compilerOptions;
  assertEquals(co["jsx"], "react-jsx");
  assertEquals(co["jsxImportSource"], "aio");
});
