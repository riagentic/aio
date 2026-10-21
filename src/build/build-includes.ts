/**
 * @module
 * Compile includes — the `--include` set `deno compile` cannot trace on its
 * own: worker modules, server modules, sibling targets, the app's assets and
 * deno.json `assets` mounts. Split out of build-compile.ts, which re-exports
 * every name here, so no importer changes.
 */

import { DENO_JSON_NAMES, readDenoJson } from "../server/deno-json.ts";
import {
  mountLeavesProject,
  mountOutsideMessage,
  resolveEntryPath,
} from "../server/paths.ts";
import {
  dirname,
  fromFileUrl,
  isAbsolute,
  join,
  relative,
  resolve,
} from "@std/path";
import { HEY, NO } from "../diagnostics/fmt.ts";
import { codeText } from "../diagnostics/code-mask.ts";

/** `--include` args for the workers `deno compile` cannot trace. Each is
 *  started from a `new URL(…, import.meta.url)` handed to a Worker
 *  constructor, which is invisible to the module graph, so without an explicit include the binary
 *  builds green and dies in the user's hands with "Module not found" the first
 *  time that worker starts — on the build box it passes, because the VFS falls
 *  through to the real file still sitting at the same absolute path.
 *
 *   - `db/db-worker.ts`      — EVERY binary needs it since B4a (persistence
 *                              always opens the worker-thread DB for aio_kv).
 *   - `state/blocking-worker.ts` — the `blocking()` pool (public, mod.ts).
 *   - `electron/gtk-splash-worker.ts` — the Linux splash, drawn over GTK.
 *
 *  `tests/worker-includes.test.ts` enumerates every `new Worker(new URL(…))`
 *  in `src/` and asserts each one is listed here, so a THIRD worker cannot be
 *  added without this list learning about it. */
export function dbWorkerInclude(): string[] {
  const workers = [
    new URL("../db/db-worker.ts", import.meta.url),
    new URL("../state/blocking-worker.ts", import.meta.url),
    new URL("../electron/gtk-splash-worker.ts", import.meta.url),
  ];
  // fromFileUrl, not .pathname: pathname keeps percent-encoding (a space in
  // the path becomes %20) and on Windows yields "/C:/…" — either way deno
  // compile cannot find the worker and every build ships without it.
  return workers.flatMap((u) =>
    u.protocol === "file:" ? ["--include", fromFileUrl(u)] : []
  );
}

