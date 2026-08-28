/**
 * @module
 * THE reader for an app's `deno.json` — one spelling, both filenames, JSONC.
 *
 * Deno reads `deno.json` as JSONC: `//` comments are legal there, and
 * `deno.jsonc` is the documented way to ask for them. `JSON.parse` accepts
 * neither. The framework read the file with `JSON.parse` in ELEVEN places, so
 * a single comment — the natural way to explain a non-obvious import alias —
 * broke things in eleven different ways, each with its own symptom:
 *
 *  • every `--compile` build died with `SyntaxError: Expected double-quoted
 *    property name in JSON at position 1464`, naming neither the file nor the
 *    reason. A developer who wrote that comment last week reads it as a
 *    corrupt config.
 *  • `am fix` fell back to `cfg = null`, resolved the entry to the default
 *    `src/app.ts`, and SKIPPED the dependency repair — the main reason to run
 *    it on a fresh clone — with no line of output at all, while still printing
 *    "Now run: deno task dev".
 *
 * That second one was found, fixed and given a post-mortem in `am-cmd-fix.ts`
 * — in that module alone. The other ten kept the bug, which is the whole
 * lesson: a fact spelled eleven times has to be FIXED eleven times.
 *
 * And none of them looked for `deno.jsonc` at all, so a project using the
 * documented extension was invisible to the build even with no comment in it.
 *
 * Reported from the field (R-12). The literal counts are held by
 * `tests/one-fact-one-spelling.test.ts`.
 */
import { parse as parseJsonc } from "@std/jsonc";
import { join } from "@std/path";
import { log } from "../diagnostics/logger-api.ts";

/** Both filenames Deno accepts, in the order it prefers them. */
export const DENO_JSON_NAMES = ["deno.json", "deno.jsonc"] as const;

/** Parse config text the way Deno does. Throws with a message that names the
 *  FILE and the likely cause — a raw `SyntaxError` at "position 1464" is the
 *  failure this module exists to stop. */
export function parseDenoJson(
  text: string,
  path: string,
): Record<string, unknown> {
  try {
    const v = parseJsonc(text);
    if (!v || typeof v !== "object" || Array.isArray(v)) {
      throw new Error("not a JSON object");
    }
    return v as Record<string, unknown>;
  } catch (e) {
    throw new Error(
      `[aio] cannot read ${path}: ${
        e instanceof Error ? e.message : String(e)
      }\n` +
        `  Comments ARE allowed here (Deno reads deno.json as JSONC, and this ` +
        `reader accepts them) — so this is a real syntax error: a trailing ` +
        `comma, an unquoted key, or an unclosed brace.`,
    );
  }
}

/** The app config in `dir`, or null when the directory has neither file.
 *  A file that EXISTS but does not parse throws — silently falling back to
 *  defaults is how a skipped repair printed "Now run: deno task dev". */
export async function readDenoJson(
  dir: string,
): Promise<{ config: Record<string, unknown>; path: string } | null> {
  for (const name of DENO_JSON_NAMES) {
    const path = join(dir, name);
    let text: string;
    try {
      text = await Deno.readTextFile(path);
    } catch {
      continue;
    }
    return { config: parseDenoJson(text, path), path };
  }
  return null;
}

// ── The framework pin ───────────────────────────────────────
//
// `aioVersion` in deno.json is the COMMITTED pin: the version every clone
// builds against. A path pin (`am pin /abs/checkout` — follow a framework
// checkout on this machine) is per-MACHINE by nature, so writing it into the
// committed file pinned every clone to a directory that exists on one laptop.
// It lives in a git-ignored local override instead, and THIS reader — the one
// place `aioVersion` is consulted — prefers it. A legacy `"path:…"` value in
// deno.json is still honoured (warned once) so an app written before the
// override moved keeps building.

/** The git-ignored local override: one line, the absolute checkout path. */
export const LOCAL_PIN_FILE = ".aio/pin.local";

