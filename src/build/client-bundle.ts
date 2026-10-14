// client-bundle.ts — THE browser bundle, built once the same way for every
// consumer, and THE judgement of it (graph-audit + graph-eval).
//
//   `deno task build`  → bundleClient({ write }) → judgeClientBundle → artifact
//   dev boot / reload  → bundleClient({ in memory }) → judgeClientBundle → boot
//
// The dev server used to run its own walker with its own idea of the escape
// hatch, and the two disagreed for weeks (see graph-audit.ts). Now dev asks
// esbuild the same question the build asks, with the same plugins, the same
// import map and the same entry — `write: false` is the only difference —
// and refuses exactly what the build refuses, with the same words.

import {
  basename,
  dirname,
  extname,
  join,
  relative,
  resolve,
  SEPARATOR,
} from "@std/path";
import { BUNDLE_JS, UI_ENTRY, workerBundleName } from "../server/app-files.ts";
import {
  rewriteWorkers,
  workerEntries,
  type WorkerEntry,
} from "../server/graph-validator.ts";
import type { ShareRoot } from "../server/app-dirs.ts";
import { matchShare } from "../server/app-dirs.ts";
import { bundleFrameworkEntries, ESBUILD_JSX } from "./esbuild-shared.ts";
import { _resetServerOnlyStatic, aioBrowserPlugin } from "./esbuild-plugin.ts";
import { makeHttpPlugin } from "./build-integrity.ts";
import type { BuildConfig } from "./build-config.ts";
import {
  attributeReference,
  auditClientGraph,
  type AuditFinding,
  formatAudit,
  type MetaInputs,
} from "./graph-audit.ts";
import { EVAL_USER_AGENT, evaluateBundle } from "./graph-eval.ts";
import { explainServerOnlyImport } from "../server/server-only-specs.ts";
import { readDenoJsonSync } from "../server/deno-json.ts";
import {
  localPrefixAlias,
  prefixAliasMessage,
  untakenAliases,
} from "../server/server-html-importmap.ts";

/** The generated entry's name — esbuild's `stdin.sourcefile`, and therefore
 *  its key in the metafile (the audit walks the graph from it). */
export const BUNDLE_ENTRY_KEY = "_build_entry.tsx";

/** The import specifier for the app's UI entry as written from the
 *  generated bundle entry (which resolves from the app ROOT). */
export function appImportSpecifier(
  root: string,
  appDir: string,
  uiEntry = UI_ENTRY,
): string {
  const rel = relative(root, appDir).replaceAll("\\", "/");
  return rel === "" || rel === "." ? `./${uiEntry}` : `./${rel}/${uiEntry}`;
}

/** The bundle entry point.
 *  Standalone (a local APK, the web target) auto-mounts — the generated
 *  index.html loads the bundle as a classic script, so there is no importer
 *  to call mount(). */
export function makeEntryCode(standalone: boolean, appImport: string): string {
  // The stamps are NOT part of the entry: they go in as esbuild's `banner`,
  // which is prepended verbatim AFTER minification — so the text a reader
  // matches (a stale-bundle check, the artifact e2e) survives, and the
  // globals they set are still the first statements the bundle runs.
  if (standalone) {
    return `\
import { mount as _mount } from 'aio/renderer'
import { ensureConnected } from 'aio/air'
import App from ${JSON.stringify(appImport)}
function boot() { ensureConnected(); _mount(document.getElementById('root'), App) }
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot)
else boot()
`;
  }
  return `\
import { mount as _mount } from 'aio/renderer'
import { ensureConnected } from 'aio/air'
import App from ${JSON.stringify(appImport)}
export function mount(el) { ensureConnected(); _mount(el, App) }
`;
}

/** Resolve `/<share>/…` imports to the declared share directory — the
 *  bundler's half of the ONE spelling the dev server also serves.
 *
 *  A root-absolute import that matches no share is refused with the fix named
 *  when nothing exists at that filesystem path: esbuild would otherwise say
 *  "could not resolve" about a path that is not a path. A real absolute
 *  filesystem path (an import map pointing at one) is left to esbuild. */
