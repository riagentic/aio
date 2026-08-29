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

import { basename, join, relative, resolve } from "@std/path";
import { UI_ENTRY } from "../server/app-files.ts";
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
 *  Android (standalone WebView) auto-mounts — the generated index.html loads
 *  the bundle as a classic script, so there is no importer to call mount(). */
export function makeEntryCode(doAndroid: boolean, appImport: string): string {
  // The stamps are NOT part of the entry: they go in as esbuild's `banner`,
  // which is prepended verbatim AFTER minification — so the text a reader
  // matches (a stale-bundle check, the artifact e2e) survives, and the
  // globals they set are still the first statements the bundle runs.
  if (doAndroid) {
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
  doAndroid: boolean;
  /** The app's deno.json `imports`. */
  imports: Record<string, string>;
  shares: readonly ShareRoot[];
  /** `<pkg>/src` of a local framework; "" when the framework is remote. */
  frameworkSrcDir: string;
  /** Needed only when remote — the fetched package the bundle resolves from. */
  frameworkBase?: URL;
  /** Present → written to disk (the build); absent → in memory (dev). */
  write?: { outfile: string; banner: string };
};

export type ClientBundle = {
  ok: boolean;
  errors: string[];
  inputs: MetaInputs;
  entryKey: string;
  format: "esm" | "iife";
  /** The bundled code (in memory in dev; read back from `outfile` when
   *  written, so the judge evaluates the bytes that ship). */
  code: string;
  ms: number;
};

/** Build the browser bundle. One esbuild invocation, one option set. */
export async function bundleClient(o: ClientBundleOpts): Promise<ClientBundle> {
  const t0 = performance.now();
  const isRemote = !o.frameworkSrcDir;
  // THE `aio*` table (bundleFrameworkEntries) is package-root relative;
  // frameworkSrcDir is `<pkg>/src`. A remote (JSR) framework has no local
  // files at all — makeHttpPlugin applies the SAME table against the fetched
  // package instead.
  const aioImports = isRemote ? {} : Object.fromEntries(
    Object.entries(bundleFrameworkEntries(o.doAndroid)).map((
      [spec, rel],
    ) => [spec, join(resolve(o.frameworkSrcDir, ".."), rel)]),
  );
  // esbuild alias: skip npm:/jsr: specifiers (resolved via node_modules)
  const alias: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...o.imports, ...aioImports })) {
    if (!v.startsWith("npm:") && !v.startsWith("jsr:")) alias[k] = v;
  }
  const format = o.doAndroid ? "iife" : "esm";
  _resetServerOnlyStatic();
  const plugins = [
    aioBrowserPlugin(),
    ...(isRemote && o.frameworkBase
      ? [makeHttpPlugin(
        {
          frameworkBase: o.frameworkBase,
          doAndroid: o.doAndroid,
          root: o.root,
        } as BuildConfig,
      )]
      : []),
    sharePlugin(o.shares),
  ];
  let result: {
    errors?: unknown[];
    metafile?: { inputs: MetaInputs };
    outputFiles?: Array<{ text: string }>;
  };
  try {
    result = await o.esbuild.build({
      // The generated entry is fed on stdin, resolving from the app root: no
      // temp file in the user's tree (the dev watcher would see one, and the
      // build had to delete it in a `finally`).
      stdin: {
        contents: makeEntryCode(
          o.doAndroid,
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
      ...(o.write
        ? { outfile: o.write.outfile, banner: { js: o.write.banner } }
        : { write: false }),
      ...ESBUILD_JSX,
      alias,
      plugins,
      nodePaths: [join(o.root, "node_modules")],
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
  const code = o.write
    ? await Deno.readTextFile(o.write.outfile).catch(() => "")
    : result.outputFiles?.[0]?.text ?? "";
  return {
    ok: errors.length === 0,
    errors,
    inputs: result.metafile?.inputs ?? {},
    entryKey: BUNDLE_ENTRY_KEY,
    format,
    code,
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
  opts: { shell?: "browser" | "electron" } = {},
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
  });
  if (ev.ok) {
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
