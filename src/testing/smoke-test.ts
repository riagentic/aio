// smoke-test.ts — `smoke()`: boot the app headless and fetch every module the
// browser would eagerly link.
//
// A static import of a `*.server.ts` module from a client-loaded file
// blank-screens the whole app: the dev server 404s the file, and nothing in
// `deno check`, lint or a unit suite fetches modules over HTTP. The graph
// validator now names that statically (`server-only-import`); this is the
// dynamic half — the same request the browser makes, against a real boot, for
// every member of the eager set. One call, exit 0/1 semantics (it throws).
//
//   Deno.test("boot smoke", async () => { await smoke({ baseDir: "." }); });

import { join, relative, resolve } from "@std/path";
import { SERVER_FILE_RE } from "../entries.ts";
import type { CellsConfig } from "../server/aio-types.ts";
import { UI_ENTRY } from "../server/app-files.ts";
import {
  BLOCKING_CATEGORIES,
  type GraphResult,
  validateGraph,
} from "../server/graph-validator.ts";
import {
  buildBrowserImportMap,
  readAppDenoImports,
} from "../server/server-html-importmap.ts";
import { devModuleUrl, devSrcRoot } from "../server/server-static.ts";
import { hasVendorImmer } from "../server/server-vendor.ts";
import { transpile } from "../server/server-transpile.ts";
import { _armTestStrict } from "./test-strict.ts";
import { testServer } from "./server-test.ts";

/** What `smoke()` reports: every eager module it fetched and how long the
 *  headless boot + fetch pass took. It resolves only when every module answered
 *  200 with a JavaScript Content-Type — a miss throws, naming the URL and its
 *  importer chain. */
export interface SmokeResult {
  /** Every eager module, as the URL the browser fetches it at. */
  checked: string[];
  /** The graph validation this ran on (`eager`, `errors`, `modules`). */
  graph: GraphResult;
  /** Wall time, ms. */
  durationMs: number;
}

/** Boot the app headless and fetch every eagerly-linked client module.
 *
 *  1. Walks the client graph from `ui.entry` (default `App.tsx` in `baseDir`,
 *     default cwd) with the same validator the dev server uses — a BLOCKING
 *     finding (a static `*.server.ts` or `node:` import in a client-loaded
 *     file, a missing file) fails here, before any boot.
 *  2. Boots via `testServer` (real `aio.run()`, dev serving, worker cells
 *     engaged) and fetches every module in the eager set at its browser URL.
 *     The first non-200 — or a 200 whose Content-Type is not JavaScript —
 *     fails the call naming the module, the status (or type) and the
 *     static-import chain from the entry that loads it.
 *
 *  Throws on failure; the return value is for the passing case (what was
 *  checked). `config` is a normal `aio.run()` config minus what the harness
 *  owns (port, data dir). Modules outside `baseDir` must be reachable through
 *  `config.serveDirs`, exactly as in the dev server. */
