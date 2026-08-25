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
