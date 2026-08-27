// The developer-experience defects a hands-on walk of the whole journey found.
// Every case here was REPRODUCED on a real `am create` app before it was fixed;
// the comment on each test is the observed symptom, so a regression reads as
// the report it came from.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  denoNmPackageName,
  devOnlyClosure,
} from "../src/build/build-compile.ts";
import {
  extractSourceImports,
  validateGraph,
} from "../src/server/graph-validator.ts";
import { browserImportWarning } from "../src/server/lint.ts";
import { classifyBrowserError } from "../src/server/server-html-classify.ts";

const passthrough = (source: string) => Promise.resolve(source);

async function fixture(files: Record<string, string>): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "aio-dev-loop-dx-" });
  for (const [name, body] of Object.entries(files)) {
    await Deno.writeTextFile(`${dir}/${name}`, body);
  }
  return dir;
}

// ── #1 a hello-world compiles to 131.7 MB ───────────────────────────────────
//
// MEASURED on a scaffolded counter: 135.7 MB, of which 25.39 MB was an
// embedded `node_modules` holding happy-dom (13.19 MB), extract-zip (6.98 MB),
// @types/node (2.43 MB), undici (1.58 MB), sumchecker, progress, semver — not
// one of them reachable from a browser-only counter. The old exclusion was a
// name-PREFIX list (`electron@`, `@electron+`, …), which by construction could
// not see `@electron-internal+extract-zip` or anything electron pulls in under
// its own name. After the closure walk: 111.2 MB, node_modules 665 KB.

Deno.test("denoNmPackageName: a .deno entry name is a package name + version", () => {
  assertEquals(denoNmPackageName("immer@10.2.0"), "immer");
  assertEquals(denoNmPackageName("@electron+get@5.1.0"), "@electron/get");
  assertEquals(
    denoNmPackageName("@electron-internal+extract-zip@1.0.5"),
    "@electron-internal/extract-zip",
  );
  assertEquals(denoNmPackageName("@types+node@24.13.3"), "@types/node");
  // The flat `.deno/node_modules` fallback dir is not a package.
  assertEquals(denoNmPackageName("node_modules"), null);
  assertEquals(denoNmPackageName(".bin"), null);
});

Deno.test("devOnlyClosure: the whole dev tree goes, transitively", () => {
  // The real layout measured in a scaffolded app.
  const graph = new Map<string, Set<string>>([
    [
      "electron@44.0.0",
      new Set([
        "@electron+get@5.1.0",
        "@electron-internal+extract-zip@1.0.5",
        "@types+node@24.13.3",
      ]),
    ],
    [
      "@electron+get@5.1.0",
      new Set([
        "debug@4.4.3",
        "env-paths@3.0.0",
        "graceful-fs@4.2.11",
        "progress@2.0.3",
        "semver@7.8.5",
        "sumchecker@3.0.1",
        "undici@7.29.0",
      ]),
    ],
    ["@electron-internal+extract-zip@1.0.5", new Set()],
    ["@types+node@24.13.3", new Set(["undici-types@7.18.2"])],
    ["debug@4.4.3", new Set(["ms@2.1.3"])],
    ["sumchecker@3.0.1", new Set(["debug@4.4.3"])],
    ["esbuild@0.24.2", new Set(["@esbuild+linux-x64@0.24.2"])],
    [
      "happy-dom@17.6.3",
      new Set(["webidl-conversions@7.0.0", "whatwg-mimetype@3.0.0"]),
    ],
    ["immer@10.2.0", new Set()],
    ["env-paths@3.0.0", new Set()],
    ["graceful-fs@4.2.11", new Set()],
    ["progress@2.0.3", new Set()],
    ["semver@7.8.5", new Set()],
    ["undici@7.29.0", new Set()],
    ["undici-types@7.18.2", new Set()],
    ["ms@2.1.3", new Set()],
    ["@esbuild+linux-x64@0.24.2", new Set()],
    ["webidl-conversions@7.0.0", new Set()],
    ["whatwg-mimetype@3.0.0", new Set()],
  ]);
  const excluded = devOnlyClosure(
    graph,
    ["electron@44.0.0", "esbuild@0.24.2", "happy-dom@17.6.3"],
    ["immer@10.2.0"],
  );
  // Everything except the one real runtime dependency.
  assertEquals(excluded.length, graph.size - 1);
  assert(!excluded.includes("immer@10.2.0"), "the app's own dep is kept");
  for (
    const pkg of [
      // The transitive weight a prefix list could never have caught.
      "@electron-internal+extract-zip@1.0.5",
      "@types+node@24.13.3",
      "undici@7.29.0",
      "sumchecker@3.0.1",
      "happy-dom@17.6.3",
      "ms@2.1.3",
    ]
  ) {
    assert(excluded.includes(pkg), `${pkg} should be excluded`);
  }
});