export function sharePlugin(shares: readonly ShareRoot[]): {
  name: string;
  // deno-lint-ignore no-explicit-any
  setup(build: any): void;
} {
  return {
    name: "aio-share",
    setup(build) {
      build.onResolve(
        { filter: /^\// },
        (args: { path: string; importer: string }) => {
          const hit = matchShare(shares, args.path);
          if (hit) return { path: join(hit.share.dir, hit.rel) };
          try {
            Deno.statSync(args.path);
            return undefined; // a real absolute path — esbuild's business
          } catch {
            const from = args.importer ? ` (imported by ${args.importer})` : "";
            // aio-ok: path-split — a `/share/…` URL specifier (filter /^\//), not an OS path
            const name = args.path.split("/")[1] ?? "";
            return {
              errors: [{
                text: `"${args.path}"${from} is a root-absolute import, and ` +
                  `no share is declared for "/${name}". A directory outside ` +
                  `the app root is imported as "/<dir>/…" once it is ` +
                  `declared in deno.json: "share": ["../${name}"]` +
                  (shares.length
                    ? ` (declared: ${shares.map((s) => s.prefix).join(", ")})`
                    : ""),
              }],
            };
          }
        },
      );
    },
  };
}

/** Refuse a UI import through a LOCAL import-map prefix key (`"@/": "./src/"`)
 *  with THE sentence the dev server says (`prefixAliasMessage`) — esbuild's
 *  alias cannot take a prefix key, and a raw "Could not resolve" names no
 *  fix. Exported for tests. @internal */
export function prefixAliasPlugin(imports: Record<string, string>): {
  name: string;
  // deno-lint-ignore no-explicit-any
  setup(build: any): void;
} {
  return {
    name: "aio-prefix-alias",
    setup(build) {
      const keys = Object.keys(imports).filter((k) =>
        k.endsWith("/") && localPrefixAlias(k + "x", imports) !== null
      );
      if (keys.length === 0) return;
      const esc = keys.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
      build.onResolve(
        { filter: new RegExp(`^(?:${esc.join("|")})`) },
        (args: { path: string }) => {
          const p = localPrefixAlias(args.path, imports);
          return p
            ? {
              errors: [{ text: prefixAliasMessage(args.path, p.key, p.value) }],
            }
            : undefined;
        },
      );
    },
  };
}

/** The file a worker's bundle is written to — see `workerBundleName`. The
 *  hash is of the script's path in the project and its format, so the name
 *  is the same on every machine and in every rebuild. */
export async function workerFileName(
  root: string,
  entry: Pick<WorkerEntry, "abs" | "format">,
): Promise<string> {
  const rel = relative(root, entry.abs).replaceAll("\\", "/");
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`${rel}\0${entry.format}`),
    ),
  );
  const hash8 = [...digest.slice(0, 4)]
    .map((b) => b.toString(16).padStart(2, "0")).join("");
  return workerBundleName(
    basename(entry.abs, extname(entry.abs)),
    hash8,
  );
}

const WORKER_LOADER: Record<string, string> = {
  ".tsx": "tsx",
  ".jsx": "jsx",
  ".ts": "ts",
  ".mts": "ts",
  ".cts": "ts",
};

/** Follow the one thing no import names: a browser worker's script.
 *
 *  `new Worker(new URL("./w.ts", import.meta.url))` is a URL to esbuild, so
 *  the bundle named a source file no build serves. Each such literal in the
 *  app's own modules (`workerEntries` decides which) is rewritten to
 *  `to(entry)` — the built file beside the bundle, or the dev server's URL
 *  for it — and the caller bundles the script it was told about. A module
 *  that starts no worker is left to esbuild's own loader, byte for byte. */
export function workerPlugin(
  to: (entry: WorkerEntry) => string | Promise<string>,
): {
  name: string;
  // deno-lint-ignore no-explicit-any
  setup(build: any): void;
} {
  return {
    name: "aio-worker",
    setup(build) {
      build.onLoad(
        { filter: /\.[mc]?[jt]sx?$/, namespace: "file" },
        async (args: { path: string }) => {
          // A package's worker is its own build's business, as before.
          if (args.path.includes(`${SEPARATOR}node_modules${SEPARATOR}`)) {
            return undefined;
          }
          let code: string;
          try {
            code = await Deno.readTextFile(args.path);
          } catch {
            return undefined; // aio-ok: esbuild reports the unreadable file itself
          }
          const entries = workerEntries(code, args.path);
          if (entries.length === 0) return undefined;
          const specs = new Map<string, string>();
          for (const e of entries) {
            specs.set(`${e.abs}\0${e.format}`, await to(e));
          }
          return {
            contents: rewriteWorkers(
              code,
              args.path,
              (e) => specs.get(`${e.abs}\0${e.format}`) ?? e.spec,
            ),
            loader: WORKER_LOADER[extname(args.path).toLowerCase()] ?? "js",
          };
        },
      );
    },
  };
}

/** The esbuild module — passed in, never imported here: the build path keeps
 *  a LITERAL `npm:esbuild@…` import (deno prefetches it), the dev path a
 *  computed one (so `am`/compile never pull the native binary). */
// deno-lint-ignore no-explicit-any
export type EsbuildModule = { build: (opts: any) => Promise<any> };

