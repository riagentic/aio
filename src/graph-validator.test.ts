import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  checkPlatformSafety,
  extractImports,
  resolveSpecifier,
  validateGraph,
} from "./graph-validator.ts";

Deno.test("extractImports finds static imports", () => {
  const code = `import { foo } from "./foo.ts";\nimport bar from "../bar.tsx";`;
  assertEquals(extractImports(code), ["./foo.ts", "../bar.tsx"]);
});

Deno.test("extractImports finds bare specifiers", () => {
  const code = `import { useState } from "react";\nimport _ from "lodash";`;
  assertEquals(extractImports(code), ["react", "lodash"]);
});

Deno.test("extractImports finds dynamic imports", () => {
  const code = `const m = await import("./lazy.ts");`;
  assertEquals(extractImports(code), ["./lazy.ts"]);
});

Deno.test("extractImports finds re-exports", () => {
  const code = `export { x } from "./x.ts";\nexport * from "./y.ts";`;
  assertEquals(extractImports(code), ["./x.ts", "./y.ts"]);
});

Deno.test("extractImports ignores comments", () => {
  const code =
    `// import { x } from "ignored"\n/* import { y } from "also-ignored" */\nimport { z } from "real";`;
  assertEquals(extractImports(code), ["real"]);
});

Deno.test("resolveSpecifier resolves relative with extension try", () => {
  // Use a mock fileExists that says ./foo.ts exists
  const exists = (p: string) => p.endsWith("/foo.ts");
  const result = resolveSpecifier("./foo", "/project/src/App.tsx", {}, exists);
  assertEquals(result, { kind: "local", path: "/project/src/foo.ts" });
});

Deno.test("resolveSpecifier resolves bare via import map", () => {
  const importMap = { "react": "https://esm.sh/react@18.3.1" };
  const result = resolveSpecifier("react", "/project/src/App.tsx", importMap);
  assertEquals(result, {
    kind: "external",
    url: "https://esm.sh/react@18.3.1",
  });
});

Deno.test("resolveSpecifier treats absolute URL path as external", () => {
  const importMap = { "aio": "/__aio/ui.js" };
  const result = resolveSpecifier("aio", "/project/src/App.tsx", importMap);
  assertEquals(result, { kind: "external", url: "/__aio/ui.js" });
});

Deno.test("resolveSpecifier resolves jsr: import map entry as external", () => {
  const importMap = { "@std/path": "jsr:@std/path@^1" };
  const result = resolveSpecifier(
    "@std/path",
    "/project/src/App.tsx",
    importMap,
  );
  assertEquals(result, { kind: "external", url: "jsr:@std/path@^1" });
});

Deno.test("resolveSpecifier resolves local import map alias", () => {
  // "./lib/utils.ts" resolved relative to importer's dir (/project/src/) = /project/src/lib/utils.ts
  const exists = (p: string) => p === "/project/src/lib/utils.ts";
  const importMap = { "my-utils": "./lib/utils.ts" };
  const result = resolveSpecifier(
    "my-utils",
    "/project/src/App.tsx",
    importMap,
    exists,
  );
  assertEquals(result, { kind: "local", path: "/project/src/lib/utils.ts" });
});

Deno.test("resolveSpecifier errors on missing bare specifier", () => {
  const result = resolveSpecifier("lodash", "/project/src/App.tsx", {});
  assertEquals(result.kind, "error");
  if (result.kind === "error") {
    assertStringIncludes(result.error.fix, "deno.json");
  }
});

Deno.test("resolveSpecifier resolves exact relative path", () => {
  const exists = (p: string) => p === "/project/src/utils.ts";
  const result = resolveSpecifier(
    "./utils.ts",
    "/project/src/App.tsx",
    {},
    exists,
  );
  assertEquals(result, { kind: "local", path: "/project/src/utils.ts" });
});

Deno.test("resolveSpecifier resolves index file", () => {
  const exists = (p: string) => p === "/project/src/components/index.ts";
  const result = resolveSpecifier(
    "./components",
    "/project/src/App.tsx",
    {},
    exists,
  );
  assertEquals(result, {
    kind: "local",
    path: "/project/src/components/index.ts",
  });
});

Deno.test("resolveSpecifier errors on missing relative", () => {
  const exists = (_p: string) => false;
  const result = resolveSpecifier(
    "./missing",
    "/project/src/App.tsx",
    {},
    exists,
  );
  assertEquals(result.kind, "error");
  if (result.kind === "error") {
    assertEquals(result.error.category, "file-not-found");
  }
});

Deno.test("checkPlatformSafety detects Deno API usage", () => {
  const code = `const data = await Deno.readTextFile("x");`;
  const errors = checkPlatformSafety(code, "./db.ts");
  assertEquals(errors.length, 1);
  assertEquals(errors[0]!.category, "server-only-api");
});

Deno.test("checkPlatformSafety ignores import type", () => {
  const code = `import type { Something } from "node:fs";`;
  const errors = checkPlatformSafety(code, "./types.ts");
  assertEquals(errors.length, 0);
});

