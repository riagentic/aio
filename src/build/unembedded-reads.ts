/**
 * @module
 * Runtime file reads a compiled binary cannot satisfy.
 *
 * A server module that does `Deno.readTextFile(new URL("../style.css",
 * import.meta.url))` works in `deno task dev` — the file is on disk beside
 * the module. In a `deno compile` binary `import.meta.url` points into the
 * embedded file system, which holds the module graph and the `--include`
 * paths and NOTHING else: the read throws NotFound, and an app that catches
 * it falls back in silence (a field report: the wrong theme colours, in the
 * packaged app only). The fix is one `compile.include` line; this names it.
 *
 * Sibling of `unservableAssetRefs` (URLs the page requests) and the opaque
 * `*.server.ts` load check — same rule shape: pure, every input injected, the
 * I/O lives in `build-compile.ts`. Internal — never re-exported from a public
 * entry.
 */
import { codeText } from "../diagnostics/code-mask.ts";

/** `// aio-ok(read): <why>` (or `// aio-ok: read <why>`) on the line, or the
 *  comment line above it, silences this check for that read. */
export const READ_OK_RE: RegExp =
  /\/\/.*\baio-ok\s*(?:\(read\)|[:\-—]\s*read\b)/;

/** One literal, module-relative file read found in a source text. */
export type RuntimeFileRead = {
  line: number;
  /** The literal(s) as written: `../style.css`, or `data/x.json` for `join`. */
  spec: string;
  /** `true`: the literal sits INSIDE a read call (`Deno.readTextFile(new
   *  URL(lit, import.meta.url))`) — nothing between the path and the read to
   *  guess at. `false`: a heuristic form — bound to a name that a read call
   *  later mentions, built with `join(import.meta.dirname, …)`, or only
   *  `stat`ed. */
  certain: boolean;
  /** Set when the read would be certain but the code around it handles the
   *  compiled case — `a .catch(…) on the read`, … Never certain then. */
  guard?: string;
};

/** Calls that open a path. `stat`/`lstat` are the existence probe that
 *  precedes a read — a path that is only probed is still judged, never as
 *  certain.
 *
 *  `fetch` is judged ONLY in a module that is server-only by name
 *  (`*.server.ts`), and never as certain. The scanned graph holds the client
 *  components too (the entry imports the App for SSR), and
 *  `fetch(new URL("./data.json", import.meta.url))` in one of those runs in
 *  the browser, where the bundler resolved the URL and the binary's file
 *  system is not involved — failing the build on it was a false refusal. */
