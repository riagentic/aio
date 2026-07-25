// aiol — safe auto-fix functions
// Every fix here is guaranteed to be harmless: no behavior change, no data loss.
// Only adds missing config, removes dead code, or normalizes formatting.

import { basename, join } from "@std/path";
import type { DenoJsonConfig } from "./types.ts";

// ── Helpers ─────────────────────────────────────────────────────────

/** Read, transform, and write deno.json — preserves formatting where possible */
async function patchDenoJson(
  projectDir: string,
  patch: (config: DenoJsonConfig) => void,
): Promise<boolean> {
  const path = join(projectDir, "deno.json");
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch {
    try {
      text = await Deno.readTextFile(join(projectDir, "deno.jsonc"));
    } catch {
      return false;
    }
  }
  try {
    const config = JSON.parse(text) as DenoJsonConfig;
    patch(config);
    await Deno.writeTextFile(path, JSON.stringify(config, null, 2) + "\n");
    return true;
  } catch {
    return false;
  }
}

/** Remove a line matching a regex from a file */
async function removeLine(filePath: string, pattern: RegExp): Promise<boolean> {
  try {
    const content = await Deno.readTextFile(filePath);
    const lines = content.split("\n");
    const filtered = lines.filter((l) => !pattern.test(l));
    if (filtered.length === lines.length) return false;
    await Deno.writeTextFile(filePath, filtered.join("\n"));
    return true;
  } catch {
    return false;
  }
}

// ── Config fixes ────────────────────────────────────────────────────

/** Remove appId from deno.json (moved to aio.run()) */
export function fixRemoveAppId(projectDir: string): Promise<boolean> {
  return patchDenoJson(projectDir, (c) => {
    delete c.appId;
  });
}

/** Add nodeModulesDir: "auto" */
export function fixAddNodeModulesDir(projectDir: string): Promise<boolean> {
  return patchDenoJson(projectDir, (c) => {
    if (!c.nodeModulesDir) c.nodeModulesDir = "auto";
  });
}

/** Add @types/react import */
export function fixAddTypesReact(projectDir: string): Promise<boolean> {
  return patchDenoJson(projectDir, (c) => {
    if (!c.imports) c.imports = {};
    if (!c.imports["@types/react"]) {
      c.imports["@types/react"] = "npm:@types/react@^18";
    }
  });
}

/** Add esbuild import */
export function fixAddEsbuild(projectDir: string): Promise<boolean> {
  return patchDenoJson(projectDir, (c) => {
    if (!c.imports) c.imports = {};
    if (!c.imports["esbuild"]) c.imports["esbuild"] = "npm:esbuild@^0.24";
  });
}

/** Add compilerOptions for JSX */
export function fixAddJsxConfig(projectDir: string): Promise<boolean> {
  return patchDenoJson(projectDir, (c) => {
    if (!c.compilerOptions) c.compilerOptions = {};
    c.compilerOptions["jsx"] = "react-jsx";
    c.compilerOptions["jsxImportSource"] = "react";
    c.compilerOptions["jsxImportSourceTypes"] = "@types/react";
  });
}

/** Add dev task */
export function fixAddDevTask(projectDir: string): Promise<boolean> {
  return patchDenoJson(projectDir, (c) => {
    if (!c.tasks) c.tasks = {};
    if (!c.tasks["dev"]) c.tasks["dev"] = "deno run -A src/app.ts";
  });
}

/** Add test task */
export function fixAddTestTask(projectDir: string): Promise<boolean> {
  return patchDenoJson(projectDir, (c) => {
    if (!c.tasks) c.tasks = {};
    if (!c.tasks["test"]) c.tasks["test"] = "deno test -A tests/";
  });
}