Deno.test("checkPlatformSafety detects node: imports", () => {
  const code = `import { readFile } from "node:fs";`;
  const errors = checkPlatformSafety(code, "./io.ts");
  assertEquals(errors.length, 1);
  assertStringIncludes(errors[0]!.fix, "server-only");
});

Deno.test("checkPlatformSafety ignores Deno in strings", () => {
  const code = `const s = "Deno.readTextFile is a thing";`;
  const errors = checkPlatformSafety(code, "./safe.ts");
  assertEquals(errors.length, 0);
});

Deno.test("checkPlatformSafety detects export * from node:", () => {
  const code = `export * from "node:path";`;
  const errors = checkPlatformSafety(code, "./utils.ts");
  assertEquals(errors.length, 1);
  assertEquals(errors[0]!.category, "server-only-api");
});

Deno.test("checkPlatformSafety detects export * from @std/", () => {
  const code = `export * from "@std/path";`;
  const errors = checkPlatformSafety(code, "./re-export.ts");
  assertEquals(errors.length, 1);
  assertEquals(errors[0]!.category, "server-only-api");
});

// Simple mock transpile: just return the code as-is (TS imports look like JS imports)
const mockTranspile = (source: string, _filepath: string) =>
  Promise.resolve(source);

Deno.test("validateGraph walks import tree — happy path", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      dir + "/App.tsx",
      `import { foo } from "./foo.ts";\nexport default function App() { return null; }`,
    );
    await Deno.writeTextFile(dir + "/foo.ts", `export const foo = 42;`);
    const result = await validateGraph(dir + "/App.tsx", {}, mockTranspile);
    assertEquals(result.valid, true);
    assertEquals(result.errors.length, 0);
    assert(result.modules.size >= 2); // App.tsx and foo.ts
    assert(result.durationMs >= 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("validateGraph detects missing import", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      dir + "/App.tsx",
      `import { bar } from "./bar.ts";\nexport default function App() { return null; }`,
    );
    const result = await validateGraph(dir + "/App.tsx", {}, mockTranspile);
    assertEquals(result.valid, false);
    assert(result.errors.some((e) => e.category === "file-not-found"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("validateGraph detects transpile error", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      dir + "/App.tsx",
      `export default function App() { return null; }`,
    );
    const badTranspile = (_s: string, _f: string): Promise<string> =>
      Promise.reject(new Error("syntax error"));
    const result = await validateGraph(dir + "/App.tsx", {}, badTranspile);
    assertEquals(result.valid, false);
    assert(result.errors.some((e) => e.category === "transpile-error"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("validateGraph detects missing bare specifier", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      dir + "/App.tsx",
      `import _ from "lodash";\nexport default function App() { return null; }`,
    );
    const result = await validateGraph(dir + "/App.tsx", {}, mockTranspile);
    assertEquals(result.valid, false);
    assert(result.errors.some((e) => e.category === "missing-import-map"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("validateGraph skips external CDN imports", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      dir + "/App.tsx",
      `import { useState } from "react";\nexport default function App() { return null; }`,
    );
    const importMap = { "react": "https://esm.sh/react@18.3.1" };
    const result = await validateGraph(
      dir + "/App.tsx",
      importMap,
      mockTranspile,
    );
    assertEquals(result.valid, true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("validateGraph detects circular imports", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      dir + "/a.ts",
      `import { b } from "./b.ts";\nexport const a = 1;`,
    );
    await Deno.writeTextFile(
      dir + "/b.ts",
      `import { a } from "./a.ts";\nexport const b = 2;`,
    );
    const result = await validateGraph(dir + "/a.ts", {}, mockTranspile);
    // Circular imports are warnings — graph is still valid but cycle must be detected
    assert(result.valid, "circular imports should not block validation");
    assert(
      result.errors.some((e) => e.category === "circular-dependency"),
      "cycle must be detected",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("validateGraph detects server-only API as warning (non-blocking)", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      dir + "/App.tsx",
      `const x = Deno.readTextFile("y");\nexport default function App() { return null; }`,
    );
    const result = await validateGraph(dir + "/App.tsx", {}, mockTranspile);
    // Server-only APIs are warnings, not blocking errors — app still loads
    assertEquals(result.valid, true);
    assert(result.errors.some((e) => e.category === "server-only-api"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("validateGraph per-module valid computed after full walk", async () => {
  const dir = await Deno.makeTempDir();
  try {
    // App imports foo which imports missing bar — App is the importer for bar's error
    await Deno.writeTextFile(
      dir + "/App.tsx",
      `import { foo } from "./foo.ts";\nexport default function App() { return null; }`,
    );
    await Deno.writeTextFile(
      dir + "/foo.ts",
      `import { bar } from "./bar.ts";\nexport const foo = 1;`,
    );
    const result = await validateGraph(dir + "/App.tsx", {}, mockTranspile);
    assertEquals(result.valid, false);
    // foo.ts should have valid=false because it imports missing bar.ts
    const fooNode = result.modules.get(dir + "/foo.ts");
    assert(fooNode, "foo.ts should be in modules");
    assertEquals(
      fooNode!.valid,
      false,
      "foo.ts should be invalid — it imports missing bar.ts",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