const READ_CALL_RE =
  /\b(?:Deno\s*\.\s*(readTextFile|readFile|open|readDir|l?stat)(?:Sync)?|(fetch))\s*\(/g;
/** "This run is a compiled binary", as an app spells it. */
const STANDALONE = String
  .raw`(?:Deno\s*\.\s*build\s*\.\s*standalone|\bisCompiled\s*\(\s*\))`;

/** Index just past the bracket that closes the one opened before `from`. */
function closeOf(code: string, from: number, open: string, close: string) {
  let depth = 1;
  let to = from;
  while (to < code.length && depth > 0) {
    if (code[to] === open) depth++;
    else if (code[to] === close) depth--;
    to++;
  }
  return to;
}

/** What around the read at `at` (its call's arguments end at `to`) handles
 *  the file being absent in a binary — or undefined. `code` is the masked
 *  text, so a brace or a keyword in a string cannot fool the walk. A guard
 *  downgrades a finding to a warning; it never silences one. */
function guardOf(code: string, at: number, to: number): string | undefined {
  // `.catch(` later in the same statement.
  let depth = 0;
  for (let i = to; i < code.length && i < to + 600; i++) {
    const c = code[i]!;
    if (c === "(" || c === "{" || c === "[") depth++;
    else if (c === ")" || c === "}" || c === "]") {
      if (--depth < 0) break;
    } else if (c === ";" && depth === 0) break;
    else if (depth === 0 && /^\.\s*catch\s*\(/.test(code.slice(i, i + 20))) {
      return "a .catch(…) on the read";
    }
  }
  // An enclosing `try { … } catch` whose catch does not rethrow.
  for (const m of code.matchAll(/\btry\s*\{/g)) {
    if (m.index > at) break;
    const end = closeOf(code, m.index + m[0].length, "{", "}");
    if (at >= end) continue;
    const c = /^\s*catch\s*(?:\([^)]*\)\s*)?\{/.exec(code.slice(end));
    if (!c) continue;
    const body = code.slice(
      end + c[0].length,
      closeOf(code, end + c[0].length, "{", "}"),
    );
    if (!/\bthrow\b/.test(body)) return "the try/catch around it";
  }
  // `if (!Deno.build.standalone) { read }`, the `else` of the positive test,
  // or the rest of a block after `if (Deno.build.standalone) return`.
  for (const m of code.matchAll(/\bif\s*\(/g)) {
    if (m.index > at) break;
    const condEnd = closeOf(code, m.index + m[0].length, "(", ")");
    const cond = code.slice(m.index + m[0].length, condEnd - 1);
    if (!new RegExp(STANDALONE).test(cond)) continue;
    const not = new RegExp(String.raw`!\s*${STANDALONE}`).test(cond);
    const open = /^\s*\{/.exec(code.slice(condEnd));
    const thenEnd = open
      ? closeOf(code, condEnd + open[0].length, "{", "}")
      : code.indexOf(";", condEnd) + 1 || code.length;
    const inThen = at >= condEnd && at < thenEnd;
    const name = `the \`if (${cond.trim().replace(/\s+/g, " ")})\` around it`;
    if (not) {
      if (inThen) return name;
      continue;
    }
    if (inThen) continue;
    const els = /^\s*else\b\s*\{?/.exec(code.slice(thenEnd));
    if (els) {
      const elseEnd = els[0].endsWith("{")
        ? closeOf(code, thenEnd + els[0].length, "{", "}")
        : code.indexOf(";", thenEnd) + 1 || code.length;
      if (at < elseEnd) return name;
      continue;
    }
    if (
      /\b(?:return|throw)\b/.test(code.slice(condEnd, thenEnd)) &&
      at < closeOf(code, thenEnd, "{", "}")
    ) {
      return `the \`if (${
        cond.trim().replace(/\s+/g, " ")
      })\` return before it`;
    }
  }
  return undefined;
}
const STR = String.raw`(["'])([^"'\\\n]+)\1`;
/** `new URL("lit", import.meta.url)` and `import.meta.resolve("lit")`. */
const URL_ANCHOR_RE = new RegExp(
  String
    .raw`\bnew\s+URL\s*\(\s*${STR}\s*,\s*import\s*\.\s*meta\s*\.\s*url\s*,?\s*\)` +
    String
      .raw`|\bimport\s*\.\s*meta\s*\.\s*resolve\s*\(\s*(["'])([^"'\\\n]+)\3\s*,?\s*\)`,
  "g",
);
/** `join(import.meta.dirname, "a", "b.css")` — also `resolve(…)`, and
 *  `dirname(import.meta.filename)` as the base. */
const DIR_ANCHOR_RE = new RegExp(
  String.raw`\b(?:join|resolve)\s*\(\s*(?:import\s*\.\s*meta\s*\.\s*dirname|` +
    String
      .raw`dirname\s*\(\s*import\s*\.\s*meta\s*\.\s*filename\s*!?\s*\))\s*!?` +
    String.raw`((?:\s*,\s*(?:"[^"\\\n]+"|'[^'\\\n]+'))+)\s*,?\s*\)`,
  "g",
);
/** `const X = [wrapper(]` — what an anchor is the initializer of. */
const BOUND_RE =
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]+)?=\s*(?:[\w$.]+\s*\(\s*)*$/;

/** Every literal module-relative file read in `source`. Pure.
 *
 *  Matches run against the ORIGINAL text and are kept only where the code
 *  mask says "code", so the same words in a comment or a string are not a
 *  read and the line number is the one the reader sees. An anchor that is
 *  neither inside a read call nor bound to a name a read call mentions is
 *  not reported: `new Worker(new URL(…))` and `import(new URL(…).href)` are
 *  module loads, which the graph (not this check) accounts for. */
export function runtimeFileReads(
  source: string,
  jsx = false,
  /** The module is server-only by NAME (`*.server.ts`): its `fetch` of a
   *  module-relative file is a read of the binary's file system. */
  serverOnly = false,
): RuntimeFileRead[] {
  if (!/import\s*\.\s*meta/.test(source)) return [];
  const code = codeText(source, jsx);
  // The argument span of every read call. Strings are blanked in `code`, so a
  // plain depth count cannot be fooled by a paren inside one.
  // `soft`: a probe or a `fetch` — judged, never as certain.
  const spans: Array<{ from: number; to: number; soft: boolean }> = [];
  for (const m of code.matchAll(READ_CALL_RE)) {
    if (m[2] && !serverOnly) continue;
    const from = m.index + m[0].length;
    const to = closeOf(code, from, "(", ")");
    spans.push({ from, to, soft: !!m[2] || /stat$/.test(m[1] ?? "") });
  }
  const raw = source.split("\n");
  const acked = (li: number) =>
    READ_OK_RE.test(raw[li] ?? "") ||
    (/^\s*\/\//.test(raw[li - 1] ?? "") && READ_OK_RE.test(raw[li - 1]!));
  const out: RuntimeFileRead[] = [];
  const judge = (i: number, spec: string, literalForm: boolean) => {
    if (code[i] === " ") return; // in a comment or a string
    const li = source.slice(0, i).split("\n").length - 1;
    if (acked(li)) return;
    const inside = spans.find((s) => i >= s.from && i < s.to);
    if (inside) {
      const guard = literalForm && !inside.soft
        ? guardOf(code, i, inside.to)
        : undefined;
      out.push({
        line: li + 1,
        spec,
        certain: literalForm && !inside.soft && !guard,
        ...(guard ? { guard } : {}),
      });
      return;
    }
    const name = BOUND_RE.exec(code.slice(Math.max(0, i - 200), i))?.[1];
    if (!name) return;
    const used = new RegExp(`(^|[^\\w$.])${name.replace(/\$/g, "\\$")}\\b`);
    if (spans.some((s) => used.test(code.slice(s.from, s.to)))) {
      out.push({ line: li + 1, spec, certain: false });
    }
  };
  for (const m of source.matchAll(URL_ANCHOR_RE)) {
    judge(m.index, (m[2] ?? m[4])!, true);
  }
  for (const m of source.matchAll(DIR_ANCHOR_RE)) {
    const segs = [...m[1]!.matchAll(/["']([^"'\\\n]+)["']/g)].map((s) => s[1]);
    judge(m.index, segs.join("/"), false);
  }
  return out.sort((a, b) => a.line - b.line);
}

/** One read the artifact cannot satisfy (or that cannot work anywhere). */
export type UnembeddedRead = {
  /** `src/serve.server.ts:12` — root-relative, `/`-separated. */
  at: string;
  spec: string;
  /** The target, root-relative. */
  rel: string;
  /** `missing`: not on disk at all — a typo, broken in dev too.
   *  `unembedded`: on disk, and nothing puts it in the binary.
   *  `outside`: on disk, outside the project — `compile.include` cannot
   *  name it. */
  why: "missing" | "unembedded" | "outside";
  certain: boolean;
  /** See {@linkcode RuntimeFileRead.guard}. */
  guard?: string;
};

/** The reads in `modules` whose target the binary will not contain. Pure —
 *  every input injected, so the RULE is unit-testable without a build.
 *
 *  `included` is what the compile embeds, root-relative (files or
 *  directories): the `--include` values of the `deno compile` argv itself
 *  plus the module graph — the same data the compile uses, so this cannot
 *  disagree with it. A DIRECTORY target counts as covered when anything
 *  embedded lies inside it: which of its files the app goes on to read is
 *  not knowable here, and a refusal on a guess is worse than silence. */
export function unembeddedReads(opts: {
  /** The app's own server modules: root-relative path + source. */
  modules: readonly { path: string; content: string }[];
  included: readonly string[];
  /** What is at this root-relative path on disk. Injected. */
  kind: (rel: string) => "file" | "dir" | null;
}): UnembeddedRead[] {
  const norm = (p: string) =>
    p.split("\\").join("/").replace(/^\.\//, "").replace(/\/+$/, "");
  const covered = opts.included.map(norm);
  // A stand-in root: only the path arithmetic of URL resolution is wanted.
  const BASE = "file:///__root__/";
  const out: UnembeddedRead[] = [];
  for (const mod of opts.modules) {
    const path = norm(mod.path);
    const found = runtimeFileReads(
      mod.content,
      /\.[jt]sx$/.test(path),
      /\.server\.[cm]?[jt]sx?$/.test(path),
    );
    for (const r of found) {
      let u: URL;
      try {
        u = new URL(r.spec, BASE + path);
      } catch {
        continue; // aio-ok: not a path this check can resolve — nothing to say
      }
      if (u.protocol !== "file:") continue; // `new URL("https://…", …)`
      const hit = (rel: string, why: UnembeddedRead["why"]) =>
        out.push({
          at: `${path}:${r.line}`,
          spec: r.spec,
          rel,
          why,
          certain: r.certain && why !== "missing",
          ...(r.guard ? { guard: r.guard } : {}),
        });
      const abs = decodeURIComponent(u.pathname);
      if (!abs.startsWith("/__root__/")) {
        // Resolved above the project root: `kind` answers for a `../` path.
        const up = outsideRel(path, r.spec);
        hit(up, opts.kind(up) ? "outside" : "missing");
        continue;
      }
      const rel = norm(abs.slice("/__root__/".length));
      const k = opts.kind(rel);
      if (!k) {
        hit(rel, "missing");
        continue;
      }
      const embedded = covered.some((c) =>
        // aio-ok: path-split — project-relative, `/`-normalised above
        rel === c || rel === "" || rel.startsWith(c + "/") ||
        // aio-ok: path-split — the same normalised form
        (k === "dir" && c.startsWith(rel + "/"))
      );
      if (!embedded) hit(rel, "unembedded");
    }
  }
  return out;
}

/** `spec` resolved against `path`'s directory, kept root-relative with its
 *  leading `../` (a URL cannot climb above its root, so this is done on
 *  segments). */
function outsideRel(path: string, spec: string): string {
  // aio-ok: path-split — both `/`-separated (normalised path, URL literal)
  const segs = [...path.split("/").slice(0, -1), ...spec.split("/")];
  const out: string[] = [];
  for (const s of segs) {
    if (s === "" || s === ".") continue;
    if (s === ".." && out.length && out[out.length - 1] !== "..") out.pop();
    else out.push(s);
  }
  return out.join("/");
}

/** The build's words for one finding, with the exact deno.json edit.
 *  `declared` is the app's current `compile.include`. Pure. */
export function unembeddedReadMessage(
  f: UnembeddedRead,
  declared: readonly string[],
): string {
  if (f.why === "missing") {
    return `${f.at} reads "${f.spec}" and ${f.rel} does not exist — the ` +
      `read fails in dev and in the artifact (a typo?).`;
  }
  const head = `${f.at} reads "${f.spec}" at run time → ${f.rel}, a file ` +
    `that is on disk in \`deno task dev\` and that this binary will NOT ` +
    `contain — the read fails in every shipped artifact. ` +
    (f.guard
      ? `It is guarded by ${f.guard}, so this is a warning and not a ` +
        `refusal: if the artifact is meant to go without the file, say so ` +
        `with \`// aio-ok(read): <why>\` on the read's line. Otherwise: `
      : "");
  if (f.why === "outside") {
    return head + `It is outside the project, which compile.include cannot ` +
      `name: copy it into the project, read it from there and embed it.`;
  }
  const line = declared.length
    ? `add "${f.rel}" to deno.json "compile": { "include": [${
      [...declared, f.rel].map((d) => JSON.stringify(d)).join(", ")
    }] }`
    : `add "compile": { "include": ["${f.rel}"] } to deno.json`;
  return head + `Embed it: ${line}. (A read that is meant never to run in ` +
    `a binary: \`// aio-ok(read): <why>\` on its line.)`;
}
