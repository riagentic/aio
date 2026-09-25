/**
 * @module
 * Import-map values that pin a compiled binary to THIS machine.
 *
 * Measured on Deno 2.9: an import-map value that is an ABSOLUTE path
 * (`"aio": "/home/me/aio/mod.ts"`) or a `file:` URL is embedded by
 * `deno compile`, yet the binary still loads it from that disk path at run
 * time. It runs on the build machine; moved, copied to another machine, or
 * with that folder gone, it dies with `Module not found`. The SAME module
 * named by a relative value (`"../aio/mod.ts"`, or the `./dep/aio/mod.ts`
 * layout `am create` writes) runs from anywhere. Internal — never re-exported
 * from a public entry.
 */
import {
  dirname,
  fromFileUrl,
  isAbsolute,
  relative,
  SEPARATOR,
} from "@std/path";
import { parseDenoJson, readDenoJson } from "../server/deno-json.ts";
import { warn } from "./build-say.ts";

/** One import-map entry that binds the artifact to this machine's disk. */
export type MachineBoundImport = {
  /** `imports["aio"]` or `scopes["./x/"]["aio"]` — where it is written. */
  key: string;
  /** The value, as written. */
  value: string;
  /** The same target as a path relative to the map's directory — the fix. */
  suggest: string;
};

/** Absolute on ANY OS (a Windows-shaped value is as machine-bound on Linux),
 *  or a `file:` URL. Pure. */
export function isMachineBoundSpecifier(v: string): boolean {
  return /^file:/i.test(v) || v.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(v) || v.startsWith("\\\\");
}

function suggestionFor(value: string, base: string): string {
  let abs = value;
  if (/^file:/i.test(value)) {
    try {
      abs = fromFileUrl(value);
    } catch {
      return value; // an unparseable file: URL — nothing honest to suggest
    }
  }
  if (!isAbsolute(abs)) return value; // a foreign-OS path: no relative form here
  let rel = relative(base, abs).split(SEPARATOR).join("/");
  if (!rel.startsWith("../")) rel = "./" + rel;
  // A trailing "/" is a prefix mapping — `relative` drops it, the map needs it.
  return /[\\/]$/.test(value) && !rel.endsWith("/") ? rel + "/" : rel;
}

/** Every `imports` / `scopes` value in `map` that is absolute or `file:`.
 *  `base` is the directory relative values resolve against (the map file's).
 *  Pure. */
export function machineBoundImports(
  map: { imports?: unknown; scopes?: unknown },
  base: string,
): MachineBoundImport[] {
  const out: MachineBoundImport[] = [];
  const scan = (obj: unknown, label: (k: string) => string) => {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return;
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === "string" && isMachineBoundSpecifier(v)) {
        out.push({ key: label(k), value: v, suggest: suggestionFor(v, base) });
      }
    }
  };
  scan(map.imports, (k) => `imports[${JSON.stringify(k)}]`);
  if (map.scopes && typeof map.scopes === "object") {
    for (const [s, m] of Object.entries(map.scopes)) {
      scan(m, (k) => `scopes[${JSON.stringify(s)}][${JSON.stringify(k)}]`);
    }
  }
  return out;
}

/** The warning text (headline, body, fix) for `found`, or null. Pure. */
export function machineBoundWarning(
  found: readonly MachineBoundImport[],
  file: string,
): [string, string, string] | null {
  if (!found.length) return null;
  return [
    `${file}: ${found.length} import-map value(s) bind the binary to THIS machine`,
    found.map((f) => `${f.key} = ${JSON.stringify(f.value)}`).join("\n") +
    `\nAn absolute path or file: URL is embedded but still loaded from that ` +
    `disk path at run time: the artifact runs here and dies with ` +
    `"Module not found" once that folder moves or on any other machine.`,
    `use a relative path — ${
      found.map((f) => `${f.key}: ${JSON.stringify(f.suggest)}`).join(", ")
    } (or the ./dep/aio/… layout \`am create\` writes; \`am link\` makes dep/aio)`,
  ];
}

/** Warnings already printed by this process — the self-contained Windows exe
 *  is a SECOND compile of the same app, and one fact is said once. */
const said = new Set<string>();

/** Warn (never refuse — such a build does run on this machine) when the
 *  app's import map (deno.json, or the file its `importMap` names) holds a
 *  machine-bound value. Called by every `deno compile` path. */
export async function warnMachineBoundImports(root: string): Promise<void> {
  let dj: Awaited<ReturnType<typeof readDenoJson>>;
  try {
    dj = await readDenoJson(root);
  } catch {
    return; // an unparseable deno.json is reported by the compile itself
  }
  if (!dj) return;
  const maps: { map: Record<string, unknown>; path: string }[] = [
    { map: dj.config, path: dj.path },
  ];
  const ext = dj.config.importMap;
  if (typeof ext === "string" && !/^[a-z][a-z0-9+.-]*:\/\//i.test(ext)) {
    const path = isAbsolute(ext) ? ext : `${dirname(dj.path)}/${ext}`;
    try {
      maps.push({
        map: parseDenoJson(await Deno.readTextFile(path), path),
        path,
      });
    } catch {
      // aio-ok: deno compile names a missing/broken import map itself
    }
  }
  for (const { map, path } of maps) {
    const w = machineBoundWarning(
      machineBoundImports(map, dirname(path)),
      relative(root, path) || path,
    );
    if (!w || said.has(w.join("\n"))) continue;
    said.add(w.join("\n"));
    warn(...w);
  }
}
