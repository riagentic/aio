// Every runtime file replace goes through `src/diagnostics/rename-over.ts`.
//
// On Windows a rename over a file another process has open for an instant is
// refused, and every "write a tmp, rename it over" had a single `rename` and
// no retry — a state file that silently fails to replace is worse than a boot
// that refuses. The helper carries the one rule; this test keeps a raw rename
// from coming back.
//
// And one thing no retry cures: a file that was PUBLISHED BY HARD LINK refuses
// a rename over it (measured on Windows: 1.4–4.1 % of the tries, for seconds).
// So a module that publishes by link renames nothing — the last case here.
import { assert, assertEquals } from "@std/assert";
import { join, relative } from "@std/path";
import { codeText } from "../src/diagnostics/code-mask.ts";

const ROOT = join(import.meta.dirname!, "..");

/** Where a raw `Deno.rename`/`renameSync` may stay, and why. A number is the
 *  exact count of mentions in that file; `true` is the whole file. */
const ALLOWED: Record<string, number | true> = {
  // THE helper.
  "src/diagnostics/rename-over.ts": 2,
  // Directory moves (a data folder aside, a staged tree in) — a different
  // class: nothing is replaced, and each has its own undo.
  "src/am/am-cmd-data.ts": 4,
  // The stdout log of an app that is RUNNING: its writer holds it for life,
  // so no bounded wait can outlast the holder; the failure falls back to a
  // symlink and is said.
  "src/am/am-cmd-process.ts": 1,
  // `renameWithRetry`: a directory move (the unpacked runtime), with its own
  // longer, measured bound and its own tests.
  "src/electron/electron-runtime-fetch.ts": 2,
  // A rollback: what moves is a file OR a whole install folder, into a name
  // that was vacated first, and each step has its own undo and its own words.
  "src/server/updates-apply.ts": 3,
  // The data folder set aside for an update that retires it, and back.
  "src/server/updates-retire.ts": 2,
  // A leftover (a file or a tree) moved out of its name to a free one; one
  // that will not move stays for the next boot.
  "src/server/updates-owned.ts": 1,
};
/** Build-time code: it fails loud at the terminal, on the developer's machine. */
const SKIP_DIRS = ["src/build/"];

function* sources(dir: string): Generator<string> {
  for (const e of Deno.readDirSync(dir)) {
    const p = join(dir, e.name);
    if (e.isDirectory) yield* sources(p);
    else if (/\.(ts|tsx)$/.test(e.name)) yield p;
  }
}

const RAW = /\bDeno\s*\.\s*rename(Sync)?\b/g;

Deno.test("no raw Deno.rename in src/ outside the helper and the listed moves", () => {
  const found = new Map<string, number>();
  let scanned = 0;
  for (const path of sources(join(ROOT, "src"))) {
    const rel = relative(ROOT, path).replaceAll("\\", "/");
    if (SKIP_DIRS.some((d) => rel.startsWith(d))) continue;
    scanned++;
    const n = [...codeText(Deno.readTextFileSync(path)).matchAll(RAW)].length;
    if (n > 0) found.set(rel, n);
  }
  assert(scanned > 300, `only ${scanned} files scanned — the walk is broken`);
  const bad: string[] = [];
  for (const [rel, n] of found) {
    const ok = ALLOWED[rel];
    if (ok === true || ok === n) continue;
    bad.push(
      ok === undefined
        ? `${rel}: ${n} raw rename(s) — use renameOver/renameOverSync (a ` +
          `temp over a file) or moveFile/moveFileSync (a file that is data) ` +
          `from src/diagnostics/rename-over.ts`
        : `${rel}: ${n} raw rename(s), the list allows ${ok}`,
    );
  }
  // A listed file that no longer has any is a stale permission.
  for (const [rel, ok] of Object.entries(ALLOWED)) {
    if (ok !== true && !found.has(rel)) bad.push(`${rel}: listed, has none`);
  }
  assertEquals(bad, []);
});

/** Which VERB each caller uses, and how many times. The two differ in one
 *  thing that matters: `replace-temp` (`renameOver*`) DELETES its source when
 *  the rename fails — right for a temp, the loss of the only copy for a
 *  journal set aside, a damaged database, a staged restore, a log archive.
 *  Those are `move-data` (`moveFile*`). Swapping a verb at any site is red
 *  here, without needing a failing rename at that site. */
