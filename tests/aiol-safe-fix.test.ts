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

Deno.test("safe-fix: deno.json `target` renames to `client`, value intact", async () => {
  const dj = JSON.parse(project({})["deno.json"]!) as Record<string, unknown>;
  dj.target = "electron";
  const { files } = await safeFixed(project({
    "deno.json": JSON.stringify(dj, null, 2),
  }));
  const fixed = JSON.parse(files["deno.json"]!) as {
    target?: string;
    client?: string;
  };
  assertEquals(fixed.target, undefined, "the old key is gone");
  assertEquals(fixed.client, "electron", "the value moved, unchanged");
});

Deno.test("safe-fix: an existing `client` key wins over a stale `target`", async () => {
  const dj = JSON.parse(project({})["deno.json"]!) as Record<string, unknown>;
  dj.target = "electron";
  dj.client = "browser";
  const { files } = await safeFixed(project({
    "deno.json": JSON.stringify(dj, null, 2),
  }));
  const fixed = JSON.parse(files["deno.json"]!) as {
    target?: string;
    client?: string;
  };
  assertEquals(fixed.target, undefined);
  assertEquals(fixed.client, "browser", "the explicit client is not clobbered");
});

// ── appId: the fix that used to DELETE an app's identity ──────────────
//
// `appId` names the lock file, the SQLite path and the UDS socket. The rule
// says, correctly, that a compiled build cannot read deno.json — so the value
// has to reach `aio.run()`. The fix performed only the DELETE half: one
// `--safe-fix` on a clean app left `appId` nowhere, the source untouched, and
// the next boot came up under a different identity with its own data orphaned
// on disk. A safe fix may not change behaviour; renaming the app is the
// largest behaviour change there is.

Deno.test("safe-fix: appId MOVES to aio.run() — it is never just deleted", async () => {
  const dj = JSON.parse(project({})["deno.json"]!) as Record<string, unknown>;
  dj.appId = "vault-9";
  const { files } = await safeFixed(project({
    "deno.json": JSON.stringify(dj, null, 2),
    "src/app.ts":
      `import { aio } from "aio";\nimport { counter } from "./cell.ts";\nawait aio.run({ cells: { counter } });\n`,
  }));
  assertStringIncludes(
    files["src/app.ts"]!,
    'appId: "vault-9"',
    "the identity must land in the entry BEFORE it leaves deno.json",
  );
  assertEquals(
    (JSON.parse(files["deno.json"]!) as { appId?: string }).appId,
    undefined,
    "…and only then may the deno.json key go",
  );
});

Deno.test("safe-fix: the zero-config `aio.run()` gains an options object", async () => {
  const dj = JSON.parse(project({})["deno.json"]!) as Record<string, unknown>;
  dj.appId = "zero-arg";
  const { files } = await safeFixed(project({
    "deno.json": JSON.stringify(dj, null, 2),
    "src/app.ts":
      `import "./cell.ts";\nimport { aio } from "aio";\nawait aio.run();\n`,
  }));
  assertStringIncludes(files["src/app.ts"]!, 'aio.run({ appId: "zero-arg" })');
  assertEquals(
    (JSON.parse(files["deno.json"]!) as { appId?: string }).appId,
    undefined,
  );
});

Deno.test("safe-fix: with nowhere to put appId, deno.json keeps it", async () => {
  const dj = JSON.parse(project({})["deno.json"]!) as Record<string, unknown>;
  dj.appId = "keepme";
  const { files } = await safeFixed(project({
    "deno.json": JSON.stringify(dj, null, 2),
    // No `aio.run(` in code — only a mention in a comment.
    "src/app.ts":
      `import "./cell.ts";\n// the harness calls aio.run({ appId: "keepme" }) for us\n`,
  }));
  assertEquals(
    (JSON.parse(files["deno.json"]!) as { appId?: string }).appId,
    "keepme",
    "half a migration is worse than none — the key stays until the code can hold it",
  );
});