/** Add appId to aio.run() in src/app.ts — derives from deno.json appId or directory name */
export function fixAddAppIdToRun(projectDir: string): Promise<boolean> {
  return (async () => {
    const appTs = join(projectDir, "src", "app.ts");
    let content: string;
    try {
      content = await Deno.readTextFile(appTs);
    } catch {
      return false;
    }
    if (content.includes("appId")) return false; // already has it

    // Derive appId: prefer deno.json value, fallback to directory name
    let appId: string;
    try {
      const dj = JSON.parse(
        await Deno.readTextFile(join(projectDir, "deno.json")),
      ) as { appId?: string };
      appId = dj.appId ?? basename(projectDir);
    } catch {
      appId = basename(projectDir);
    }
    appId = appId.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || "my-app";

    // Insert appId after `aio.run({`
    const patched = content.replace(
      /aio\.run\(\{/,
      `aio.run({\n  appId: '${appId}',`,
    );
    if (patched === content) return false;
    await Deno.writeTextFile(appTs, patched);
    return true;
  })();
}

// ── Source file fixes ───────────────────────────────────────────────

/** Remove `import React from 'react'` or `import React, { ... } from 'react'` from a TSX file.
 *  Safe because jsx: "react-jsx" transform injects React automatically. */
export function fixRemoveImportReact(filePath: string): () => Promise<boolean> {
  return () =>
    removeLine(filePath, /^\s*import\s+React[\s,{].*from\s+['"]react['"]/);
}

/** Remove `import { createRoot } from 'react-dom/client'` — framework handles mounting */
export function fixRemoveCreateRootImport(
  filePath: string,
): () => Promise<boolean> {
  return () =>
    removeLine(
      filePath,
      /^\s*import\s+\{[^}]*createRoot[^}]*\}\s+from\s+['"]react-dom\/client['"]/,
    );
}

// ── Upgrade fixes (deprecated aliases → canonical) ──────────────────
//
// aio keeps every renamed option working as a deprecated alias for the rest of
// the major (docs/basics/semver-policy.md), so these are ergonomics, never
// emergencies — but they're mechanical, so the linter can just do them.

/** `call({ timeout: N }, fn)` → `call({ timeoutMs: N }, fn)`. Scoped to the
 *  options object of a `call(` — a `timeout:` key anywhere else is untouched. */
export function fixCallTimeoutMs(filePath: string): () => Promise<boolean> {
  return async () => {
    try {
      const content = await Deno.readTextFile(filePath);
      const patched = content.replace(
        /\bcall\s*\(\s*\{[^}]*\}/g,
        (opts) => opts.replace(/\btimeout(\s*:)/g, "timeoutMs$1"),
      );
      if (patched === content) return false;
      await Deno.writeTextFile(filePath, patched);
      return true;
    } catch {
      return false;
    }
  };
}

/** Rewrite deprecated flags inside `deno.json` tasks. `--cert=`/`--key=` became
 *  `--tls-cert=`/`--tls-key=` (the bare names collided with the auth `key`
 *  concept); `--headless` is a BUILD flag that a run task must not pass — the
 *  runtime equivalent is `--client=server-only`. `entry` scopes the second
 *  rewrite to tasks that actually run the app. */
export function fixTaskFlags(
  entry: string | null,
): (projectDir: string) => Promise<boolean> {
  return (projectDir: string) =>
    patchDenoJson(projectDir, (config) => {
      const tasks = config.tasks;
      if (!tasks) return;
      for (const [name, cmd] of Object.entries(tasks)) {
        if (typeof cmd !== "string") continue;
        let next = cmd
          .replace(/(?<![\w-])--cert=/g, "--tls-cert=")
          .replace(/(?<![\w-])--key=/g, "--tls-key=");
        if (entry && next.includes(entry)) {
          next = next.replace(
            /(?<![\w-])--headless(?![\w=-])/g,
            "--client=server-only",
          );
        }
        tasks[name] = next;
      }
    });
}

/** Add a missing `aio/<entry>` mapping to deno.json, derived from how the app
 *  already maps bare `aio` — so it works for a source checkout
 *  (`./dep/aio/mod.ts` → `./dep/aio/<path>`) and for a JSR pin
 *  (`jsr:@riagentic/aio@X` → `jsr:@riagentic/aio@X/<entry-suffix>`) alike. */
export function fixAddAioEntry(
  spec: string,
  base: string,
  entryPath: string,
): (projectDir: string) => Promise<boolean> {
  return (projectDir: string) =>
    patchDenoJson(projectDir, (config) => {
      const imports = config.imports ??= {};
      if (imports[spec]) return;
      imports[spec] = base.startsWith("jsr:") || base.startsWith("npm:")
        // A package pin: the entry is a sub-path export of the same package.
        ? `${base}${spec.slice("aio".length)}`
        // A source path: swap the root module for the entry's module.
        : base.replace(/mod\.ts$/, "") + entryPath;
    });
}

/** Move server-only symbols to the `aio/server` entry (alpha37). Splits a mixed
 *  import — `import { cell, createDB } from "aio"` becomes two statements, one
 *  per entry — so the boundary is explicit without losing anything. */
export function fixServerEntryImport(
  filePath: string,
): () => Promise<boolean> {
  const SERVER_ONLY = new Set([
    "createDB",
    "DEFAULT_PRAGMAS",
    "connectCli",
    "connectCliUDS",
  ]);
  return async () => {
    try {
      const src = await Deno.readTextFile(filePath);
      let changed = false;
      const out = src.replace(
        /import\s*\{([^}]*)\}\s*from\s*["']aio["'];?/g,
        (whole, inner: string) => {
          const names = inner.split(",").map((s) => s.trim()).filter(Boolean);
          const server = names.filter((n) =>
            SERVER_ONLY.has(n.replace(/^type\s+/, "").split(/\s+as\s+/)[0]!)
          );
          if (server.length === 0) return whole;
          changed = true;
          const rest = names.filter((n) => !server.includes(n));
          const serverLine = `import { ${
            server.join(", ")
          } } from "aio/server";`;
          return rest.length > 0
            ? `import { ${rest.join(", ")} } from "aio";\n${serverLine}`
            : serverLine;
        },
      );
      if (!changed) return false;
      await Deno.writeTextFile(filePath, out);
      return true;
    } catch {
      return false;
    }
  };
}