export type ClientBundleOpts = {
  esbuild: EsbuildModule;
  root: string;
  appDir: string;
  uiEntry: string;
  /** The standalone bundle (a local APK, the web target): standalone-air, an
   *  IIFE that auto-mounts. False = the browser bundle (ESM, `mount()`). */
  standalone?: boolean;
  /** @deprecated The former name of `standalone`, still honoured: an app
   *  build script that passes it keeps getting the standalone bundle rather
   *  than a silent browser one. */
  doAndroid?: boolean;
  /** The app's deno.json `imports`. */
  imports: Record<string, string>;
  shares: readonly ShareRoot[];
  /** `<pkg>/src` of a local framework; "" when the framework is remote. */
  frameworkSrcDir: string;
  /** Needed only when remote — the fetched package the bundle resolves from. */
  frameworkBase?: URL;
  /** Present → written to disk (the build); absent → in memory (dev). */
  write?: { outfile: string; banner: string };
  /** Emit a source map beside the bundle. Always `"external"` — esbuild's
   *  linked mode appends a `//# sourceMappingURL=` comment, which makes every
   *  browser that opens devtools fetch a file the server does not serve.
   *  Nothing in the page needs the map: the SERVER applies it, when it turns a
   *  forwarded `app.js:1:22073` back into `src/App.tsx:12:5`. */
  sourcemap?: boolean;
};

export type ClientBundle = {
  ok: boolean;
  errors: string[];
  /** esbuild's warnings, as text (a written build also prints them). */
  warnings?: string[];
  inputs: MetaInputs;
  entryKey: string;
  format: "esm" | "iife";
  /** The bundled code (in memory in dev; read back from `outfile` when
   *  written, so the judge evaluates the bytes that ship). */
  code: string;
  /** The source map's JSON, when one was asked for and esbuild produced it.
   *  In memory: nothing writes it to the app's tree in dev. */
  map?: string;
  /** What each input contributed to the emitted bundle, in bytes after
   *  tree-shaking and minification — see `bundle-analyze.ts`. */
  bytesInOutput?: Record<string, number>;
  /** The browser workers the graph starts (`workerPlugin`), each bundled the
   *  way the app is — a worker's own workers included. Written beside the
   *  bundle by the build; empty for an app that starts none. */
  workers: WorkerBundle[];
  /** The workers that could NOT be bundled: each one's `new Worker(new
   *  URL(…))` is left exactly as written and no file is emitted for it — the
   *  bundle is `ok` all the same. Empty when every worker bundled. */
  workersSkipped: SkippedWorker[];
  ms: number;
};

/** A browser worker aio could not bundle — see `ClientBundle.workersSkipped`. */
export type SkippedWorker = {
  /** The worker's script, relative to the project root. */
  entryKey: string;
  /** Why: esbuild's first error, or the server-only module it reaches. */
  reason: string;
  /** What the verdict was read from (absolute): the files esbuild loaded and
   *  the paths it looked for and did not find. Unchanged → the same verdict. */
  watch: string[];
};

/** THE sentence for a worker that was not bundled — the build prints it and
 *  the dev server prints it. */
export function skippedWorkerMessage(s: SkippedWorker): string {
  return `the worker ${s.entryKey} cannot be bundled — ${s.reason} — so ` +
    `its \`new Worker(new URL(…))\` is left as written: the app builds, ` +
    `and this worker does not run in the built app (it names a source ` +
    `file no build serves).`;
}

/** One browser worker's bundle. */
export type WorkerBundle = {
  /** Its file name beside `app.js` (`workerFileName`). */
  name: string;
  code: string;
  /** Its entry's key in `inputs`, and the graph esbuild read for it. */
  entryKey: string;
  inputs: MetaInputs;
};

/** A classic-script (iife) bundle has no `import.meta`: esbuild turns it into
 *  `{}`, so `import.meta.url` is undefined — and `isRunningFromSource()`
 *  called `.startsWith` on it on EVERY dispatch in a standalone APK. Every
 *  button of every standalone Android app threw a REDUCE_ERROR from
 *  1.0.0-beta to 1.0.4-beta; the e2e suites all run the ESM bundle, where it
 *  is a real URL. Give the two fields the framework reads their real values:
 *  the script's own URL, and "not the main module". Anything else under
 *  `import.meta` stays esbuild's `{}`, and esbuild's warning names it. */
const IIFE_META_BANNER = "var __aioScriptUrl=(function(){" +
  "try{var s=document.currentScript.src;if(typeof s==='string'&&s)return s}catch(e){}" +
  "try{return String(location.href)}catch(e){return ''}})();";
const IIFE_META_DEFINE = {
  "import.meta.url": "__aioScriptUrl",
  "import.meta.main": "false",
};

/** A classic worker has no `import.meta` either, and no `document`: its own
 *  URL is `self.location`. */
const WORKER_IIFE_DEFINE = {
  "import.meta.url": "self.location.href",
  "import.meta.main": "false",
};

/** Bundle ONE browser worker's script — the app's alias, plugins and module
 *  resolution, the worker's own format. `to` names where each worker THIS
 *  one starts will be found (see `workerPlugin`). Used by `bundleClient` for
 *  every worker of a build, and by the dev server for the one a page asks
 *  for. */
