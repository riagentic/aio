/**
 * @module
 * `"build": { "minify": true }` — a compiled binary that ships no comments and
 * no local names of the app's server code.
 *
 * `deno compile` embeds every module's ORIGINAL text (and the transpiled JS),
 * so `strings app` printed the whole server tree back, comments and all — a
 * field report (a crypto wallet built on aio) found its design notes and
 * security reasoning in the shipped binary. The browser bundle was already
 * minified; the server side was not.
 *
 * HOW: each module the binary loads is minified ON ITS OWN, into a staging
 * copy that keeps the source tree's LAYOUT, and `deno compile` runs there.
 * Not one bundled file — a bundle moves every module to one URL, and aio (and
 * apps) find workers and assets by `new URL("./x", import.meta.url)`: the
 * SQLite worker, the `blocking()` pool and an app's `.wasm` all died with
 * `Module not found` in the bundle probe. Same layout, same paths, same
 * behaviour; only the text changes.
 *
 * What it is NOT: encryption. Minified JS is still readable to a determined
 * person. It removes the free gift — comments, and the local names that
 * explain them. Function and class NAMES are kept (esbuild `keepNames`), so
 * everything that reads `fn.name` behaves exactly as unminified. The client
 * bundle's source map (`dist/.app.js.map`, names and paths only) is left out
 * too; the cost is that a forwarded browser error says `app.js:1:22073`
 * instead of `App.tsx:12`.
 *
 * Internal — never re-exported from a public entry.
 */
import {
  common,
  dirname,
  extname,
  fromFileUrl,
  isAbsolute,
  join,
  relative,
  SEPARATOR,
} from "@std/path";
import { BUNDLE_MAP } from "../server/app-files.ts";
import { readDenoJson } from "../server/deno-json.ts";
import { HEY, NO } from "../diagnostics/fmt.ts";

/** The staging copy, inside the project (`.aio/` is never scanned for assets
 *  and never shipped). Not the system temp dir: a Windows temp path carries
 *  the user name, and a space in a compiled project's path breaks the binary
 *  (see `smokeRunArtifact`) — staging here keeps exactly today's exposure.
 *  One fixed name is safe: every compile holds the project's build lock
 *  (`withDevExcluded`). */
export const MINIFY_STAGE = join(".aio", "minify-stage");

/** `build.minify` from the app's deno.json: `false` when absent, refused when
 *  it is not a boolean — a typo'd `"true"` must not ship the readable tree
 *  while the author believes it is minified. */
export async function minifyDeclared(root: string): Promise<boolean> {
  const cfg = (await readDenoJson(root))?.config as
    | { build?: { minify?: unknown } }
    | undefined;
  const v = cfg?.build?.minify;
  if (v === undefined || typeof v === "boolean") return v === true;
  throw new Error(
    `${NO} deno.json build.minify is ${
      JSON.stringify(v)
    } — it must be true or false.`,
  );
}

const SCRIPT = /\.(?:[mc]?[jt]sx?)$/;
const DECL = /\.d\.[mc]?ts$/;
const CONFIGS = ["deno.json", "deno.jsonc", "package.json", "deno.lock"];
/** Directories next to a config that resolution reads in place. */
const LINKED = ["node_modules", "vendor"];

/** The esbuild module — passed in, as `client-bundle.ts` takes it. */
type Esbuild = {
  // deno-lint-ignore no-explicit-any
  transform: (src: string, opts: any) => Promise<{ code: string }>;
};

/** One module's minified text. ESM, whitespace + syntax + local names, no
 *  comments at all (`legalComments: "none"`), names kept, JSX left for Deno
 *  to transform with the app's own `jsxImportSource`. `.cjs`/`.cts` get
 *  `format: "cjs"`. Throws on a parse error. Pure given `esbuild`. */
export async function minifyModule(
  esbuild: Esbuild,
  path: string,
  src: string,
): Promise<string> {
  const ext = extname(path).slice(1);
  const loader = ext.replace(/^[mc]/, "");
  const r = await esbuild.transform(src, {
    loader,
    format: ext.startsWith("c") ? "cjs" : "esm",
    minify: true,
    keepNames: true,
    jsx: "preserve",
    legalComments: "none",
    target: "esnext",
    sourcefile: path,
  });
  return r.code;
}

/** Every LOCAL file module `root` reaches, from `deno info --json`. Throws
 *  (with deno's own words) when deno cannot build the graph. */