export async function smoke(
  config: CellsConfig = {},
): Promise<SmokeResult> {
  _armTestStrict(); // tests are the strictest environment, never the most permissive
  const start = performance.now();
  const baseDir = resolve(config.baseDir ?? Deno.cwd());
  const entryRel = config.ui?.entry ?? UI_ENTRY;
  const entry = join(baseDir, entryRel);
  try {
    Deno.statSync(entry);
  } catch {
    throw new Error(
      `smoke: no UI entry at ${entry} — pass { baseDir, ui: { entry } } pointing at the app's client entry`,
    );
  }
  const importMap = buildBrowserImportMap(readAppDenoImports(baseDir) ?? {}, {
    vendorImmer: hasVendorImmer(),
  });
  const graph = await validateGraph(
    entry,
    importMap,
    (s, f) => transpile(s, f),
  );
  const blocking = graph.errors.filter((e) =>
    BLOCKING_CATEGORIES.has(e.category)
  );
  if (blocking.length > 0) {
    const lines = blocking.map((e) =>
      `  ${relative(baseDir, e.file)}${
        e.line ? `:${e.line}` : ""
      } [${e.category}] ${e.message}\n    fix: ${e.fix}`
    );
    throw new Error(
      `smoke: ${blocking.length} blocking module error(s) — the browser would blank-screen at boot:\n${
        lines.join("\n")
      }`,
    );
  }

  // Browser URL for every eager module — THE dev server's own decider
  // (`devModuleUrl`), never a copy: a copy said "lives outside baseDir" for
  // `../ui/*` of a nested entry after the dev server learned to serve it.
  const roots = Object.entries(config.serveDirs ?? {}).map(([prefix, dir]) => ({
    withSlash: prefix.endsWith("/") ? prefix : prefix + "/",
    dir: resolve(dir),
  }));
  const srcRoot = devSrcRoot(baseDir);
  const urlFor = (file: string): string => {
    const url = devModuleUrl(file, baseDir, roots, srcRoot);
    if (url !== null) return url;
    throw new Error(
      `smoke: ${file} is eagerly linked from ${entryRel} but lives outside the project (${baseDir}, its deno.json root and every serveDirs root) — the dev server cannot serve it. Add a \`serveDirs\` root or move the module.`,
    );
  };

  // Static-import chain entry → module, for the failure message.
  const parent = new Map<string, string>();
  const queue = [entry];
  while (queue.length) {
    const p = queue.shift()!;
    for (const dep of graph.modules.get(p)?.deps ?? []) {
      if (!graph.eager.has(dep) || parent.has(dep) || dep === entry) continue;
      parent.set(dep, p);
      queue.push(dep);
    }
  }
  const chain = (file: string): string => {
    const out = [relative(baseDir, file)];
    let cur = file;
    while (parent.has(cur)) {
      cur = parent.get(cur)!;
      out.unshift(relative(baseDir, cur));
    }
    return out.join(" → ");
  };

  const targets = [...graph.eager].map((file) => ({ file, url: urlFor(file) }));
  await using srv = await testServer({
    client: "browser",
    ...config,
    baseDir,
  });
  const checked: string[] = [];
  for (const t of targets) {
    const res = await srv.fetch(t.url);
    await res.body?.cancel();
    if (res.status !== 200) {
      throw new Error(
        `smoke: ${t.url} → HTTP ${res.status} — the browser would fail to boot.\n` +
          `  loaded by: ${chain(t.file)}\n` +
          `  fix: ${
            SERVER_FILE_RE.test(t.url)
              ? "a *.server.ts module is never served to the browser; import it dynamically from a cell method (docs/build/imports.md)"
              : "check the file exists under baseDir (or a serveDirs root) and is not a dotfile/protected path"
          }`,
      );
    }
    // A 200 is not a load: a module script whose response is not a JavaScript
    // MIME type is refused by the browser outright (strict MIME checking), so
    // `application/octet-stream` or `text/plain` blank-screens exactly like a
    // 404 does.
    const type = res.headers.get("content-type") ?? "";
    if (!_isJsMime(type)) {
      throw new Error(
        `smoke: ${t.url} → HTTP 200 but Content-Type "${
          type || "(none)"
        }" — the browser refuses a module script that is not served as JavaScript, so it would fail to boot.\n` +
          `  loaded by: ${chain(t.file)}\n` +
          `  fix: import a module the dev server serves as JavaScript (.ts/.tsx/.jsx/.js/.mjs), or move this code into one`,
      );
    }
    checked.push(t.url);
  }
  return { checked, graph, durationMs: performance.now() - start };
}

/** The JavaScript MIME type essences (WHATWG MIME Sniffing §4.6) — the only
 *  types a browser executes as a module script. */
const JS_MIME: ReadonlySet<string> = new Set([
  "application/ecmascript",
  "application/javascript",
  "application/x-ecmascript",
  "application/x-javascript",
  "text/ecmascript",
  "text/javascript",
  "text/javascript1.0",
  "text/javascript1.1",
  "text/javascript1.2",
  "text/javascript1.3",
  "text/javascript1.4",
  "text/javascript1.5",
  "text/jscript",
  "text/livescript",
  "text/x-ecmascript",
  "text/x-javascript",
]);

/** Is this Content-Type header a JavaScript MIME type (parameters ignored,
 *  case-insensitive)? Pure. @internal */
export function _isJsMime(contentType: string): boolean {
  return JS_MIME.has(contentType.split(";")[0]!.trim().toLowerCase());
}
