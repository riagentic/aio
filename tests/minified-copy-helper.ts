// Load aio modules AS A COMPILED BUILD SHIPS THEM — each one through the real
// `minifyModule`, in a mirror that keeps the source tree's layout.
//
// Why a helper: a function whose SOURCE is emitted (`fn.toString()` into a
// generated script, a worker, a page) is only as good as what the build made
// of that function. Reading the un-minified module proves nothing about it —
// `build.minify` is ON by default, renames every module-level binding, and a
// test that asserted "the script includes the function's text" stayed green
// while the shipped script died with `s is not defined`. So a test of emitted
// source takes its module from HERE, generates the script, and RUNS it.
import * as esbuild from "esbuild";
import { dirname, fromFileUrl, join, relative, toFileUrl } from "@std/path";
import { minifyModule } from "../src/build/minify-server.ts";
import { stopEsbuildService } from "../src/build/esbuild-shared.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const ROOT = fromFileUrl(new URL("../", import.meta.url));
const SCRIPT = /\.(?:[mc]?[jt]sx?)$/;

/** A minified mirror of the local module graph of `entries` (repo-relative
 *  paths; name a worker module too — `new URL("./w.ts", import.meta.url)` is
 *  not a graph edge). `load()` imports a mirrored module. */
export async function minifiedCopy(...entries: string[]): Promise<
  {
    // deno-lint-ignore no-explicit-any
    load(entry: string): Promise<any>;
    [Symbol.asyncDispose](): Promise<void>;
  }
> {
  const files = new Set<string>();
  for (const entry of entries) {
    const o = await new Deno.Command(Deno.execPath(), {
      args: ["info", "--json", join(ROOT, entry)],
      cwd: ROOT,
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (!o.success) throw new Error(new TextDecoder().decode(o.stderr));
    const j = JSON.parse(new TextDecoder().decode(o.stdout)) as {
      modules: { specifier: string }[];
    };
    for (const m of j.modules) {
      if (m.specifier.startsWith("file:")) files.add(fromFileUrl(m.specifier));
    }
  }
  const dir = await tempDir("minified-copy-");
  for (const f of files) {
    const to = join(dir, relative(ROOT, f));
    await Deno.mkdir(dirname(to), { recursive: true });
    if (!SCRIPT.test(f) || f.endsWith(".d.ts")) await Deno.copyFile(f, to);
    else {
      await Deno.writeTextFile(
        to,
        await minifyModule(esbuild, f, await Deno.readTextFile(f)),
      );
    }
  }
  return {
    load: (entry) => import(toFileUrl(join(dir, entry)).href),
    async [Symbol.asyncDispose]() {
      await stopEsbuildService(() => esbuild.stop());
      await dropTempDir(dir);
    },
  };
}

/** ONE module's source, minified and imported — for a fixture that stands in
 *  for app code. Call `stopEsbuild()` when the test is done with it. */
// deno-lint-ignore no-explicit-any
export async function minifiedModule(src: string): Promise<any> {
  return await import(
    "data:text/javascript," +
      encodeURIComponent(await minifyModule(esbuild, "/app/mod.ts", src))
  );
}

/** Stop the esbuild service `minifiedModule` started, and wait for it. */
export const stopEsbuild = (): Promise<void> =>
  stopEsbuildService(() => esbuild.stop());