export async function bundleWorker(
  opts: ClientBundleOpts,
  entry: Pick<WorkerEntry, "abs" | "format">,
  to: (entry: WorkerEntry) => string | Promise<string>,
): Promise<Omit<WorkerBundle, "name"> & { errors: string[]; watch: string[] }> {
  const { alias, plugins } = bundleResolution(opts, to);
  const key = relative(opts.root, entry.abs).replaceAll("\\", "/");
  // What esbuild read: a build that fails names no inputs.
  const loaded = new Set<string>();
  plugins.unshift({
    name: "aio-worker-inputs",
    // deno-lint-ignore no-explicit-any
    setup(build: any) {
      build.onLoad(
        { filter: /.*/, namespace: "file" },
        (a: { path: string }) => {
          loaded.add(a.path);
          return undefined;
        },
      );
    },
  });
  try {
    const r = await opts.esbuild.build({
      entryPoints: [entry.abs],
      absWorkingDir: opts.root,
      bundle: true,
      format: entry.format,
      platform: "browser",
      target: "esnext",
      minify: true,
      write: false,
      ...ESBUILD_JSX,
      ...(entry.format === "iife" ? { define: WORKER_IIFE_DEFINE } : {}),
      alias,
      plugins,
      nodePaths: bundleNodePaths(opts.root),
      // Silent: a worker that cannot be bundled is a warning the caller
      // words (`skippedWorkerMessage`), not esbuild's red ERROR in a build
      // that goes on.
      logLevel: "silent",
      metafile: true,
    });
    return {
      code: r.outputFiles?.[0]?.text ?? "",
      entryKey: key,
      inputs: r.metafile?.inputs ?? {},
      errors: [],
      watch: [...loaded],
    };
  } catch (e) {
    const list = (e as {
      errors?: { text?: string; location?: { file?: string; line?: number } }[];
    }).errors ?? [];
    // A path esbuild looked for and did not find is read too: created, the
    // verdict changes though no loaded file did.
    const sought = list.flatMap((m) => {
      const spec = /^Could not resolve "([^"]+)"/.exec(m.text ?? "")?.[1];
      if (!spec) return [];
      if (/^\.\.?\//.test(spec)) {
        return m.location?.file
          ? [resolve(opts.root, dirname(m.location.file), spec)]
          : [];
      }
      return bundleNodePaths(opts.root).map((nm) => join(nm, spec));
    });
    return {
      code: "",
      entryKey: key,
      inputs: {},
      errors: list.length
        ? list.map((m) =>
          `${m.location?.file ?? key}${
            m.location?.line ? `:${m.location.line}` : ""
          }: ${m.text}`
        )
        : [String(e)],
      watch: [...new Set([...loaded, ...sought])],
    };
  }
}

/** Why a worker was built as "iife", for the author who wrote no such word. */
const CLASSIC_WORKER_HINT =
  `aio builds this worker as a classic script ("iife"): it read no ` +
  `\`{ type: "module" }\` in the \`new Worker(…)\` call. Write the options ` +
  `there as a literal — a variable, a spread or a computed \`type\` is not ` +
  `read`;

/** Can this worker be bundled, and may its bundle ship? A worker's own
 *  question — its imports and what they reach, never the workers IT starts
 *  (those are left as written here, and named in `nested`). Asked by the
 *  build of every worker and by the dev server of the one a page starts, so
 *  both leave the same workers alone. */
export async function probeWorker(
  opts: ClientBundleOpts,
  entry: Pick<WorkerEntry, "abs" | "format">,
): Promise<
  & Omit<WorkerBundle, "name">
  & { nested: WorkerEntry[]; watch: string[]; skipped?: SkippedWorker }
> {
  const nested: WorkerEntry[] = [];
  const w = await bundleWorker(opts, entry, (e) => {
    nested.push(e);
    return e.spec;
  });
  // A server-only module in a worker's bundle would ship as the page's would.
  const failed = w.errors[0];
  // A package only the worker imports is installed from the WORKER: the UI
  // entry never reaches it.
  const install = failed &&
    explainMissingPackage(failed, opts.root, w.entryKey);
  // A classic worker cannot `await` at its top level, and esbuild's sentence
  // names a format the author never chose: it is what aio builds when the
  // `new Worker(…)` call carries no `{ type: "module" }` it can READ.
  const classic = failed && entry.format === "iife" &&
    /"iife" output format/.test(failed);
  const reason = failed
    ? failed + (install ? ` (${install})` : "") +
      (classic ? ` (${CLASSIC_WORKER_HINT})` : "")
    : workerLeaks(w, opts.root).join(" ");
  return {
    ...w,
    nested,
    ...(reason
      ? { skipped: { entryKey: w.entryKey, reason, watch: w.watch } }
      : {}),
  };
}

/** What every bundle of one app resolves with: the alias table and the
 *  plugins. */