/** `new Worker(new URL(` in CODE — the spec follows. */
const WORKER_URL_RE = /\bnew\s+Worker\s*\(\s*new\s+URL\s*\(\s*/g;

/** Pure: the Workers a module starts from a URL beside it — `new Worker(new
 *  URL("<spec>", import.meta.url))` — as their literal specs, and the lines
 *  of the ones whose spec is computed (a template with `${}`, a variable),
 *  which no build can follow. Comments and strings are masked first, so only
 *  real code counts. */
export function workerUrlSpecs(
  src: string,
): { specs: string[]; computed: number[] } {
  const code = codeText(src);
  const specs: string[] = [];
  const computed: number[] = [];
  for (const m of code.matchAll(WORKER_URL_RE)) {
    const at = m.index! + m[0].length;
    const lit = /^(['"`])([^'"`\n]*)\1\s*,\s*import\s*\.\s*meta\s*\.\s*url\b/
      .exec(src.slice(at));
    if (lit && !(lit[1] === "`" && lit[2]!.includes("${"))) {
      specs.push(lit[2]!);
    } else if (/^[^)]*import\s*\.\s*meta\s*\.\s*url/.test(src.slice(at))) {
      computed.push(src.slice(0, at).split("\n").length);
    }
  }
  return { specs, computed };
}

/** The app's own SERVER workers a binary must embed. `deno compile` cannot
 *  see `new Worker(new URL("./x.ts", import.meta.url))` — not an import — so
 *  a worker file nothing imports compiled green and died in the user's hands
 *  with "Module not found" (measured on Deno 2.9: a `./plain-worker.ts` and a
 *  `./jobs/deep-worker.ts` started from app.ts, binary run from a foreign cwd
 *  with the sources gone; only a `*.server.ts` worker survived, by the naming
 *  rule above). Discovered from every module of the entry's graph and from
 *  the workers themselves (a worker that starts another), never from a
 *  `.tsx`/`.jsx` component — those are the browser's (bundled per target).
 *  A computed spec is said with the one config line that carries it.
 *  Root-relative paths, `/`-separated. */
export async function serverWorkerFiles(
  root: string,
  graph: readonly string[],
): Promise<string[]> {
  const out: string[] = [];
  const seen = new Set(graph);
  const queue = [...graph];
  while (queue.length) {
    const mod = queue.shift()!;
    if (/\.(tsx|jsx)$/.test(mod) || !/\.(m?[jt]s)$/.test(mod)) continue;
    let src: string;
    try {
      src = await Deno.readTextFile(join(root, mod));
    } catch {
      continue; // aio-ok: the graph named it; a file gone since is not a worker
    }
    const { specs, computed } = workerUrlSpecs(src);
    for (const line of computed) {
      console.warn(
        `${HEY} ${mod}:${line} starts a Worker from a computed URL — the ` +
          `binary embeds only the worker files it can see. Name them: ` +
          `deno.json "compile": { "include": ["${
            dirname(mod) === "." ? "" : dirname(mod) + "/"
          }<worker>.ts"] }`,
      );
    }
    for (const spec of specs) {
      const rel = relative(root, join(root, dirname(mod), spec))
        .split("\\").join("/");
      if (rel.startsWith("..") || isAbsolute(rel)) continue;
      const isFile = await Deno.stat(join(root, rel)).then(
        (s) => s.isFile,
        () => false, // aio-ok: no such file — the Worker's own error says so in dev too
      );
      if (!isFile || seen.has(rel)) continue;
      seen.add(rel);
      out.push(rel);
      queue.push(rel);
    }
  }
  return out;
}

/** aio's server-only module convention: `x.server.ts` / `x.server.tsx`.
 *  ONE spelling of the rule for the compile include — the graph validator and
 *  `aiol` recognise the same suffix, and a second spelling here is how the two
 *  drift. */
export function isServerModule(name: string): boolean {
  return name.endsWith(".server.ts") || name.endsWith(".server.tsx");
}

// Dirs never scanned for app assets (deps / build output / VCS / vendored fw).
export const ASSET_SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "dep",
  "target", // Rust/Cargo build output (rust/target/…)
  ".git",
  ".aio",
  ".cache",
]);

/** URL-path extensions worth checking. Deliberately narrow: an extension-less
 *  path is a ROUTE, and a route is the app's business. */
const ASSET_URL_EXT =
  /\.(svg|png|jpe?g|gif|webp|avif|ico|bmp|woff2?|ttf|otf|eot|mp[34]|webm|ogg|wav|pdf|json|txt|csv|xml|wasm|glb|gltf|md)$/i;

/** Every absolute asset URL a bundle asks a browser to fetch — `src="/x.svg"`,
 *  `url(/fonts/y.woff2)`, a fetch of a literal path. String-literal scan, not a
 *  parser: the bundle is minified JS plus CSS, and the only thing that matters
 *  is which paths it names. */
/** Absolute paths that are FILESYSTEM examples, not URLs an app serves.
 *
 *  The scan below reduces every quoted `/…` in the bundle to "a URL the page
 *  might fetch", and a bundle is full of strings that merely look like one. A
 *  field report (report 5 §6) had `placeholder="/home/you/documents/cv.pdf"` —
 *  help text in a file picker — reported as an asset that would 404.
 *
 *  These prefixes are the roots of an operating system, not of a web server.
 *  No aio app routes `/home` or `/Users`, and a build warning that cries wolf
 *  is one people learn to scroll past — which costs more than the warning was
 *  ever worth, because the REAL finding (an asset that works in dev and 404s in
 *  the artifact) is the one that then goes unread. */
const FS_ROOT_RE =
  /^\/(?:home|Users|root|tmp|var|etc|opt|usr|proc|sys|dev|mnt|media|Library|Applications|System|Volumes)\//;

export function assetUrlsIn(bundle: string): string[] {
  const out = new Set<string>();
  // Quoted string literals and css url(…) — both reduce to "a / path".
  for (
    const m of bundle.matchAll(
      /(?:"|'|`|url\(\s*"?'?)(\/[A-Za-z0-9._~\-/]+)(?:"|'|`|"?'?\s*\))/g,
    )
  ) {
    const p = m[1]!;
    if (p.startsWith("//")) continue; // protocol-relative URL, not a path
    if (p.startsWith("/__aio/")) continue; // the framework's own routes
    if (FS_ROOT_RE.test(p)) continue; // an OS path in prose, not a URL
    if (!ASSET_URL_EXT.test(p)) continue;
    out.add(p);
  }
  return [...out].sort();
}

/** Asset URLs the bundle references that the ARTIFACT will not be able to
 *  serve — the check the gates were missing.
 *
 *  Every gate aio had read the SOURCE TREE, and the source tree is not what
 *  ships: `<img src="/assets/logo.svg">` is a real URL in dev (the dev server
 *  serves the app dir, and the file really is in the repo) and a broken-image
 *  glyph in the compiled binary, because nothing embedded the file. Typecheck,
 *  lint and a full suite all pass; the first person to see it is a user, on a
 *  first-run screen.
 *
 *  Pure — every input injected — so the RULE is unit-testable without running
 *  a build. Reports two distinct mistakes and never conflates them:
 *   - `missing`: the file is not in the app dir at all (broken in dev too);
 *   - `unembedded`: the file EXISTS and nothing will put it in the binary,
 *     which is the dev/prod divergence this exists to catch.
 *
 *  `dist/` counts as embedded: the build stages it and `deno compile` takes it
 *  wholesale, so an asset the bundler copied there ships already. */
export function unservableAssetRefs(opts: {
  /** Absolute URL paths the bundle references — see `assetUrlsIn`. */
  urls: string[];
  /** Root-relative include paths (files or dirs) the compile will embed. */
  included: string[];
  /** The app dir a URL path resolves against at runtime — THE app-dir decider
   *  (`baseDirCandidates`), root-relative. */
  appDir: string;
  /** Is `dist/` being embedded? */
  hasDist: boolean;
  /** Does this root-relative path exist on disk? Injected, so the rule is pure. */
  exists: (rel: string) => boolean;
}): Array<{ url: string; rel: string; why: "missing" | "unembedded" }> {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/^\.\//, "");
  const covered = [
    ...(opts.hasDist ? ["dist"] : []),
    ...opts.included.map(norm),
  ];
  const out: Array<
    { url: string; rel: string; why: "missing" | "unembedded" }
  > = [];
  for (const url of opts.urls) {
    const rel = norm(join(opts.appDir, url.slice(1)));
    // Served straight out of dist/ (the bundler's own output, e.g. /app.js).
    if (opts.hasDist && opts.exists(norm(join("dist", url.slice(1))))) continue;
    if (!opts.exists(rel)) {
      out.push({ url, rel, why: "missing" });
      continue;
    }
    // aio-ok: path-split — both normalised to `/` by `norm`
    const embedded = covered.some((c) => rel === c || rel.startsWith(c + "/"));
    if (!embedded) out.push({ url, rel, why: "unembedded" });
  }
  return out;
}

/** Which `*.server.ts` a binary compiled from `entry` embeds. Pure.
 *
 *  Field report (a remote-desktop app, §4): every binary embedded EVERY `*.server.ts` in the
 *  repo, so a public relay shipped the agent's input-injection and capture
 *  code and each desktop app shipped the relay's. A server module ships when
 *  the entry can load it:
 *   1. it is in the entry's module graph (static or analysable dynamic
 *      import — `deno info` lists both);
 *   2. it lives under the entry's own directory (the app's dir — a registry
 *      there may load it through an opaque specifier the graph cannot see);
 *   3. it sits in the same directory as a module the graph reaches (a shared
 *      loader beside its plugins, same reason).
 *  Everything else is `skipped` — the caller prints it, so an opaque load from
 *  elsewhere is one `compile.include` line away and never a silent mystery.
 *  `graph` null (unreadable) ⇒ embed all: a bigger binary beats a broken one.
 *
 *  `siblingEntries` (optional — additive): the OTHER build targets' entries.
 *  A candidate whose nearest enclosing target directory is a SIBLING's — not
 *  this entry's — ships only when this entry's graph reaches it. Without it,
 *  rule 2 handed the `am create` shape (web `src/app.ts`, agent
 *  `src/agent/app.ts`) the agent's server code: `src/agent/` is "under" the
 *  web entry's `src/`. A sibling at the project root owns nothing (its dir is
 *  every target's), and a sibling sharing this entry's dir changes nothing.
 *  All paths root-relative, `/`-separated. */
export function serverModulePlan(opts: {
  candidates: readonly string[];
  graph: readonly string[] | null;
  entry: string;
  siblingEntries?: readonly string[];
}): { embed: string[]; skipped: string[] } {
  const norm = (p: string) => p.split("\\").join("/").replace(/^\.\//, "");
  if (!opts.graph) return { embed: [...opts.candidates], skipped: [] };
  const dirOf = (p: string) => {
    // aio-ok: path-split — callers pass `norm(…)` — `\\` already `/`
    const i = p.lastIndexOf("/");
    return i < 0 ? "" : p.slice(0, i);
  };
  const reached = new Set(opts.graph.map(norm));
  const graphDirs = new Set([...reached].map(dirOf));
  const appDir = dirOf(norm(opts.entry));
  // aio-ok: path-split — normalised to `/` by `norm`
  const under = (p: string) => appDir === "" || p.startsWith(appDir + "/");
  // aio-ok: path-split — normalised to `/` by `norm`
  const inDir = (p: string, d: string) => p.startsWith(d + "/");
  // aio-ok: path-split — normalised to `/` by `norm`
  const depth = (d: string) => d === "" ? 0 : d.split("/").length;
  const siblingDirs = (opts.siblingEntries ?? []).map((e) => dirOf(norm(e)))
    .filter((d) => d !== "" && d !== appDir);
  /** The nearest target dir holding `c` is a sibling's, not this entry's. */
  const siblingOwns = (c: string) => {
    const own = under(c) ? depth(appDir) : -1;
    return siblingDirs.some((d) => inDir(c, d) && depth(d) > own);
  };
  const embed: string[] = [];
  const skipped: string[] = [];
  for (const c of opts.candidates.map(norm)) {
    if (siblingOwns(c)) {
      (reached.has(c) ? embed : skipped).push(c);
      continue;
    }
    (reached.has(c) || under(c) || graphDirs.has(dirOf(c)) ? embed : skipped)
      .push(c);
  }
  return { embed, skipped };
}

/** The entries of the project's OTHER build targets (deno.json
 *  `build.targets`, object form — a target without its own `entry` compiles
 *  the project's), root-relative. Read here rather than handed down by the
 *  fleet so a single-target build (`--targets=web`) scopes exactly as the
 *  fleet does. A deno.json that does not parse is reported by
 *  `assetIncludes`' own `compile.include` read, so this answers `[]`. */
async function siblingTargetEntries(
  root: string,
  entry: string,
): Promise<string[]> {
  let cfg: Record<string, unknown>;
  try {
    cfg = (await readDenoJson(root))?.config ?? {};
  } catch {
    return []; // aio-ok: said by assetIncludes' compile.include read below
  }
  const targets = (cfg.build as { targets?: unknown } | undefined)?.targets;
  if (!targets || typeof targets !== "object" || Array.isArray(targets)) {
    return [];
  }
  const norm = (p: string) => p.split("\\").join("/").replace(/^\.\//, "");
  const own = norm(entry);
  const out = new Set<string>();
  for (const t of Object.values(targets as Record<string, unknown>)) {
    const override = (t as { entry?: unknown } | null)?.entry;
    const e = norm(
      resolveEntryPath(
        cfg,
        typeof override === "string" ? override : undefined,
      ),
    );
    if (e !== own) out.add(e);
  }
  return [...out];
}

/** Root-relative local files in `entry`'s module graph (`deno info`, which
 *  lists analysable dynamic imports too), or null when it cannot be read. */
export async function localModuleGraph(
  root: string,
  entry: string,
): Promise<string[] | null> {
  try {
    const p = await new Deno.Command("deno", {
      args: ["info", "--json", entry],
      cwd: root,
      stdout: "piped",
      stderr: "null",
    }).output();
    if (!p.success) return null;
    const j = JSON.parse(new TextDecoder().decode(p.stdout)) as {
      modules?: Array<{ local?: string }>;
    };
    // `deno info` reports each module's REAL path. A root reached through a
    // symlink (a linked checkout, `~/apps/x -> /srv/x`) made every one of
    // them `../<real>/…` against the link, so the whole graph read as outside
    // the project and a sibling `*.server.ts` the entry imports was left out
    // of the binary — which then dies at the import. Compare real to real.
    // Windows keeps a process's cwd as it was spelled, so there `deno info`
    // run from the link reports paths THROUGH the link: try that spelling too.
    const bases = [await Deno.realPath(root), resolve(root)];
    return (j.modules ?? []).flatMap((m) => {
      if (!m.local) return [];
      const rel = bases.map((b) => relative(b, m.local!))
        .find((r) => !r.startsWith("..") && !isAbsolute(r));
      return rel === undefined ? [] : [rel.split("\\").join("/")];
    });
  } catch {
    return null;
  }
}

/** `--include` args for the app's runtime DATA ASSETS that `deno compile` can't
 *  trace — anything loaded via `Deno.readFile(new URL("./x", import.meta.url))`
 *  is invisible to the module graph, so it's missing from the binary/AppImage
 *  unless explicitly embedded. WITHOUT this a WASM app compiles fine but shows
 *  "wasm not available" at runtime (the #1 report). Covers:
 *   1. every `.wasm` in the project (zero-config — WASM is a first-class case);
 *   2. every `*.server.ts` / `*.server.tsx` (zero-config — see below);
 *   3. any extra paths the app declares in deno.json `compile.include`
 *      (files or dirs, relative to the project root — for data files, models…).
 *  Returns flat `["--include", "&lt;relpath&gt;", …]` args (deduped, root-relative).
 *
 *  `entry` (root-relative, optional — additive): the module this binary is
 *  compiled from. Given one, only the `*.server.ts` that entry can REACH ship —
 *  see {@link serverModulePlan}. Without it every `*.server.ts` in the tree is
 *  embedded, as before. */
export async function assetIncludes(
  root: string,
  entry?: string,
): Promise<string[]> {
  const rels: string[] = [];
  const serverMods: string[] = [];
  const seen = new Set<string>();
  const add = (rel: string) => {
    const norm = rel.split("\\").join("/");
    if (norm && !seen.has(norm)) {
      seen.add(norm);
      rels.push(norm);
    }
  };

  // 1) auto-discover every .wasm (bounded walk, skipping deps/build/VCS dirs).
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 10) return;
    // The guard wraps the ITERATION: `Deno.readDir` is lazy, so an unreadable
    // directory surfaced from the first `for await`, not the assignment, and
    // the `catch` below was dead — a vanished subdir crashed the walk.
    let entries: Deno.DirEntry[];
    try {
      entries = await Array.fromAsync(Deno.readDir(dir));
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory) {
        if (ASSET_SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
        await walk(join(dir, e.name), depth + 1);
      } else if (e.isFile && e.name.endsWith(".wasm")) {
        add(relative(root, join(dir, e.name)));
      } else if (isServerModule(e.name)) {
        // A `*.server.ts` module is aio's documented escape hatch: a cell
        // method reaches it with `await import(…)`, which keeps it out of the
        // browser bundle by construction. Whether `deno compile` can follow
        // that import depends on the SPECIFIER, and the difference is invisible
        // in dev, where the dev server transpiles on demand and every shape
        // works. MEASURED on Deno 2.9, running the binary from a foreign cwd
        // with the sources deleted (they otherwise fall through to disk and
        // every shape appears to pass):
        //
        //   await import("./io.server.ts")        analysable  → embedded
        //   await import(`./${name}.server.ts`)   analysable  → embedded
        //   const s = new URL(…).href; import(s)  OPAQUE      → NOT embedded,
        //                                         and the binary dies with a
        //                                         module error at the call.
        //
        // The opaque form is what a registry or a plugin loader writes, and it
        // is the shape two field reports hit. The answer was a comment telling
        // people to hand-register each module in app.ts — a rule enforced by
        // nothing, whose violation is invisible until a user runs the binary.
        //
        // Dev == prod is load-bearing, so this is discovered rather than
        // declared: the naming convention IS the registration. Same treatment
        // `.wasm` gets above, for the same reason, and the cost of including a
        // module the graph already had is a duplicate the VFS de-dupes.
        //
        // …but only for the binary that can load it. A repo with several
        // targets (relay + agent + control) must not ship the agent's input
        // injection inside the public relay — `serverModulePlan` decides.
        serverMods.push(
          relative(root, join(dir, e.name)).split("\\").join("/"),
        );
      }
    }
  };
  await walk(root, 0);
  if (entry === undefined) serverMods.forEach(add);
  else {
    entry = relative(root, isAbsolute(entry) ? entry : join(root, entry));
    const graph = await localModuleGraph(root, entry);
    if (!graph) {
      console.warn(
        `${HEY} could not read ${entry}'s module graph — embedding every ` +
          `*.server.ts in the project (the binary may carry other targets' ` +
          `server code)`,
      );
    }
    const plan = serverModulePlan({
      candidates: serverMods,
      graph,
      entry,
      siblingEntries: await siblingTargetEntries(root, entry),
    });
    plan.embed.forEach(add);
    const workers = graph ? await serverWorkerFiles(root, graph) : [];
    workers.forEach(add);
    const skipped = plan.skipped.filter((s) => !workers.includes(s));
    if (skipped.length) {
      // A warning, not a progress line: a module left out here that the app
      // DOES load (opaquely) is a binary that dies at runtime, and the fix is
      // one config line — so it must not scroll past with the build output.
      console.warn(
        `${HEY} not embedding ${skipped.length} *.server.ts ${entry} cannot ` +
          `reach: ${skipped.join(", ")} — if it loads one through an ` +
          `opaque specifier, add it to deno.json "compile": { "include": [] }`,
      );
    }
  }

  // 2) declarative deno.json `compile.include` — files/dirs the app wants
  //    embedded (any asset kind). Kept inside the project (no traversal out),
  //    and a path that breaks that rule is REFUSED, never dropped: a silently
  //    skipped entry ships a binary without the asset it was told to carry,
  //    and the failure surfaces in the user's hands as a missing model/data
  //    file. (A path that does not exist, or a glob, already makes
  //    `deno compile` fail hard — this closes the one silent case.)
  let decl: unknown;
  try {
    const cfg = (await readDenoJson(root))?.config ?? {};
    decl = (cfg as { compile?: { include?: unknown } })?.compile?.include;
  } catch (e) {
    // "nothing declared" is only true when there is no deno.json. One that
    // cannot be PARSED has to say so, or every asset it declares is dropped.
    if (!(e instanceof Deno.errors.NotFound)) {
      console.warn(
        `${HEY} deno.json could not be read (${e}) — no compile.include applied`,
      );
    }
  }
  if (Array.isArray(decl)) {
    for (const [i, p] of decl.entries()) {
      if (typeof p !== "string" || !p.trim()) {
        throw new Error(
          `${NO} deno.json compile.include[${i}] is ${
            JSON.stringify(p)
          } — every entry must be a non-empty path relative to the project root.`,
        );
      }
      const entry = p.trim();
      const rel = relative(root, join(root, entry));
      // An ABSOLUTE entry is silently reinterpreted by `join` as a
      // root-relative one (`/etc/passwd` → `<root>/etc/passwd`), so it would
      // embed a DIFFERENT file than the one declared — refuse both that and a
      // `../` escape, and say which of the two it is.
      const absolute = isAbsolute(entry);
      if (absolute || rel.startsWith("..") || isAbsolute(rel)) {
        throw new Error(
          `${NO} deno.json compile.include[${i}] ("${p}") is ` +
            (absolute
              ? `absolute; paths are relative to the project root, and this ` +
                `one would silently embed ${join(root, entry)} instead`
              : `outside the project (${join(root, entry)})`) +
            `. deno compile embeds paths relative to the project root — copy ` +
            `the asset into the project and reference it from there.`,
        );
      }
      add(rel);
    }
  }

  // 2b) the directories the app SERVES (`assets` in deno.json). `deno compile`
  //     cannot trace a directory nobody imports, so an asset mount declared
  //     only in code serves perfectly in dev and 404s from the binary — the
  //     "build products go stale in silence" shape, discovered by a user.
  //     Declared in deno.json it is embedded with nothing to keep in sync:
  //     ONE fact, read by the server that serves it and the build that ships
  //     it.
  //
  //     Same containment rule as `compile.include`, and REFUSED the same way
  //     rather than dropped: a silently skipped mount ships a binary without
  //     the data it was told to carry.
  let cfg: unknown;
  try {
    cfg = (await readDenoJson(root))?.config;
  } catch {
    // aio-ok: the parse failure is already reported by the compile.include
    // read above, which runs first and says so once.
  }
  for (const m of assetMounts(cfg, root)) add(m.rel);

  // 3) the app's config itself — its IDENTITY (version, title, client). The
  //    runtime reads it relative to the entry module, so a binary knows its own
  //    version instead of falling back to "0.0.0" or, worse, adopting the
  //    version of whatever project it happens to be launched from.
  //
  //    BOTH names: `DENO_JSON_NAMES` is the decider and every reader honours
  //    `.jsonc`, so embedding the literal "deno.json" shipped a `.jsonc` app
  //    with no identity at all — title "AIO App", version 0.0.0, `"client":
  //    "browser"` ignored so the shell silently defaulted to Electron, and an
  //    appId taken from the binary's FILE NAME (which moves the data dir on
  //    every renamed install).
  for (const name of DENO_JSON_NAMES) {
    try {
      await Deno.stat(join(root, name));
      add(name);
      break; // deno reads the FIRST match — embed exactly that one
    } catch { /* not this name — try the next */ }
  }

  return rels.flatMap((r) => ["--include", r]);
}

/** deno.json `assets` — `{ "/prefix": "./dir" }` — as `{ prefix, rel }` with
 *  `rel` relative to `root`. THE one reading, for the binary that embeds the
 *  mounts and the standalone APK that packages them. A value that is not a
 *  non-empty path inside the project is REFUSED, never dropped: a skipped
 *  mount ships an artifact without the data it was told to carry. */
export function assetMounts(
  config: unknown,
  root: string,
): { prefix: string; rel: string }[] {
  const mounts = (config as { assets?: unknown } | undefined)?.assets;
  if (!mounts || typeof mounts !== "object" || Array.isArray(mounts)) {
    return [];
  }
  return Object.entries(mounts).map(([prefix, dir]) => {
    if (typeof dir !== "string" || !dir.trim()) {
      throw new Error(
        `${NO} deno.json assets["${prefix}"] is ${JSON.stringify(dir)} — ` +
          `every value must be a non-empty directory path relative to the ` +
          `project root.`,
      );
    }
    const entry = dir.trim();
    if (mountLeavesProject(root, entry)) {
      throw new Error(`${NO} ${mountOutsideMessage(prefix, dir)}`);
    }
    return { prefix, rel: relative(root, join(root, entry)) };
  });
}