async function localGraph(cwd: string, module: string): Promise<string[]> {
  const o = await new Deno.Command("deno", {
    args: ["info", "--json", module],
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!o.success) {
    throw new Error(
      `${NO} build.minify: deno info ${module} failed:\n` +
        new TextDecoder().decode(o.stderr).trim(),
    );
  }
  const j = JSON.parse(new TextDecoder().decode(o.stdout)) as {
    modules?: { specifier?: string; error?: string }[];
  };
  return (j.modules ?? []).flatMap((m) =>
    m.specifier?.startsWith("file:") && !m.error
      ? [fromFileUrl(m.specifier)]
      : []
  );
}

async function exists(p: string): Promise<Deno.FileInfo | null> {
  return await Deno.lstat(p).catch(() => null); // aio-ok: absent is the answer
}

async function copyTree(from: string, to: string): Promise<void> {
  const st = await Deno.stat(from);
  if (!st.isDirectory) {
    await Deno.mkdir(dirname(to), { recursive: true });
    await Deno.copyFile(from, to);
    return;
  }
  await Deno.mkdir(to, { recursive: true });
  for await (const e of Deno.readDir(from)) {
    // The client map carries every original name and path of the UI code.
    if (e.name === BUNDLE_MAP) continue;
    await copyTree(join(from, e.name), join(to, e.name));
  }
}

/** Build the minified staging copy for a finished `deno compile` argv and
 *  return the argv to run THERE. `argv` is `_compileArgv`'s output: the entry
 *  follows `-o <out>`, runtime args after it.
 *
 *  1. The ORIGINAL entry is type-checked first — the minified copy has no
 *     types, so the staged compile runs `--no-check`, and a type error must
 *     still fail the build exactly as it did.
 *  2. The local module graph of the entry and of every script `--include`
 *     (workers, `*.server.ts`) is minified into `stage`, under the common
 *     ancestor of all of it (an import map may point outside the project).
 *  3. Non-script includes (`dist/`, assets, the version stamp) are copied —
 *     minus the client source map. Every deno.json / package.json / lock
 *     between a module and that ancestor is copied, and `node_modules` /
 *     `vendor` next to one are linked, so resolution is unchanged.
 *  4. Include/entry paths are remapped into the stage; the output path, the
 *     excludes (npm cache paths) and the icon are left alone. */
export async function stageMinified(
  esbuild: Esbuild,
  root: string,
  argv: readonly string[],
): Promise<
  { argv: string[]; cwd: string; modules: number; dispose(): Promise<void> }
> {
  const oi = argv.indexOf("-o");
  if (argv[0] !== "compile" || oi < 0 || !argv[oi + 2]) {
    throw new Error(`build.minify: not a deno compile argv: ${argv.join(" ")}`);
  }
  const abs = (p: string) => isAbsolute(p) ? p : join(root, p);
  const entry = argv[oi + 2]!;
  const includes = argv.flatMap((a, i) =>
    a === "--include" && argv[i + 1] ? [argv[i + 1]!] : []
  );

  // 1. Same type check the plain compile would run.
  if (!argv.includes("--no-check")) {
    const c = await new Deno.Command("deno", {
      args: ["check", "-q", abs(entry)],
      cwd: root,
      stdout: "inherit",
      stderr: "inherit",
    }).output();
    if (!c.success) {
      throw new Error(`${NO} build.minify: type check failed (above)`);
    }
  }

  // 2. The graph — the entry's first: its paths are the ones the binary
  // resolves at run time (`dep/aio/…` through the app's symlink, say).
  const files = new Set(await localGraph(root, abs(entry)));
  // An include may arrive as the REAL path of a directory the entry reaches
  // through a symlink (the builder's own `import.meta.url` does). Staged
  // under its real path, the worker would sit where no module looks for it —
  // so it is renamed into the entry's path space first.
  const seenDir = new Map<string, string>();
  for (const f of files) {
    const d = dirname(f);
    const rd = await Deno.realPath(d).catch(() => d); // aio-ok: a vanished dir keeps its name
    if (!seenDir.has(rd)) seenDir.set(rd, d);
  }
  const canon = async (p: string) => {
    const rp = await Deno.realPath(p).catch(() => p); // aio-ok: an include that does not exist yet keeps its name
    for (let d = dirname(rp); d !== dirname(d); d = dirname(d)) {
      const seen = seenDir.get(d);
      if (seen) return join(seen, relative(d, rp));
    }
    return p;
  };
  const canonIncludes = new Map<string, string>();
  for (const p of includes) canonIncludes.set(p, await canon(abs(p)));
  for (const p of includes.filter((p) => SCRIPT.test(p))) {
    for (const f of await localGraph(root, canonIncludes.get(p)!)) {
      files.add(f);
    }
  }
  const configs = new Set<string>();
  const dirsOf = (f: string) => {
    const out: string[] = [];
    for (let d = dirname(f); d !== dirname(d); d = dirname(d)) out.push(d);
    return out;
  };
  const plainIncludes = includes.filter((p) => !SCRIPT.test(p)).map((p) =>
    canonIncludes.get(p)!
  );
  const anc = common([join(root, SEPARATOR), ...files, ...plainIncludes])
    .replace(/[\\/]+$/, "") || SEPARATOR;
  const within = (p: string) =>
    p === anc || p.startsWith(anc.endsWith(SEPARATOR) ? anc : anc + SEPARATOR);
  for (const f of [join(root, "x"), ...files]) {
    for (const d of dirsOf(f)) {
      if (!within(d)) break;
      for (const n of CONFIGS) {
        if ((await exists(join(d, n)))?.isFile) configs.add(join(d, n));
      }
    }
  }

  const stage = join(root, MINIFY_STAGE);
  const to = (p: string) => join(stage, relative(anc, p));
  // Only "already gone" is fine: a stage that cannot be removed would ship
  // stale files, or leave a copy of the source behind.
  const rmStage = () =>
    Deno.remove(stage, { recursive: true }).catch((e) => {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
    });
  await rmStage(); // a stage left by a killed build, or none
  await Deno.mkdir(stage, { recursive: true });
  const dispose = () =>
    rmStage().catch((e) =>
      console.warn(`${HEY} build.minify: could not remove ${stage}: ${e}`)
    );
  try {
    for (const f of files) {
      await Deno.mkdir(dirname(to(f)), { recursive: true });
      if (!SCRIPT.test(f) || DECL.test(f)) {
        await Deno.copyFile(f, to(f));
        continue;
      }
      const src = await Deno.readTextFile(f);
      let code: string;
      try {
        code = await minifyModule(esbuild, f, src);
      } catch (e) {
        throw new Error(
          `${NO} build.minify: could not minify ${relative(root, f)}: ${
            e instanceof Error ? e.message : e
          }`,
        );
      }
      await Deno.writeTextFile(to(f), code);
    }
    // 3. Includes, configs, linked dirs.
    for (const p of plainIncludes) {
      if (await exists(p)) await copyTree(p, to(p));
    }
    for (const c of configs) {
      await Deno.mkdir(dirname(to(c)), { recursive: true });
      await Deno.copyFile(c, to(c));
      for (const n of LINKED) {
        const real = join(dirname(c), n);
        if (!(await Deno.stat(real).catch(() => null))?.isDirectory) continue; // aio-ok: absent is the answer
        if (await exists(to(real))) continue;
        await Deno.symlink(real, to(real), {
          // A junction needs no privilege on Windows; a dir symlink does.
          type: Deno.build.os === "windows" ? "junction" : "dir",
        });
      }
    }
    // 4. The staged argv.
    const remap = (p: string) => isAbsolute(p) && within(p) ? to(p) : p;
    const out = argv.map((a, i) =>
      argv[i - 1] === "--include"
        ? remap(canonIncludes.get(a)!)
        : i === oi + 2
        ? remap(abs(a))
        : a
    );
    if (!out.includes("--no-check")) out.splice(1, 0, "--no-check");
    return { argv: out, cwd: to(root), modules: files.size, dispose };
  } catch (e) {
    await dispose();
    throw e;
  }
}

/** THE compile step for every compiled target: `deno <argv>` as-is, or —
 *  with `build.minify` — from the minified stage. `{ success: false }` after
 *  saying why when staging fails. */
export async function runCompile(
  root: string,
  argv: string[],
  minify: boolean,
): Promise<{ success: boolean }> {
  const run = (args: string[], cwd?: string) =>
    new Deno.Command("deno", {
      args,
      cwd,
      stdout: "inherit",
      stderr: "inherit",
    }).output();
  if (!minify) return await run(argv);
  // Pinned exactly as the bundle step pins it (build-bundle.ts).
  // deno-lint-ignore no-import-prefix
  const esbuild = await import("npm:esbuild@0.24.2");
  let st;
  try {
    st = await stageMinified(esbuild, root, argv);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return { success: false };
  }
  try {
    console.log(`build.minify: ${st.modules} server modules minified`);
    return await run(st.argv, st.cwd);
  } finally {
    await st.dispose();
  }
}