const VERBS: Record<string, { "replace-temp"?: number; "move-data"?: number }> =
  {
    // watermark / base / compaction from a temp; quarantine moves the LIVE
    // journal and its base
    "src/server/journal.ts": { "replace-temp": 1, "move-data": 2 },
    "src/diagnostics/checkpoint.ts": { "replace-temp": 2 },
    "src/diagnostics/action-log.ts": { "replace-temp": 1 },
    "src/am/am-cmd-state.ts": { "replace-temp": 1 },
    "src/server/app-dirs.ts": { "replace-temp": 1 },
    // the legacy database itself is moved; its cross-device copy is a temp
    "src/server/app-dirs-migrate.ts": { "replace-temp": 1, "move-data": 1 },
    // the quarantine record from a temp; every `fs.rename` (the two default
    // seams) moves a damaged database or a staged restore
    "src/server/db-integrity.ts": { "replace-temp": 1, "move-data": 2 },
    "src/db/async-db.ts": { "replace-temp": 1 },
    "src/server/blobs.ts": { "replace-temp": 1 },
    // the record of where a build or publish wrote, from a temp
    "src/server/build-outputs.ts": { "replace-temp": 1 },
    "src/electron/electron-fuses.ts": { "replace-temp": 1 },
    "src/electron/electron-runtime-fetch.ts": { "replace-temp": 1 },
    // log files are archived, never deleted by a failed rotation
    "src/diagnostics/logger-rotate.ts": { "move-data": 2 },
    // the trust store from a temp; the verified download into its name
    "src/server/updates-check.ts": { "replace-temp": 1, "move-data": 1 },
    // the record of what the updater made, from a temp
    "src/server/updates-owned.ts": { "replace-temp": 1 },
    // temps: the rollback record, the first-boot token, the temporary link
    // of a versioned install. Data: an unreadable record set aside, the
    // staged build going in (3 layouts), the running version going aside and
    // back (2 layouts), the rollback's link — left where it is on a failure,
    // because the error names it
    "src/server/updates-apply.ts": { "replace-temp": 3, "move-data": 8 },
  };
/** Routed by their own module; not counted here. */
const VERBS_SKIP = new Set(["src/diagnostics/rename-over.ts"]);

/** Uses of each verb in `src`: only the names the file IMPORTS from the helper
 *  count (a file may have a function of its own called `moveFile`), and the
 *  import lines themselves do not. */
function verbsIn(src: string): { "replace-temp": number; "move-data": number } {
  const all = codeText(src);
  const imported = new Set<string>();
  for (
    // the raw text: `codeText` blanks string contents, the path included
    const m of src.matchAll(
      /\bimport\s*\{([^}]*)\}\s*from\s*"[^"]*rename-over\.ts"/g,
    )
  ) {
    for (const name of (m[1] ?? "").split(",")) {
      // `x as y` is counted under the local name `y`, as the verb of `x`.
      const [orig, local] = name.trim().split(/\s+as\s+/);
      if (orig) imported.add(`${orig}=${local ?? orig}`);
    }
  }
  const code = all.replace(/\bimport\b[^;]*?\bfrom\b[^;]*;/g, "");
  const out = { "replace-temp": 0, "move-data": 0 };
  for (const pair of imported) {
    const [orig = "", local = orig] = pair.split("=");
    const verb = /^renameOver(Sync)?$/.test(orig)
      ? "replace-temp"
      : /^moveFile(Sync)?$/.test(orig)
      ? "move-data"
      : null;
    if (!verb) continue;
    out[verb] += [...code.matchAll(new RegExp(`\\b${local}\\b`, "g"))].length;
  }
  return out;
}

Deno.test("every caller uses the verb its file needs: a temp is replaced, data is moved", () => {
  const bad: string[] = [];
  const seen = new Set<string>();
  for (const path of sources(join(ROOT, "src"))) {
    const rel = relative(ROOT, path).replaceAll("\\", "/");
    if (SKIP_DIRS.some((d) => rel.startsWith(d)) || VERBS_SKIP.has(rel)) {
      continue;
    }
    const src = Deno.readTextFileSync(path);
    if (!src.includes("rename-over.ts")) continue;
    const got = verbsIn(src);
    if (got["replace-temp"] + got["move-data"] === 0) continue;
    seen.add(rel);
    const want = VERBS[rel];
    if (!want) {
      bad.push(
        `${rel}: uses the helper but is not in VERBS — add it, with why`,
      );
      continue;
    }
    for (const verb of ["replace-temp", "move-data"] as const) {
      if (got[verb] !== (want[verb] ?? 0)) {
        bad.push(`${rel}: ${got[verb]} × ${verb}, expected ${want[verb] ?? 0}`);
      }
    }
  }
  for (const rel of Object.keys(VERBS)) {
    if (!seen.has(rel)) bad.push(`${rel}: in VERBS, uses neither verb`);
  }
  assertEquals(bad, []);
});

