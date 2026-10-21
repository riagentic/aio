// aiol — files the page loads that dev serves and no artifact carries.
//
// Field report (JotWord §1): a Rust/WASM core loaded with
// `new URL("./xcore_bg.wasm", import.meta.url)` worked in dev and 404'd in
// the AppImage with every gate green. Three findings, before any build:
//   1. a browser module's `new URL("<file>", import.meta.url)` that no
//      deno.json `assets` mount answers once bundled (the build's own decider,
//      src/build/asset-urls.ts — one rule, two readers);
//   2. a browser `fetch` of a path under `src/` — the module tree is served
//      in dev only;
//   3. an `aio.run({ assets })` mount deno.json does not declare (or declares
//      with another directory): served in dev, 404 from every artifact, which
//      embeds deno.json's mounts only. The reverse — deno.json alone — is the
//      ONE declaration both the server and the build read (since 1.0.20), so
//      it is never a finding.

import { dirname, join, resolve } from "@std/path";
import type { Checker, SourceFile } from "./types.ts";
import { isTestPath, isToolingPath } from "./context.ts";
import { codeText, moduleStatements } from "./scan.ts";
import { isServerOnlyFile } from "../src/entries.ts";
import {
  mountsOf,
  unmountedAssetUrlMessage,
  unmountedAssetUrls,
} from "../src/build/asset-urls.ts";

const lineAt = (src: string, at: number) => src.slice(0, at).split("\n").length;

/** The files the browser bundle holds: components and cell modules, closed
 *  over static, non-type, local imports — never across a `*.server.ts`. */
function browserGraph(
  roots: readonly SourceFile[],
  all: readonly SourceFile[],
): SourceFile[] {
  const byPath = new Map(all.map((f) => [f.path, f]));
  const seen = new Set<SourceFile>();
  const queue: SourceFile[] = [];
  const visit = (f: SourceFile | undefined) => {
    if (!f || seen.has(f)) return;
    if (isToolingPath(f.relative) || isTestPath(f.relative)) return;
    if (isServerOnlyFile(f.relative)) return;
    seen.add(f);
    queue.push(f);
  };
  roots.forEach(visit);
  while (queue.length) {
    const f = queue.shift()!;
    for (const st of moduleStatements(f.content)) {
      if (st.typeOnly || !/^\.{1,2}\//.test(st.spec)) continue;
      const t = resolve(dirname(f.path), st.spec);
      visit(byPath.get(t) ?? byPath.get(t + ".ts") ?? byPath.get(t + ".tsx"));
    }
  }
  return [...seen];
}

/** Pure: the literal `assets: { "/x": "./y", … }` inside `aio.run(…)`. */
export function runAssetMounts(
  src: string,
): { prefix: string; dir: string; line: number }[] {
  const code = codeText(src);
  const run = code.search(/\baio\s*\.\s*run\s*\(/);
  if (run === -1) return [];
  const key = /\bassets\s*:\s*\{/g;
  key.lastIndex = run;
  const m = key.exec(code);
  if (!m) return [];
  const open = m.index + m[0].length;
  const close = code.indexOf("}", open);
  if (close === -1) return [];
  const body = src.slice(open, close);
  return [...body.matchAll(/(['"])([^'"]+)\1\s*:\s*(['"])([^'"]+)\3/g)].map(
    (p) => ({
      prefix: p[2]!,
      dir: p[4]!,
      line: lineAt(src, open + p.index!),
    }),
  );
}

const norm = (d: string) => d.trim().replace(/^\.\//, "").replace(/\/+$/, "");

export const checkAssetUrls: Checker = (ctx) => {
  const { projectDir, report, pass } = ctx;
  const declared = ctx.denoJson?.assets;
  const mounts = mountsOf(declared);
  const isFile = (rel: string) => {
    try {
      return Deno.statSync(join(projectDir, rel)).isFile;
    } catch {
      return false; // aio-ok: absent is "not a file"
    }
  };
  let found = 0;
  const graph = browserGraph(
    [...ctx.tsxFiles, ...ctx.cells.map((c) => c.file)],
    ctx.sourceFiles,
  );
  for (const f of graph) {
    for (
      const u of unmountedAssetUrls({
        module: f.relative,
        src: f.content,
        mounts,
        isFile,
      })
    ) {
      const [headline, fix] = unmountedAssetUrlMessage(f.relative, u);
      report("warn", "build", headline, {
        file: f.relative,
        line: u.line,
        fix,
      });
      found++;
    }
    const code = codeText(f.content);
    for (const m of code.matchAll(/\bfetch\s*\(\s*/g)) {
      const at = m.index! + m[0].length;
      const lit = /^(['"`])(\.?\/)?(src\/[^'"`\n]*)\1/.exec(
        f.content.slice(at),
      );
      if (!lit) continue;
      const path = "/" + lit[3]!;
      if (mounts.some((mt) => path.startsWith(mt.prefix + "/"))) continue;
      report(
        "warn",
        "build",
        `${f.relative}:${lineAt(f.content, at)} — fetch("${
          lit[0].slice(1, -1)
        }") ` +
          `reads the module tree, which dev serves and no artifact does ` +
          `(they serve the bundle and the deno.json "assets" mounts) — 404 ` +
          `in the packaged app`,
        {
          file: f.relative,
          line: lineAt(f.content, at),
          fix:
            `Move the file into a mount — deno.json "assets": { "/assets": ` +
            `"./assets" } — and fetch it from there`,
        },
      );
      found++;
    }
  }
  const entry = ctx.appEntry;
  if (entry) {
    const fromJson = new Map(
      mounts.map((mt) => [mt.prefix, norm(mt.rel)] as const),
    );
    for (const r of runAssetMounts(entry.content)) {
      const prefix = r.prefix.replace(/\/+$/, "");
      const inJson = fromJson.get(prefix);
      if (inJson === norm(r.dir)) continue;
      report(
        "warn",
        "build",
        inJson === undefined
          ? `${entry.relative}:${r.line} — aio.run({ assets }) mounts ` +
            `"${r.prefix}" → "${r.dir}" and deno.json "assets" does not: ` +
            `served in dev and with --prod, 404 from the binary, the web ` +
            `build and the APK (a build embeds deno.json's mounts only)`
          : `${entry.relative}:${r.line} — "${r.prefix}" is "${r.dir}" in ` +
            `aio.run({ assets }) and "${inJson}" in deno.json "assets": the ` +
            `server serves the first, every build ships the second`,
        {
          file: entry.relative,
          line: r.line,
          fix: `Declare it once, in deno.json: "assets": { "${r.prefix}": ` +
            `"${r.dir}" } — the server and every build read that one ` +
            `declaration — and drop it from aio.run`,
        },
      );
      found++;
    }
  }
  if (found === 0 && graph.length > 0) {
    pass("browser asset URLs are served by every artifact");
  }
};
