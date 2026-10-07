// guest-preloads.ts — the build's half of deno.json `build.guestPreloads`
// (see server/guest-preloads.ts for the whole story): the declared files
// exist, the app's source asks only for declared ones, and an Electron
// package carries them.
//
// NOT exported from `src/build.ts` — that file is the `aio/build` entry.
import { dirname, join } from "@std/path";
import { codeText } from "../diagnostics/code-mask.ts";
import { GUEST_PRELOAD_URL } from "../protocol/guest-preload.ts";
import {
  declaredGuestPreloads,
  GUEST_PRELOADS_DECLARED,
  GUEST_PRELOADS_DIR,
} from "../server/guest-preloads.ts";

/** The declared guest preloads of the project at `root`, each one checked to
 *  be a file. Throws naming the declaration that is wrong. */
export async function checkedGuestPreloads(
  root: string,
  config: { build?: unknown } | undefined,
): Promise<string[]> {
  const files = declaredGuestPreloads(config);
  for (const rel of files) {
    const isFile = await Deno.stat(join(root, rel)).then((s) => s.isFile)
      .catch((e) => {
        if (e instanceof Deno.errors.NotFound) return false;
        throw e;
      });
    if (!isFile) {
      throw new Error(
        `deno.json build.guestPreloads: "${rel}" is not a file ` +
          `(looked for ${join(root, rel)}). Every declared guest preload ` +
          `ships in the package — fix the path (it is relative to the ` +
          `deno.json) or remove the entry.`,
      );
    }
  }
  return files;
}

/** Copy the declared files from the project into `<distOut>/guest-preloads/`
 *  — the package's `dist/`, where the window resolves a `guestPreload()`
 *  name. A previous pass's files are removed first: what is staged IS what
 *  is declared. */
export async function stageGuestPreloads(
  root: string,
  files: readonly string[],
  distOut: string,
): Promise<void> {
  const out = join(distOut, GUEST_PRELOADS_DIR);
  await Deno.remove(out, { recursive: true }).catch((e) => {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  });
  for (const rel of files) {
    const to = join(out, rel);
    await Deno.mkdir(dirname(to), { recursive: true });
    await Deno.copyFile(join(root, rel), to);
  }
  // The record a package checks itself against at startup.
  if (files.length) {
    await Deno.writeTextFile(
      join(out, GUEST_PRELOADS_DECLARED),
      JSON.stringify([...files].sort()),
    );
  }
}

/** What the app's source says about guest preloads that the declaration does
 *  not back. Pure.
 *
 *  `errors` — CERTAIN to be refused when the guest attaches, in dev and in
 *  the package: `guestPreload("…")` with a literal path that is not declared
 *  (or the same name written out as a URL).
 *
 *  `warnings` — a `<webview>`/`<Browser>` whose `preload` is a string
 *  literal naming a file by path. That can work in dev (the file is in the
 *  project) and cannot in a package. Only a literal on those two tags is
 *  judged: `<video preload="auto">` is something else, and a computed value
 *  cannot be decided here. The same for `__aioIPC.openWindow(url, { preload:
 *  "<literal path>" })`, whose child window has the same file rule. */
export function guestPreloadFindings(
  sources: readonly { path: string; content: string }[],
  declared: readonly string[],
): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const eg = declared[0] ?? "src/guest/preload.cjs";
  for (const { path, content } of sources) {
    const code = codeText(content, /\.[jt]sx$/.test(path));
    const at = (i: number) =>
      `${path}:${content.slice(0, i).split("\n").length}`;
    const undeclared = (i: number, rel: string) => {
      if (declared.includes(rel)) return;
      errors.push(
        `${at(i)}: guestPreload("${rel}") is not declared — add "${rel}" ` +
          `to deno.json "build": { "guestPreloads": [...] }` +
          (declared.length ? ` (declared: ${declared.join(", ")})` : "") +
          `. An undeclared guest preload is refused when the guest attaches.`,
      );
    };
    for (
      const m of content.matchAll(
        /\bguestPreload\(\s*(["'])([^"'\\\n]*)\1\s*\)/g,
      )
    ) {
      // Code only: the same text in a comment or a string is not a call.
      if (code[m.index] !== " ") undeclared(m.index, m[2]!);
    }
    for (
      const m of content.matchAll(
        /<(?:webview|Browser)\b[^<>]*?\bpreload\s*=\s*(?:\{\s*)?(["'`])([^"'`\n]*)/g,
      )
    ) {
      if (code[m.index] === " ") continue;
      const lit = m[2]!;
      if (lit.startsWith(GUEST_PRELOAD_URL)) {
        undeclared(m.index, lit.slice(GUEST_PRELOAD_URL.length));
        continue;
      }
      warnings.push(
        `${at(m.index)}: a <webview> preload named by path ("${lit}") — a ` +
          `packaged build cannot load it: the package carries only declared ` +
          `guest preloads. Declare the file in deno.json "build": ` +
          `{ "guestPreloads": ["${eg}"] } and write ` +
          `preload={guestPreload("${eg}")} (from aio/ui).`,
      );
    }
    // __aioIPC.openWindow(url, { preload: "<literal>" }) — the same file rule
    // (the shell's _openWindow). Only that spelling, a plain first argument
    // and a literal value are judged: any other function named openWindow is
    // not aio's, and a computed value cannot be decided here.
    for (
      const m of content.matchAll(
        /\b__aioIPC\s*(?:\?\.|\.)\s*openWindow\s*\(\s*[^(){}]*?,\s*\{[^{}]*?\bpreload\s*:\s*(["'`])([^"'`\n]*)/g,
      )
    ) {
      if (code[m.index] === " ") continue;
      const lit = m[2]!;
      if (lit.startsWith(GUEST_PRELOAD_URL)) {
        undeclared(m.index, lit.slice(GUEST_PRELOAD_URL.length));
        continue;
      }
      warnings.push(
        `${at(m.index)}: an openWindow preload named by path ("${lit}") — a ` +
          `packaged build cannot load it: the package carries only declared ` +
          `guest preloads. Declare the file in deno.json "build": ` +
          `{ "guestPreloads": ["${eg}"] } and pass ` +
          `{ preload: guestPreload("${eg}") } (from aio/ui).`,
      );
    }
  }
  return { errors, warnings };
}

/** The app's own source files under `appDir` — what {@link
 *  guestPreloadFindings} reads. Links, dot-directories, `node_modules` and
 *  `dist` are not the app's source. */
export async function appSources(
  appDir: string,
  rel = "",
): Promise<{ path: string; content: string }[]> {
  const out: { path: string; content: string }[] = [];
  let entries: Deno.DirEntry[];
  try {
    entries = await Array.fromAsync(Deno.readDir(join(appDir, rel)));
  } catch (e) {
    // No app dir: nothing to read here, and the build says so itself.
    if (rel === "" && e instanceof Deno.errors.NotFound) return out;
    throw e;
  }
  for (const e of entries) {
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory) {
      if (
        e.name.startsWith(".") || e.name === "node_modules" || e.name === "dist"
      ) continue;
      out.push(...await appSources(appDir, p));
    } else if (e.isFile && /\.[cm]?[jt]sx?$/.test(e.name)) {
      out.push({
        path: p,
        content: await Deno.readTextFile(join(appDir, p)),
      });
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}