Deno.test("verb count: calls and references count, imports and comments do not", () => {
  assertEquals(
    verbsIn(
      `import { moveFile, renameOver } from "./rename-over.ts";
import {
  moveFileSync,
  renameOverSync,
} from "../diagnostics/rename-over.ts";
// renameOver(a, b) in a comment
await renameOver(tmp, path);
renameOverSync(tmp, path);
const fs = { rename: moveFile };
moveFileSync(a, b);
function removeOverSync() {}`,
    ),
    { "replace-temp": 2, "move-data": 2 },
  );
});

Deno.test("the scan reads code, not comments, and sees both spellings", () => {
  const count = (src: string) => [...codeText(src).matchAll(RAW)].length;
  assertEquals(count("await Deno.rename(a, b);\nDeno.renameSync(a, b);"), 2);
  assertEquals(count("const r = opts.rename ?? Deno.rename;"), 1);
  assertEquals(count("// Deno.rename(a, b)\n/* Deno.renameSync */"), 0);
  assertEquals(count('const s = "Deno.rename(a, b)";'), 0);
  assertEquals(count("await renameOver(a, b); moveFileSync(a, b);"), 0);
});

const LINK = /\bDeno\s*\.\s*link(Sync)?\b/g;

/** The files that PUBLISH a file by hard link (temp written, linked to the
 *  name, temp deleted), and how many renames each may still make. Windows
 *  refuses a rename over a file published that way — measured, 1.4–4.1 % of
 *  the tries, for seconds — so such a file is written in place or removed,
 *  never renamed over. `not` is what no rename in the file may name. */
const LINK_PUBLISHERS: Record<string, { renames: number; not?: RegExp }> = {
  // The lock record: every change to it is a write through an open handle.
  "src/server/single-instance-lock.ts": { renames: 0 },
  // The link publishes a blob's NAME record (`metaPath`), which is then only
  // read and removed; the one rename puts the blob's bytes at their own name.
  "src/server/blobs.ts": { renames: 1, not: /metaPath/ },
};

/** Every rename a file makes — the helper's verbs and raw ones — as the text
 *  of each call up to its closing `;`. */
function renameCalls(src: string): string[] {
  const code = codeText(src).replace(/\bimport\b[^;]*?\bfrom\b[^;]*;/g, "");
  return [
    ...code.matchAll(
      /\b(?:renameOver|moveFile|Deno\s*\.\s*rename)(?:Sync)?\b[^;]*/g,
    ),
  ].map((m) => m[0]);
}

Deno.test("a file published by hard link is never renamed over: its module renames nothing else", () => {
  const bad: string[] = [];
  const seen = new Set<string>();
  for (const path of sources(join(ROOT, "src"))) {
    const rel = relative(ROOT, path).replaceAll("\\", "/");
    const src = Deno.readTextFileSync(path);
    if ([...codeText(src).matchAll(LINK)].length === 0) continue;
    seen.add(rel);
    const rule = LINK_PUBLISHERS[rel];
    if (!rule) {
      bad.push(
        `${rel}: publishes by hard link but is not in LINK_PUBLISHERS — ` +
          `list it, and change what it published in place, never by rename`,
      );
      continue;
    }
    const calls = renameCalls(src);
    if (calls.length !== rule.renames) {
      bad.push(`${rel}: ${calls.length} rename(s), expected ${rule.renames}`);
    }
    for (const c of calls) {
      if (rule.not?.test(c)) {
        bad.push(`${rel}: renames over a linked name: ${c}`);
      }
    }
  }
  for (const rel of Object.keys(LINK_PUBLISHERS)) {
    if (!seen.has(rel)) bad.push(`${rel}: listed, publishes nothing by link`);
  }
  assertEquals(bad, []);
});

Deno.test("rename calls: the helper's verbs and raw renames are found, imports and comments are not", () => {
  const calls = renameCalls(
    `import { renameOverSync } from "./rename-over.ts";
// renameOver(a, b)
renameOverSync(tmp, metaPath(dir, id));
await Deno.rename(a, b);
Deno.linkSync(tmp, path);`,
  );
  // Two calls, in order — and each is the whole call, so what it names shows.
  assertEquals(calls.map((c) => c.length), [38, 17]);
  assertEquals(calls.map((c) => /metaPath/.test(c)), [true, false]);
});