Deno.test("devOnlyClosure: a package a REAL dependency also needs is kept", () => {
  // The safety property: widening DEV_ONLY_PACKAGES can shrink the binary,
  // never break it. `semver` reachable from both electron and the app's own
  // dependency must survive.
  const graph = new Map<string, Set<string>>([
    ["electron@44.0.0", new Set(["semver@7.8.5", "undici@7.29.0"])],
    ["mydep@1.0.0", new Set(["semver@7.8.5"])],
    ["semver@7.8.5", new Set()],
    ["undici@7.29.0", new Set()],
  ]);
  assertEquals(
    devOnlyClosure(graph, ["electron@44.0.0"], ["mydep@1.0.0"]),
    ["electron@44.0.0", "undici@7.29.0"],
  );
});

Deno.test("devOnlyClosure: a cycle terminates", () => {
  const graph = new Map<string, Set<string>>([
    ["a@1", new Set(["b@1"])],
    ["b@1", new Set(["a@1"])],
    ["keep@1", new Set()],
  ]);
  assertEquals(devOnlyClosure(graph, ["a@1"], ["keep@1"]), ["a@1", "b@1"]);
});

// ── #4 a bad import path is SILENT in dev ───────────────────────────────────
//
// REPRODUCED: `import { nope } from "./does-not-exist.ts"` in App.tsx →
// no terminal error, no overlay, the page rendered unchanged. esbuild elides
// an import whose bindings are unused, and the validator read esbuild's
// OUTPUT — so dev was LENIENT where `deno check` was strict, which is exactly
// backwards for this project.

Deno.test("extractSourceImports: reads what the SOURCE wrote, with line numbers", () => {
  const src = [
    `// import { x } from "./comment.ts";`, //                              1
    `import type { JSX } from "aio";`, //                                   2
    `import { counter } from "./cell.ts";`, //                              3
    `import { nope } from "./does-not-exist.ts";`, //                       4
    `import "./style.css";`, //                                            5
    `import "./side-effect.ts";`, //                                       6
    `export { a } from "./re-export.ts";`, //                              7
    `export type { B } from "./types.ts";`, //                             8
    `const m = await import("aio/server");`, //                            9
    `/* import { y } from "./block.ts"; */`, //                           10
    `const s = "More from ";`, //                                         11
  ].join("\n");
  const found = extractSourceImports(src);
  assertEquals(found.map((i) => [i.spec, i.kind, i.line]), [
    ["./cell.ts", "static", 3],
    ["./does-not-exist.ts", "static", 4],
    ["./re-export.ts", "static", 7],
    ["./side-effect.ts", "static", 6],
    ["aio/server", "dynamic", 9],
  ]);
});