function bundleResolution(
  opts: ClientBundleOpts,
  worker: (entry: WorkerEntry) => string | Promise<string>,
) {
  const o = { ...opts, standalone: opts.standalone ?? opts.doAndroid ?? false };
  const isRemote = !o.frameworkSrcDir;
  // THE `aio*` table (bundleFrameworkEntries) is package-root relative;
  // frameworkSrcDir is `<pkg>/src`. A remote (JSR) framework has no local
  // files at all — makeHttpPlugin applies the SAME table against the fetched
  // package instead.
  const aioImports = isRemote ? {} : Object.fromEntries(
    Object.entries(bundleFrameworkEntries(o.standalone)).map((
      [spec, rel],
    ) => [spec, join(resolve(o.frameworkSrcDir, ".."), rel)]),
  );
  // esbuild alias: skip npm:/jsr: specifiers (resolved via node_modules), and
  // PREFIX keys (`"@/"`) — esbuild's alias rejects them outright ("Invalid
  // alias name"); a UI import through a local one gets THE aio sentence the
  // dev server says too (prefixAliasPlugin).
  const alias: Record<string, string> = {};
  for (
    const [k, v] of Object.entries({
      ...untakenAliases(o.imports, aioImports),
      ...aioImports,
    })
  ) {
    if (k.endsWith("/")) continue;
    if (!v.startsWith("npm:") && !v.startsWith("jsr:")) alias[k] = v;
  }
  const plugins = [
    aioBrowserPlugin(),
    ...(isRemote && o.frameworkBase
      ? [makeHttpPlugin(
        {
          frameworkBase: o.frameworkBase,
          standalone: o.standalone,
          root: o.root,
        } as BuildConfig,
      )]
      : []),
    sharePlugin(o.shares),
    prefixAliasPlugin({ ...o.imports, ...aioImports }),
    workerPlugin(worker),
  ];
  return { alias, plugins };
}

/** Build the browser bundle. One esbuild invocation, one option set — and
 *  one more per browser worker the graph starts (`workerPlugin`). */