/** Prefix a local path pin carries when returned as a pin string
 *  (`path:/abs/checkout`) — the ONE spelling `framework-pin.ts` decides on. */
const PATH_PIN = "path:";

/** The path in `.aio/pin.local`, or null when absent/empty. A file that
 *  exists but names a directory without `mod.ts` is a dangling override and
 *  THROWS — silently building against something else is the failure the
 *  pin exists to end. */
export function readLocalPinSync(dir: string): string | null {
  const file = join(dir, LOCAL_PIN_FILE);
  let text: string;
  try {
    text = Deno.readTextFileSync(file);
  } catch {
    return null;
  }
  const line = text.split("\n").map((l) => l.trim()).find((l) =>
    l !== "" && !l.startsWith("#")
  );
  if (!line) return null;
  const target = line.startsWith(PATH_PIN) ? line.slice(PATH_PIN.length) : line;
  try {
    Deno.statSync(join(target, "mod.ts"));
  } catch (e) {
    throw new Error(
      `[aio] ${file} pins this app to ${target}, which is not an aio ` +
        `checkout on this machine (no mod.ts). The file is a per-machine ` +
        `override: fix the path, or delete it to build against the ` +
        `committed aioVersion.`,
      { cause: e },
    );
  }
  return target;
}

const _said = new Set<string>();
/** Say a thing once per process per subject — the local override and the
 *  legacy in-file path pin are both worth exactly one line. */
function _once(key: string, say: () => void): void {
  if (_said.has(key)) return;
  _said.add(key);
  say();
}

/** How an app's framework pin was resolved. */
export type FrameworkPin = {
  /** `v1.0.0-alpha67`, `main-<sha>`, or `path:/abs/checkout`; null = unpinned. */
  pin: string | null;
  /** Where it came from: the local override, the committed file, or nowhere. */
  source: "local" | "deno.json" | null;
};

/** THE reader of an app's framework pin: `.aio/pin.local` first (local
 *  override wins, and says so once), then `aioVersion` in deno.json. */
export function readFrameworkPinSync(dir: string): FrameworkPin {
  const local = readLocalPinSync(dir);
  if (local !== null) {
    _once(`local:${dir}`, () => log.info(`aio: local path pin → ${local}`));
    return { pin: PATH_PIN + local, source: "local" };
  }
  let cfg: Record<string, unknown> | undefined;
  try {
    cfg = readDenoJsonSync(dir)?.config;
  } catch {
    return { pin: null, source: null };
  }
  const v = cfg?.aioVersion;
  if (typeof v !== "string" || v === "") return { pin: null, source: null };
  if (v.startsWith(PATH_PIN)) {
    _once(
      `legacy:${dir}`,
      () =>
        log.warn(
          `aio: deno.json carries aioVersion "${v}" — a path pin is ` +
            `per-machine and does not belong in the committed file. Move it: ` +
            `\`am pin ${v.slice(PATH_PIN.length)}\` writes ${LOCAL_PIN_FILE} ` +
            `(git-ignored) and leaves deno.json for a release pin.`,
        ),
    );
  }
  return { pin: v, source: "deno.json" };
}

/** {@linkcode readFrameworkPinSync}, for async callers. */
export function readFrameworkPin(dir: string): Promise<FrameworkPin> {
  return Promise.resolve(readFrameworkPinSync(dir));
}

/** {@linkcode readDenoJson}, synchronously — for the boot paths that run
 *  before any await and for `Deno.readTextFileSync` callers. */
export function readDenoJsonSync(
  dir: string,
): { config: Record<string, unknown>; path: string } | null {
  for (const name of DENO_JSON_NAMES) {
    const path = join(dir, name);
    let text: string;
    try {
      text = Deno.readTextFileSync(path);
    } catch {
      continue;
    }
    return { config: parseDenoJson(text, path), path };
  }
  return null;
}