Deno.test("graph: an UNUSED bad import path is an error, with its line", async () => {
  const dir = await fixture({
    // The transpiler stands in for esbuild's elision: `nope` is never read, so
    // the transformed output drops the import entirely. The validator must
    // still see it.
    "App.tsx": [
      `import { counter } from "./cell.ts";`,
      `import { nope } from "./does-not-exist.ts";`,
      `export default function App() { return counter; }`,
    ].join("\n"),
    "cell.ts": `export const counter = 1;`,
  });
  try {
    const elide = (source: string) =>
      Promise.resolve(
        source.split("\n").filter((l) => !l.includes("does-not-exist")).join(
          "\n",
        ),
      );
    const r = await validateGraph(`${dir}/App.tsx`, {}, elide);
    const hit = r.errors.find((e) => e.category === "file-not-found");
    assert(hit, `expected file-not-found: ${JSON.stringify(r.errors)}`);
    assertEquals(hit.file, `${dir}/App.tsx`);
    assertEquals(hit.line, 2, "the line the import is written on");
    assertStringIncludes(hit.message, "./does-not-exist.ts");
    assert(!r.valid, "and dev refuses to serve the app, like `deno check`");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ── #2 a server-only import in a client file got confidently WRONG advice ───
//
// REPRODUCED: `import { createDB } from "aio/server"` in App.tsx → the dev
// overlay said `fix: Add "aio/server": "npm:aio/server" to deno.json imports`.
// There is no such npm package: the user edits deno.json, restarts, and lands
// on the same blank page. It is a server-only module in a client graph, which
// the framework can identify exactly.

Deno.test("graph: a STATIC aio/server import in a client file is refused by category", async () => {
  const dir = await fixture({
    "App.tsx": [
      `import type { JSX } from "aio";`,
      `import { createDB } from "aio/server";`,
      `export default function App() { return createDB; }`,
    ].join("\n"),
  });
  try {
    const r = await validateGraph(`${dir}/App.tsx`, {}, passthrough);
    const hit = r.errors.find((e) => e.message.includes("aio/server"));
    assert(hit, `expected an aio/server error: ${JSON.stringify(r.errors)}`);
    assertEquals(hit.category, "server-only-import");
    assertEquals(hit.file, `${dir}/App.tsx`);
    assertEquals(hit.line, 2);
    assertStringIncludes(hit.fix, "NOT a missing dependency");
    assertStringIncludes(hit.fix, "await import(");
    assert(
      !/npm:aio\/server/.test(hit.fix),
      "never advise a package that does not exist",
    );
    assert(!r.valid, "and it blocks — the browser cannot resolve it");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("graph: a DYNAMIC aio/server import stays the documented escape hatch", async () => {
  const dir = await fixture({
    "App.tsx": [
      `export default async function App() {`,
      `  const { createDB } = await import("aio/server");`,
      `  return createDB;`,
      `}`,
    ].join("\n"),
  });
  try {
    const r = await validateGraph(`${dir}/App.tsx`, {}, passthrough);
    assertEquals(
      r.errors.filter((e) => e.message.includes("aio/server") && !e.deferred),
      [],
    );
    assert(r.valid);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("boot lint: aio/server in a .tsx gets the category, not npm advice", () => {
  const msg = browserImportWarning("App.tsx", "aio/server");
  assertStringIncludes(msg, "SERVER entry");
  assertStringIncludes(msg, "NOT a missing dependency");
  assert(!/npm:aio\/server/.test(msg));
  // A genuinely missing npm package still gets the mapping advice.
  assertStringIncludes(
    browserImportWarning("App.tsx", "lodash"),
    `"lodash": "npm:lodash"`,
  );
});

Deno.test("browser overlay: aio/server is classified, not mis-advised", () => {
  const c = classifyBrowserError(
    `Failed to resolve module specifier "aio/server"`,
  );
  assertEquals(c.classification, "server-only-import");
  assertStringIncludes(c.fix, "NOT a missing dependency");
  assert(!/npm:aio\/server/.test(c.fix));
  // An actual missing npm package keeps the mapping advice.
  assertStringIncludes(
    classifyBrowserError(`Failed to resolve module specifier "lodash"`).fix,
    `"lodash": "npm:lodash"`,
  );
});