export async function bundleClient(
  opts: ClientBundleOpts,
): Promise<ClientBundle> {
  const t0 = performance.now();
  const o = { ...opts, standalone: opts.standalone ?? opts.doAndroid ?? false };
  // Each worker a module starts, by the file it will be written to — probed
  // BEFORE the module that starts it is rewritten: one that cannot be
  // bundled keeps its literal (what a build emitted before workers were, where
  // the build was green and that worker did not run), and the build goes on.
  type Probed = Awaited<ReturnType<typeof probeWorker>> & {
    entry: WorkerEntry;
  };
  const found = new Map<string, Promise<Probed>>();
  const probed = (name: string, entry: WorkerEntry) => {
    let p = found.get(name);
    if (!p) {
      p = probeWorker(o, entry).then(async (r) => {
        // The workers it starts are this build's too.
        for (const n of r.nested) probed(await workerFileName(o.root, n), n);
        return { ...r, entry };
      });
      found.set(name, p);
    }
    return p;
  };
  const worker = async (e: WorkerEntry) => {
    const name = await workerFileName(o.root, e);
    return (await probed(name, e)).skipped ? e.spec : `./${name}`;
  };
  const { alias, plugins } = bundleResolution(o, worker);
  const format = o.standalone ? "iife" : "esm";
  // The stamps (when written) and, for a classic script, the import.meta shim.
  const banner = [o.write?.banner, format === "iife" ? IIFE_META_BANNER : ""]
    .filter(Boolean).join("\n");
  _resetServerOnlyStatic();
  let result: {
    errors?: unknown[];
    warnings?: { text: string }[];
    metafile?: {
      inputs: MetaInputs;
      /** Per OUTPUT file, what each input contributed to it AFTER tree-shaking
       *  and minification. The only honest size attribution — a 400 KB
       *  dependency that shakes down to 3 KB is not a 400 KB problem, and a
       *  report saying it is costs someone a day. */
      outputs?: Record<
        string,
        { inputs?: Record<string, { bytesInOutput?: number }> }
      >;
    };
    outputFiles?: Array<{ text: string; path?: string }>;
  };
  try {
    result = await o.esbuild.build({
      // The generated entry is fed on stdin, resolving from the app root: no
      // temp file in the user's tree (the dev watcher would see one, and the
      // build had to delete it in a `finally`).
      stdin: {
        contents: makeEntryCode(
          o.standalone,
          appImportSpecifier(o.root, o.appDir, o.uiEntry),
        ),
        resolveDir: o.root,
        sourcefile: BUNDLE_ENTRY_KEY,
        loader: "tsx",
      },
      absWorkingDir: o.root,
      bundle: true,
      // classic <script> in the WebView HTML — ESM would throw on `export`
      format,
      platform: "browser",
      target: "esnext",
      // A built artifact is what ships: minified. Export names survive
      // (`mount` is what the shell calls), stack traces keep the source map
      // when the app asks for one — and the counter app measured 302 KB
      // raw / 79 KB gzipped without this, 139 KB / 51 KB with.
      minify: true,
      // See `ClientBundleOpts.sourcemap`. `"external"` needs an `outfile` even
      // when nothing is written — esbuild refuses otherwise ("Cannot use an
      // external source map without an output path"), so the in-memory path
      // names one it never creates.
      // No `sourcesContent`: the map is read by the SERVER to remap stack
      // positions (diagnostics/stack-remap.ts) and never served, so the
      // embedded copy of every source file was dead weight — 3.5 MB of a
      // 5.2 MB map, inside every compiled binary (2026-09-17).
      ...(o.sourcemap
        ? { sourcemap: "external" as const, sourcesContent: false }
        : {}),
      ...(o.write ? { outfile: o.write.outfile } : {
        write: false,
        ...(o.sourcemap ? { outfile: BUNDLE_JS } : {}),
      }),
      ...(banner ? { banner: { js: banner } } : {}),
      ...ESBUILD_JSX,
      ...(format === "iife" ? { define: IIFE_META_DEFINE } : {}),
      alias,
      plugins,
      nodePaths: bundleNodePaths(o.root),
      logLevel: o.write ? "warning" : "silent",
      // The module graph esbuild actually read — the freshness cache stats
      // THESE, and the audit judges THESE.
      metafile: true,
    });
  } catch (e) {
    return {
      ok: false,
      errors: [String(e)],
      inputs: {},
      entryKey: BUNDLE_ENTRY_KEY,
      format,
      code: "",
      workers: [],
      workersSkipped: [],
      ms: performance.now() - t0,
    };
  }
  const errors = (result.errors ?? []).map((e) => {
    const text = typeof e === "object" && e && "text" in e
      ? String((e as { text: unknown }).text)
      : String(e);
    const where = typeof e === "object" && e && "location" in e
      ? (e as { location?: { file?: string; line?: number } }).location
      : undefined;
    // The most likely build error a new author hits, said in aio's words
    // rather than the bundler's — see `explainServerOnlyImport`.
    return explainServerOnlyImport(text, where?.file, where?.line) ?? text;
  });
  // `outputFiles` carries BOTH the map and the code when a map was asked for,
  // and the order is esbuild's business — selecting by index gave the map as
  // the bundle the first time this ran. Select by name.
  const outs = result.outputFiles ?? [];
  const jsOut = outs.find((f) => !(f.path ?? "").endsWith(".map")) ?? outs[0];
  const mapOut = outs.find((f) => (f.path ?? "").endsWith(".map"));
  const code = o.write
    ? await Deno.readTextFile(o.write.outfile).catch(() => "")
    : jsOut?.text ?? "";
  const map = o.write
    ? await Deno.readTextFile(`${o.write.outfile}.map`).catch(() => undefined)
    : mapOut?.text;
  // Size attribution, from the metafile the graph audit already asks for. The
  // JS output, not the map: a map's own "inputs" would double every module.
  const outs2 = Object.entries(result.metafile?.outputs ?? {})
    .filter(([name]) => !name.endsWith(".map"));
  const bytesInOutput: Record<string, number> | undefined = outs2.length > 0
    ? Object.fromEntries(
      outs2.flatMap(([, o2]) =>
        Object.entries(o2.inputs ?? {}).map((
          [input, v],
        ) => [input, v.bytesInOutput ?? 0])
      ),
    )
    : undefined;
  // The workers, and theirs: `found` grows while a worker's own graph is read.
  const workers: WorkerBundle[] = [];
  const workersSkipped: SkippedWorker[] = [];
  for (let i = 0; i < found.size; i++) {
    const [name, pending] = [...found][i]!;
    const p = await pending;
    if (p.skipped) {
      workersSkipped.push(p.skipped);
      continue;
    }
    // The probe left the workers it starts as written: bundled once more,
    // pointing at the ones that bundled.
    const w = p.nested.length ? await bundleWorker(o, p.entry, worker) : p;
    workers.push({
      name,
      code: w.code,
      entryKey: w.entryKey,
      inputs: w.inputs,
    });
  }
  return {
    ok: errors.length === 0,
    errors,
    warnings: (result.warnings ?? []).map((w) => w.text),
    inputs: result.metafile?.inputs ?? {},
    ...(bytesInOutput ? { bytesInOutput } : {}),
    entryKey: BUNDLE_ENTRY_KEY,
    format,
    code,
    ...(map ? { map } : {}),
    workers,
    workersSkipped,
    ms: performance.now() - t0,
  };
}

export type BundleJudgement = {
  ok: boolean;
  findings: AuditFinding[];
  /** The refusal, as the build prints it (empty when ok). */
  lines: string[];
  /** Module-scope Node globals the bundle touches and SURVIVES — something
   *  defined them before the module ran. Worth saying (the app is one import
   *  order away from a blank page); not worth refusing (it loads). */
  notes: string[];
  auditMs: number;
  evalMs: number;
};