Deno.test("safe-fix: `aiol .` does not brand the app `my-app`", async () => {
  // The DOCUMENTED invocation. `basename(".")` is `""`, so every app the old
  // fix touched was named by its silent fallback instead of by itself.
  const dir = await Deno.makeTempDir({ prefix: "brandme-" });
  const orig = Deno.cwd();
  try {
    const files = project({
      // Nothing here names the app: no appId, no title, no name.
      "deno.json": JSON.stringify(
        {
          version: "0.1.0",
          nodeModulesDir: "auto",
          compilerOptions: { jsx: "react-jsx", jsxImportSource: "aio" },
          imports: { "aio": "jsr:@riagentic/aio@1.0.0" },
          tasks: { dev: "deno run -A src/app.ts", test: "deno test -A tests/" },
        },
        null,
        2,
      ),
      "src/app.ts":
        `import { aio } from "aio";\nimport { counter } from "./cell.ts";\nawait aio.run({ cells: { counter } });\n`,
    });
    for (const [rel, src] of Object.entries(files)) {
      const p = join(dir, rel);
      await Deno.mkdir(p.replace(/[^/\\]+$/, ""), { recursive: true });
      await Deno.writeTextFile(p, src);
    }
    Deno.chdir(dir);
    const report = await lint(".");
    for (const issue of report.issues.filter((i) => i.safeFix)) {
      await issue.safeFix!(".");
    }
    const app = await Deno.readTextFile(join(dir, "src", "app.ts"));
    assert(
      !app.includes("my-app"),
      `the fix branded the app with its fallback name:\n${app}`,
    );
    assertStringIncludes(
      app,
      `appId: "${dir.split("/").pop()!.toLowerCase()}"`,
      "the app is named after its own directory",
    );
  } finally {
    Deno.chdir(orig);
    await Deno.remove(dir, { recursive: true });
  }
});

// ── A [fixable] that never converges ─────────────────────────────────
//
// A label the tool does not honour is worse than no label: the finding comes
// back green-flagged after every `--safe-fix`, and the only way to learn it is
// declined-by-design is to diff the file. The effect-return fix declines four
// shapes on purpose — a draft param that is not `s`, a return-type annotation
// it cannot narrow mechanically, a typed draft with no `"aio"` import clause to
// hang `MethodDraftServed` on, and a `return` that shares its line with other
// code — and the rule advertised `[fixable]` on all four. Both now ask ONE
// planner.

Deno.test("safe-fix: a declined effect-return says [manual], never [fixable]", async () => {
  const files = project({
    "src/eff.ts": `import { cell, schedule } from "aio";
export const one = cell("one", {
  state: { n: 0 },
  methods: {
    // shares its line with an \`if\` — the fix rewrites whole statements only
    guard(s: { n: number }, x: number) { if (x) return schedule.after(1000, "t"); s.n = x; },
    // the draft param is not \`s\`
    other(draft: { n: number }) { return schedule.after(1000, "t"); },
  },
});
`,
  });
  const dir = await Deno.makeTempDir({ prefix: "aiol-converge-" });
  try {
    for (const [rel, src] of Object.entries(files)) {
      const p = join(dir, rel);
      await Deno.mkdir(p.replace(/[^/\\]+$/, ""), { recursive: true });
      await Deno.writeTextFile(p, src);
    }
    // Apply every offered fix, twice — a converging tool has nothing left.
    for (let round = 0; round < 2; round++) {
      const r = await lint(dir);
      for (const i of r.issues.filter((i) => i.safeFix)) await i.safeFix!(dir);
    }
    const final = await lint(dir);
    const stuck = final.issues.filter((i) =>
      i.safeFix && i.area === "alpha52" && i.message.includes("returning")
    );
    assertEquals(
      stuck.map((i) => `${i.file}:${i.line} ${i.message}`),
      [],
      "these wore [fixable] but --safe-fix never rewrites them",
    );
    const declined = final.issues.filter((i) =>
      i.area === "alpha52" && i.message.includes("returning")
    );
    assertEquals(declined.length, 2, "both sites are still REPORTED");
    for (const d of declined) {
      assert(
        !!d.manual,
        `a declined site must say why: ${d.message}`,
      );
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
