// Browser-deps drift gate — kills the "framework module imports a bare npm
// package the page can't resolve" bug class permanently (found in the wild:
// "immer" missing from the import map = blank screen for every app without a
// readable deno.json). Walks the REAL import graph of every module the dev
// server serves under /__aio/ (the transpiled framework) and asserts each
// bare npm specifier has a DEFAULT mapping in buildBrowserImportMap — not one
// inherited from an app's deno.json, which may not exist.
import { assert } from "@std/assert";
import { buildBrowserImportMap } from "../src/server/server.ts";

const SRC = new URL("../src/", import.meta.url);

/** Entry modules the dev server serves to the page (see server-static.ts). */
const BROWSER_ENTRIES = [
  "browser-air.ts", // /__aio/ui.js
  "air.ts", // /__aio/air.js
  "state/listeners.ts", // /__aio/listeners.ts
  "jsx-runtime.ts", // import map aio/jsx-runtime
  "air/aio-renderer.ts", // client entry mounts this directly
];

const IMPORT_RE =
  /(?:^|\n)\s*(?:import|export)\s[^"'\n]*?from\s*["']([^"']+)["']|(?:^|\n)\s*import\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/g;

async function collectBareImports(): Promise<Map<string, Set<string>>> {
  const bare = new Map<string, Set<string>>(); // specifier → importing files
  const visited = new Set<string>();
  const queue = BROWSER_ENTRIES.map((e) => new URL(e, SRC).href);

  while (queue.length > 0) {
    const url = queue.pop()!;
    if (visited.has(url)) continue;
    visited.add(url);
    let text: string;
    try {
      text = await Deno.readTextFile(new URL(url));
    } catch {
      continue; // type-only or generated — the type-checker owns existence
    }
    for (const m of text.matchAll(IMPORT_RE)) {
      const spec = m[1] ?? m[2] ?? m[3];
      if (!spec) continue;
      if (spec.startsWith("./") || spec.startsWith("../")) {
        // follow the local graph
        const child = new URL(spec, url).href;
        if (child.endsWith(".ts") || child.endsWith(".tsx")) {
          queue.push(child);
        }
        continue;
      }
      if (spec.startsWith("/")) continue; // absolute page path (/__aio/…)
      if (spec.startsWith("node:") || spec.startsWith("data:")) continue;
      const rel = url.slice(SRC.href.length);
      if (!bare.has(spec)) bare.set(spec, new Set());
      bare.get(spec)!.add(rel);
    }
  }
  return bare;
}

Deno.test("every bare import reachable from browser-served framework code is mapped by default", async () => {
  const bare = await collectBareImports();
  assert(bare.size > 0, "graph walk found no bare imports — walker broke?");
  // What a page gets when the app has NO deno.json at all.
  const defaults = buildBrowserImportMap({});
  const unmapped: string[] = [];
  for (const [spec, files] of bare) {
    // aio/* self-references are mapped; npm/jsr packages must be too.
    const covered = defaults[spec] !== undefined ||
      // subpath imports covered by a parent mapping ("pkg/sub" via "pkg/")
      Object.keys(defaults).some(
        (k) => k.endsWith("/") && spec.startsWith(k),
      );
    if (!covered) {
      unmapped.push(`${spec} (imported by ${[...files].join(", ")})`);
    }
  }
  assert(
    unmapped.length === 0,
    `bare import(s) served to the browser with NO default import-map entry — ` +
      `this is a BLANK SCREEN for apps without a deno.json:\n  ` +
      unmapped.join("\n  ") +
      `\nfix: add a default (vendored like immer, or CDN) in ` +
      `src/server/server-html-importmap.ts`,
  );
});