/** Judge a bundle: the static audit (graph-audit.ts) and the evaluation
 *  (graph-eval.ts). Same function for the build and the dev server.
 *
 *  Which one DECIDES depends on the rule, because they answer different
 *  questions:
 *
 *  - a server-only leak is about what the artifact CONTAINS — a key in
 *    dist/app.js is shipped whether or not the page paints, and no evaluation
 *    can see it. The audit decides, and the bundle is not even run.
 *  - a module-scope Node global is about whether the bundle LOADS, and there
 *    the evaluation is the truth: the scan cannot see the shim that defines
 *    `Buffer` two imports earlier (the fix aio itself prescribes), and refusing
 *    on the scan alone refuses a bundle that loads. So the bundle is run with
 *    the Node globals deleted; if it loads, the findings are notes. If it does
 *    NOT load, the scan is what turns `ReferenceError: Buffer is not defined`
 *    into a file and a line.
 *
 *  Nothing that cannot load ships either way — the evaluator is strictly
 *  stronger than the scan for load errors (it also caught the static class
 *  field the scan misses). */
export async function judgeClientBundle(
  b: Pick<ClientBundle, "inputs" | "entryKey" | "format" | "code">,
  root: string,
  opts: { shell?: "browser" | "electron"; signal?: AbortSignal } = {},
): Promise<BundleJudgement> {
  const t0 = performance.now();
  const cache = new Map<string, string | undefined>();
  const source = (p: string): string | undefined => {
    if (cache.has(p)) return cache.get(p);
    let s: string | undefined;
    try {
      s = Deno.readTextFileSync(resolve(root, p));
    } catch {
      s = undefined; // stub / virtual / remote input — nothing to scan
    }
    cache.set(p, s);
    return s;
  };
  const rel = (p: string) => p;
  const audit = auditClientGraph({
    entry: b.entryKey,
    inputs: b.inputs,
    source,
    hideEntry: true,
  });
  const auditMs = performance.now() - t0;
  const refuse = (
    findings: AuditFinding[],
    evalMs: number,
  ): BundleJudgement => ({
    ok: false,
    findings,
    lines: formatAudit({ ok: false, findings, reached: [] }, rel),
    notes: [],
    auditMs,
    evalMs,
  });
  // Contents, not load: refused on the audit alone, and the bundle is not run
  // (one cause, reported once).
  const leaks = audit.findings.filter((f) => f.rule === "server-only-leak");
  if (leaks.length) return refuse(leaks, 0);
  const globals = audit.findings.filter((f) => f.rule === "node-global");
  const ev = await evaluateBundle(b.code, b.format, 10_000, {
    userAgent: EVAL_USER_AGENT[opts.shell ?? "browser"],
    signal: opts.signal,
  });
  // Stopped (the dev server closed mid-check): no verdict, so no refusal.
  if (ev.ok || ev.name === "aborted") {
    return {
      ok: true,
      findings: [],
      lines: [],
      notes: globals.map((f) =>
        `${rel(f.file)}${
          f.line ? `:${f.line}` : ""
        } touches \`${f.target}\` at ` +
        "module scope and the bundle still loads — something defines it first. " +
        "Keep that definition imported BEFORE it."
      ),
      auditMs,
      evalMs: ev.ms,
    };
  }
  // It did not load. The scan's findings for the name that threw ARE the
  // attribution — file, line, and the chain that pulled the module in.
  const explained = ev.undefinedName
    ? globals.filter((f) => f.target === ev.undefinedName)
    : [];
  if (explained.length) return refuse(explained, ev.ms);
  const where = ev.undefinedName
    ? attributeReference(ev.undefinedName, audit.reached, source)
    : [];
  const finding: AuditFinding = {
    rule: "load-error",
    file: where[0] ?? basename(b.entryKey),
    target: ev.undefinedName ?? ev.name,
    chain: [],
    message: `the browser bundle cannot load: ${ev.name}: ${ev.message} — ` +
      "every module's top level runs once at load, and this one throws " +
      "there, so the page is blank before the app starts",
    fix: ev.undefinedName
      ? `\`${ev.undefinedName}\` is referenced at load by ` +
        (where.length
          ? `${where.slice(0, 5).join(", ")}${
            where.length > 5 ? ` (+${where.length - 5} more)` : ""
          }`
          : "a module aio could not attribute (no reached source mentions it)") +
        ". A browser has no such global and aio does not polyfill Node. " +
        "Keep that dependency server-side (a `*.server.ts` module, " +
        "dynamic-imported from a cell method), or provide the global from a " +
        "module imported BEFORE it if it truly must run in the browser."
      : "Run the app in a browser with devtools open for the stack; the " +
        "same throw happens there at load.",
  };
  return refuse([finding], ev.ms);
}

/** The server-only modules ONE worker's bundle carries, in the audit's words
 *  — empty when it carries none. Such a worker is not shipped
 *  (`probeWorker`). */
function workerLeaks(
  w: Pick<WorkerBundle, "entryKey" | "inputs">,
  root: string,
): string[] {
  const findings = auditClientGraph({
    entry: w.entryKey,
    inputs: w.inputs,
    source: (p) => {
      try {
        return Deno.readTextFileSync(resolve(root, p));
      } catch {
        return undefined; // stub / virtual / remote input — nothing to scan
      }
    },
  }).findings.filter((f) => f.rule === "server-only-leak");
  return findings.length
    ? formatAudit({ ok: false, findings, reached: [] }, (p) => p)
    : [];
}

