// bundle-analyze.ts — where the bundle's bytes actually went.
//
// Two reports asked for a treemap (newjob §8.9, risoto §22.7), and the honest
// version of that question is smaller than a treemap: "which twenty things are
// most of my bundle, and is anything in there that should not be".
//
// THE NUMBER THAT MATTERS IS `bytesInOutput`, not a file's size on disk. A
// 400 KB dependency that tree-shakes to 3 KB is not a 400 KB problem, and a
// report that said it was would send people optimising the wrong module —
// which is worse than no report, because it costs a day to find out.
//
// Pure: it takes the numbers esbuild already produced (the build asks for a
// metafile regardless, for the graph audit) and returns rows. No I/O, no
// formatting decisions baked in, so a test can ask it things directly.

/** One row of the report: a module or a group of them. */
export type BundleRow = {
  /** The module path, or the group's prefix with a trailing `/`. */
  readonly name: string;
  /** Bytes this contributes to the OUTPUT, after tree-shaking and minifying. */
  readonly bytes: number;
  /** Share of the whole bundle, 0-1. */
  readonly share: number;
  /** How many modules this row covers (1 for a single module). */
  readonly modules: number;
};

export type BundleAnalysis = {
  readonly total: number;
  /** Biggest first. */
  readonly rows: readonly BundleRow[];
  /** Bytes in rows that did not make the cut, and how many modules. */
  readonly restBytes: number;
  readonly restModules: number;
};

export type AnalyzeOptions = {
  /** How many rows to return. Default 20 — a list nobody scrolls is a list
   *  nobody reads, and the tail is summarised rather than dropped. */
  readonly limit?: number;
  /** Group modules under a shared prefix into one row. Default on: sixty rows
   *  of `node_modules/.deno/three@…/build/*` answer "which dependency is big"
   *  worse than one row does. */
  readonly group?: boolean;
};

/** Which group a module belongs to, or null to stand alone.
 *
 *  Three groupings, and each is a question someone actually asks:
 *  a dependency (by PACKAGE, not by file inside it), the framework, and the
 *  app's own source. Anything else stands alone, because a module nobody can
 *  categorise is exactly the one worth seeing by name. */
export function groupOf(path: string): string | null {
  const p = path.split("\\").join("/");
  // A npm/jsr dependency: fold to the package, which is the unit anyone can
  // act on (remove it, replace it, import less of it).
  //
  // The LAST `node_modules/`, because Deno nests:
  // `node_modules/.deno/three@0.160.0/node_modules/three/build/x.js`. Reading
  // the first one gives `.deno`, and reading the first one AFTER `.deno` gives
  // `three@0.160.0` — a row per version, which is a row per upgrade and not
  // what anyone is asking.
  const last = p.lastIndexOf("node_modules/");
  if (last >= 0) {
    const after = p.slice(last + "node_modules/".length);
    const parts = after.split("/");
    let name = parts[0] ?? "";
    if (name.startsWith("@") && parts.length > 1) name += `/${parts[1]}`;
    // `.deno` is a store directory, not a package; and a name carrying its own
    // version is one of its children (`three@0.160.0`) — strip it so two
    // versions of one dependency are one row.
    if (name && name !== ".deno") {
      const at = name.lastIndexOf("@");
      if (at > 0) name = name.slice(0, at);
      return `node_modules/${name}/`;
    }
  }
  const reg = /(?:^|\/)(?:jsr|npm|https?)[:/]+.*?((?:@[^/]+\/)?[^/@]+)@/.exec(
    p,
  );
  if (reg) return `${reg[1]}@/`;
  // The framework, as one number — "how much of this is aio" is a question
  // with an answer, and thirty aio modules is not it.
  const fw =
    /(?:^|\/)(?:aio\/)?src\/(air|browser|state|protocol|ui|sync|diagnostics|vitals|adapters)\//
      .exec(p);
  if (fw) return `aio/${fw[1]}/`;
  return null;
}

/** Rank a bundle's inputs by what they contribute to the output.
 *
 *  `bytesInOutput` per input is what esbuild reports for the file it actually
 *  emitted, so the rows sum to the bundle and a share is a real share. */
export function analyzeBundle(
  bytesInOutput: Readonly<Record<string, number>>,
  opts: AnalyzeOptions = {},
): BundleAnalysis {
  const limit = Math.max(1, opts.limit ?? 20);
  const grouping = opts.group !== false;

  const buckets = new Map<string, { bytes: number; modules: number }>();
  let total = 0;
  for (const [path, bytes] of Object.entries(bytesInOutput)) {
    if (!Number.isFinite(bytes) || bytes < 0) continue;
    total += bytes;
    const name = (grouping ? groupOf(path) : null) ?? path;
    const b = buckets.get(name);
    if (b) {
      b.bytes += bytes;
      b.modules++;
    } else {
      buckets.set(name, { bytes, modules: 1 });
    }
  }

  const all = [...buckets].map(([name, b]) => ({
    name,
    bytes: b.bytes,
    modules: b.modules,
    share: total === 0 ? 0 : b.bytes / total,
  }))
    // Bytes descending, then name — so two equal rows do not swap places
    // between runs and turn a committed report into a diff.
    .sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name));

  const rows = all.slice(0, limit);
  const rest = all.slice(limit);
  return {
    total,
    rows,
    restBytes: rest.reduce((n, r) => n + r.bytes, 0),
    restModules: rest.reduce((n, r) => n + r.modules, 0),
  };
}

const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;

/** The report as lines, for a terminal. */
export function formatAnalysis(a: BundleAnalysis): string[] {
  if (a.total === 0) return ["bundle analysis: nothing to report"];
  const nameWidth = Math.min(
    64,
    Math.max(20, ...a.rows.map((r) => r.name.length)),
  );
  const lines = [
    `bundle: ${kb(a.total)} across ${
      a.rows.reduce((n, r) => n + r.modules, 0) + a.restModules
    } modules (bytes AFTER tree-shaking and minification)`,
  ];
  for (const r of a.rows) {
    // A bar, because the question is "what is most of it" and a column of
    // numbers answers that slower than a shape does.
    const bar = "#".repeat(Math.max(1, Math.round(r.share * 40)));
    lines.push(
      `  ${r.name.padEnd(nameWidth).slice(0, nameWidth)} ` +
        `${kb(r.bytes).padStart(9)} ${
          (r.share * 100).toFixed(1).padStart(5)
        }%  ${bar}` + (r.modules > 1 ? `  (${r.modules} modules)` : ""),
    );
  }
  if (a.restModules > 0) {
    lines.push(
      `  ${"…everything else".padEnd(nameWidth)} ${
        kb(a.restBytes).padStart(9)
      } ${((a.restBytes / a.total) * 100).toFixed(1).padStart(5)}%  ` +
        `(${a.restModules} modules)`,
    );
  }
  return lines;
}