/** Where esbuild may look for an npm package that a file OUTSIDE the app
 *  imports — the framework's own files, when aio is path-pinned: the app's
 *  `node_modules`, then that of the nearest enclosing PROJECT (a directory with a
 *  `deno.json`, `deno.jsonc` or `package.json`).
 *
 *  The enclosing ones are for a workspace: Deno installs a member's packages
 *  into the workspace ROOT's `node_modules`, so the member's own does not
 *  exist and the framework's `import "immer"` could not be resolved ("Could
 *  not resolve "immer"") — while the dev server, which asks Deno
 *  (`import.meta.resolve`), served the same app. It went unseen because
 *  aio's own checkout has a `node_modules` that node's walk-up reached from
 *  the framework files; a checkout without one (a real Mac, a Windows VM,
 *  a fresh clone) showed it. A stray `node_modules` in a directory that is no
 *  project (`~/node_modules`) is not taken, nor is anything above the nearest
 *  enclosing project or above the app's repository. `exists` is a seam for the test. */
export function bundleNodePaths(
  root: string,
  exists: (path: string) => boolean = (p) => {
    try {
      Deno.statSync(p);
      return true;
    } catch {
      return false; // aio-ok: absent (or unreadable) is "not there"
    }
  },
): string[] {
  const out = [join(root, "node_modules")];
  // An app that is its OWN repository root has nothing enclosing it that is
  // its: the `.git` stop below is tested on ancestors only, so without this
  // `~/proj/app/.git` still took `~/node_modules` beside `~/package.json`.
  // (A workspace member is never its own repository root.)
  if (exists(join(resolve(root), ".git"))) return out;
  for (let dir = dirname(resolve(root));; dir = dirname(dir)) {
    const nm = join(dir, "node_modules");
    if (
      exists(nm) &&
      ["deno.json", "deno.jsonc", "package.json"].some((f) =>
        exists(join(dir, f))
      )
    ) {
      // The NEAREST enclosing project is the workspace root; one further up
      // is somebody else's (`~/package.json` beside `~/node_modules`).
      out.push(nm);
      break;
    }
    // Never above the repository the app lives in.
    if (exists(join(dir, ".git")) || dirname(dir) === dir) break;
  }
  return out;
}

/** esbuild's `Could not resolve "<pkg>"` for a PACKAGE that no `node_modules`
 *  the bundle searches holds, said with the command that puts it there: a
 *  checkout whose packages were never installed (amui before its first run)
 *  failed with the bundler's bare line, which names no fix. `--entrypoint`
 *  installs what the UI reaches and adds nothing to the project's lock.
 *
 *  That command only helps a project that HAS a `node_modules`: with no
 *  `nodeModulesDir` in its deno.json (and no package.json) Deno installs into
 *  its global cache, exits 0 and creates no folder — the advice was followed
 *  and the build failed with the same line (measured, Deno 2.9.7). So the
 *  setting is named first when no deno.json from `root` up to the repository
 *  declares it; in a workspace it belongs in the workspace root's file.
 *  Null for any other error. `exists` and `config` are seams for the test. */
export function explainMissingPackage(
  text: string,
  root: string,
  uiEntry: string,
  exists?: (path: string) => boolean,
  config: (dir: string) => Record<string, unknown> | null = (dir) =>
    readDenoJsonSync(dir)?.config ?? null,
): string | null {
  const pkg = /Could not resolve "((?:@[\w.-]+\/)?[\w][\w.-]*)(?:\/[^"]*)?"/
    .exec(text)?.[1];
  if (!pkg || pkg === "aio") return null; // the framework is an alias, not a package
  const has = exists ?? ((p: string) => {
    try {
      Deno.statSync(p);
      return true;
    } catch {
      return false; // aio-ok: absent (or unreadable) is "not there"
    }
  });
  if (bundleNodePaths(root, has).some((nm) => has(join(nm, pkg)))) return null;
  // Does `deno install` create a node_modules here, and if not, which file
  // takes the setting: the same upward walk `bundleNodePaths` does.
  let installs = has(join(root, "package.json"));
  let owner = resolve(root);
  for (let dir = owner; !installs; dir = dirname(dir)) {
    const c = config(dir);
    const mode = c?.nodeModulesDir;
    if (mode !== undefined && mode !== "none" && mode !== false) {
      installs = true;
    } else if (c?.workspace !== undefined) owner = dir;
    if (has(join(dir, ".git")) || dirname(dir) === dir) break;
  }
  const first = installs
    ? "run"
    : `add \`"nodeModulesDir": "auto"\` to ${
      join(owner, "deno.json")
    } (without it \`deno install\` exits 0 and creates no node_modules), ` +
      `then run`;
  return `the package "${pkg}" is not installed in ${
    join(root, "node_modules")
  } — ${first} \`deno install --entrypoint ${uiEntry}\` in ${root}, then build again`;
}
