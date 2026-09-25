#!/usr/bin/env -S deno run --allow-read
// check-dead-wiring.ts — the claim-without-a-wiring detector.
//
// `scripts/check-vacuous.ts` catches a test that passes while proving nothing.
// This is its cousin one layer down: a FUNCTION that exists while doing
// nothing, because nothing in `src/` ever reaches it.
//
// The bug that named the class, from `src/browser/protocol-subscription.ts`:
//
//     /** Record an outgoing action for the DevTools trace. Called by the send
//      *  path (browser-protocol's send wrapper + `client.send`). */
//     export function _noteDispatch(action) { _lastAction = action; }
//
// It was exported. It type-checked. Its doc comment named its two callers by
// name. Neither caller existed. The consequence was invisible for the life of
// the feature: every DevTools state frame was attributed to the placeholder
// action `@@aio/state` instead of the action that produced it — a green suite,
// a documented function, and dead wiring. Its neighbours in the same file
// (`_notify`, `_sendDevTools`) had already been found the same way, by hand.
//
// A doc comment is a CLAIM about who calls a function. The compiler never
// checks it, the suite never checks it, and `src/` is the only place where
// being called actually means the shipped app does the thing. So:
//
//   THE RULE — every symbol exported from a non-entry file under `src/` must
//   be referenced from `src/` itself. Being imported by `tests/`, `scripts/`,
//   `amui/`, `aiol/`, `examples/` or a doc snippet is not being wired: a test
//   can call a function the product never calls, and that is precisely how a
//   dead helper stays green.
//
//   The same rule holds for the two peer apps in this repo (`ROOTS`): an
//   export under `aiol/` must be reached from `aiol/` or `src/`, one under
//   `amui/` from `amui/` or `src/`. Their entry points (`PEER_ENTRIES`) are
//   exempt exactly as `src/*.ts` is. `node_modules/` and `.d.ts` are skipped.
//
// SCOPE — what is deliberately NOT an offence:
//
//   • Root entry files (`src/*.ts`) and the `src/` paths in `deno.json`'s
//     `exports` map ARE the public surface (`src/entries.ts` is the one list).
//     A symbol they export is consumed by APPS, which this scan cannot see, so
//     every export of an entry is exempt — including one that reaches an entry
//     through an `export * from "./x.ts"` chain, which is followed here.
//   • A symbol referenced only from inside its OWN file is wired: it runs. The
//     export may be redundant, but that is a tidiness question and a different
//     ledger (587 of them the day this landed — a sweep, not a gate).
//
// It is a LEDGER THAT ONLY SHRINKS, with exactly the mechanics of
// `check-vacuous.ts`: the offenders that existed the day it landed are frozen
// in `LEDGER` so it could go green immediately, and:
//
//   • a NEW unreferenced export is RED, reported with file:line.
//   • one that has been WIRED (or deleted) is also RED, telling you which
//     ledger line to delete. A ratchet allowed to sit above the real count is
//     a ceiling, and a ceiling rots.
//
// Being on the ledger is not absolution. It is a debt with your name on it —
// either wire it, delete it, or say why it may live unwired:
//
//     // aio-ok: a test-only seam — the harness resets this between cases.
//
//   deno task check:dead-wiring                 report (exit 1 if it moved)
//   deno task check:dead-wiring --all           every offender, ledger included
//   deno task check:dead-wiring --print-ledger  paste-ready regenerated ledger

import { justified as okMarker } from "../src/diagnostics/ok-marker.ts";
import { mask } from "./source-mask.ts";
import {
  check as persistCheck,
  report as persistReport,
} from "./check-persist-decider.ts";

export type Offender = {
  file: string;
  line: number;
  name: string;
  kind: string;
};

/** `<file>|<name>` — deliberately line-free, so moving a declaration inside
 *  its file does not churn the ledger. */
export const key = (o: Offender): string => `${o.file}|${o.name}`;

// Masking lives in ./source-mask.ts (shared with check-persist-decider.ts,
// which must not import this file: a cycle deadlocks this CLI's top-level await).
export { mask } from "./source-mask.ts";

const lineOf = (src: string, idx: number): number =>
  src.slice(0, idx).split("\n").length;

/** The acknowledgement marker, spelled the way the rest of the repo spells it
 *  (`scripts/check-vacuous.ts`, `scripts/check-silent-catch.ts`,
 *  `src/server/graph-validator.ts`). A bare `aio-ok` with nothing after it is
 *  not an acknowledgement, it is a mute button. */
/** One marker, both spellings, honoured only when it is addressed to
 *  this gate or to nobody in particular. See scripts/ok-marker.ts. */
const JUSTIFIED = { test: (line: string) => okMarker(line, "dead-wiring") };

/** True when the declaring line, or the line above it, carries `aio-ok: …`. */
function justified(src: string, idx: number): boolean {
  const before = src.slice(0, idx).split("\n");
  const cur = src.split("\n")[before.length - 1] ?? "";
  const prev = before[before.length - 2] ?? "";
  return JUSTIFIED.test(cur) || JUSTIFIED.test(prev);
}

// ─── declarations and references ───────────────────────────────────────────

/** `export <kind> NAME` — every exported binding that HAS a name here.
 *
 *  `export { a, b as c }` and `export * from "…"` are deliberately absent:
 *  they declare nothing, they REFERENCE something declared elsewhere, and the
 *  identifier scan below already counts them as such. */
const DECL =
  /\bexport\s+(?:declare\s+)?(?:async\s+)?(?:function\s*\*?|abstract\s+class|class|const\s+enum|const|let|var|type|interface|enum|namespace)\s+([A-Za-z_$][\w$]*)/g;

const IDENT = /[A-Za-z_$][\w$]*/g;

/** An `import … from "…"` statement, up to (not including) `from`. The names
 *  inside are BINDINGS, not uses: `import { _noteDispatch } from "…"` proves
 *  only that somebody meant to call it. Excluding them is what makes the
 *  detector able to see the bug it was written for — the real `_noteDispatch`
 *  regression is invisible while its own import counts as a reference.
 *  (`export { x } from "…"` is deliberately NOT here: re-exporting a symbol
 *  from an entry IS how the public surface wires it.) */
const IMPORT_HEAD = /\bimport\s+(?:type\s+)?[^;]*?\bfrom\b/g;

export type File = {
  path: string;
  src: string;
  masked: string;
  /** name → every offset it appears at, in the masked copy. */
  idents: Map<string, number[]>;
  /** The offsets that ARE the `export <kind> NAME` declarations. */
  declOffsets: Set<number>;
  /** The offsets that merely BIND a name (an import's local specifiers). */
  bindOffsets: Set<number>;
};

export function readFile(path: string, text: string): File {
  const masked = mask(text);
  const idents = new Map<string, number[]>();
  IDENT.lastIndex = 0;
  let hit: RegExpExecArray | null;
  while ((hit = IDENT.exec(masked))) {
    const at = idents.get(hit[0]);
    if (at) at.push(hit.index);
    else idents.set(hit[0], [hit.index]);
  }
  // Offsets that BIND rather than use: the local names of an import. The
  // source half of `{ a as b }` is left alone — `b` being used downstream is
  // what makes `a` wired, and this scan cannot follow the alias.
  const bindOffsets = new Set<number>();
  IMPORT_HEAD.lastIndex = 0;
  while ((hit = IMPORT_HEAD.exec(masked))) {
    const head = hit[0];
    IDENT.lastIndex = 0;
    let id: RegExpExecArray | null;
    while ((id = IDENT.exec(head))) {
      const aliased = /\bas\s+$/.test(head.slice(0, id.index));
      const isAliasSource = /^\s*as\b/.test(head.slice(IDENT.lastIndex));
      if (!aliased && isAliasSource) continue;
      bindOffsets.add(hit.index + id.index);
    }
  }
  const declOffsets = new Set<number>();
  DECL.lastIndex = 0;
  while ((hit = DECL.exec(masked))) {
    declOffsets.add(hit.index + hit[0].lastIndexOf(hit[1]!));
  }
  return { path, src: text, masked, idents, declOffsets, bindOffsets };
}

/** Every `export <kind> NAME` in a file, deduped (an overload set declares one
 *  symbol, not three). */
export function declarations(f: File): Offender[] {
  const out: Offender[] = [];
  const seen = new Set<string>();
  DECL.lastIndex = 0;
  let hit: RegExpExecArray | null;
  while ((hit = DECL.exec(f.masked))) {
    const name = hit[1]!;
    if (seen.has(name)) continue;
    seen.add(name);
    const idx = hit.index + hit[0].lastIndexOf(name);
    if (justified(f.src, idx)) continue;
    out.push({
      file: f.path,
      line: lineOf(f.src, idx),
      name,
      kind: hit[0].replace(/\s+/g, " ").replace(` ${name}`, "").trim(),
    });
  }
  return out;
}

// ─── the scan ──────────────────────────────────────────────────────────────

const isSrc = (p: string) => /\.tsx?$/.test(p) && !/\.(test|d)\.tsx?$/.test(p);

async function* walk(dir: string): AsyncGenerator<string> {
  for await (const e of Deno.readDir(dir)) {
    const p = `${dir}/${e.name}`;
    // amui/ has a `nodeModulesDir: auto` tree — vendored code, not ours.
    if (e.isDirectory && e.name !== "node_modules") yield* walk(p);
    else if (isSrc(e.name)) yield p;
  }
}

/** The public surface, from the ONE list that defines it: `deno.json`'s
 *  `exports` map (mirrored by `src/entries.ts`, which `tests/
 *  entry-surface-parity.test.ts` keeps in step), plus the root entry files
 *  `src/*.ts` — which `scripts/check-boundaries.ts` already treats as the
 *  surface every folder may import. */
/** The peer apps' entry points — what `deno task lint:aio` and `deno task
 *  amui` run (the ONE place each is named is `deno.json`'s task line, and
 *  `tests/no-dead-wiring.test.ts` checks these two match it). */
export const PEER_ENTRIES: readonly string[] = [
  "aiol/mod.ts",
  "amui/src/app.ts",
];

export async function entryFiles(root: string, files: string[]) {
  const dj = JSON.parse(await Deno.readTextFile(`${root}deno.json`)) as {
    exports: Record<string, string>;
  };
  const out = new Set<string>(["mod.ts", ...PEER_ENTRIES]);
  for (const v of Object.values(dj.exports)) out.add(v.replace(/^\.\//, ""));
  for (const f of files) if (/^src\/[^/]+\.tsx?$/.test(f)) out.add(f);
  return out;
}

/** Files whose whole export list is public because an entry re-exports it
 *  wholesale — `src/cell-test.ts` is `export * from "./testing/cell-test.ts"`,
 *  and `bootCells` is as public as anything in `mod.ts`. Followed
 *  transitively; a named `export { x } from` needs no special case, since `x`
 *  appears as an identifier in the entry and the scan counts it. */
export function starExported(
  entries: Set<string>,
  by: Map<string, File>,
): Set<string> {
  const out = new Set<string>();
  const queue = [...entries];
  while (queue.length) {
    const p = queue.pop()!;
    const f = by.get(p);
    if (!f) continue;
    for (const m of f.masked.matchAll(/\bexport\s+\*\s+from\s+["'`]/g)) {
      // The specifier was masked away with the rest of the string; read it back
      // out of the original at the same offset.
      const q = f.src.indexOf(f.src[m.index + m[0].length - 1]!, m.index);
      const end = f.src.indexOf(f.src[q]!, q + 1);
      const spec = f.src.slice(q + 1, end);
      if (!spec.startsWith(".")) continue;
      const target = resolve(p, spec);
      if (out.has(target)) continue;
      out.add(target);
      queue.push(target);
    }
  }
  return out;
}

const resolve = (from: string, spec: string): string => {
  const parts = from.split("/").slice(0, -1);
  for (const seg of spec.split("/")) {
    if (seg === ".") continue;
    else if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("/");
};

/** The roots this gate walks, and the rule for each: an export from a file
 *  under ROOT is wired when a file under ROOT — or under `src/` — reaches it.
 *
 *  `aiol/` (the project linter) and `amui/` (the visual app manager) are
 *  peer apps with their own entry points, not part of the framework surface:
 *  a helper exported from `aiol/checks.ts` that only a test calls is dead in
 *  exactly the way `_noteDispatch` was. Each root is judged from ITSELF plus
 *  `src/` — never from the other peer (amui reaching into aiol would be a
 *  boundary question, not a wiring), and never from `tests/`. */
export const ROOTS: readonly string[] = ["src", "aiol", "amui"];

const rootOf = (p: string): string => p.split("/")[0]!;

/** Every unreferenced export in the repo, sorted by file then line. */
export async function scan(
  root: string,
  roots: readonly string[] = ROOTS,
): Promise<Offender[]> {
  const paths: string[] = [];
  for (const r of roots) {
    for await (const p of walk(`${root}${r}`)) paths.push(p.slice(root.length));
  }
  paths.sort();
  // `mod.ts` is not under src/, but it IS the surface: what it names is wired.
  paths.push("mod.ts");

  const by = new Map<string, File>();
  for (const p of paths) by.set(p, await loadFile(root, p));

  const entries = await entryFiles(root, paths);
  const wholesale = starExported(entries, by);
  const exempt = (p: string) => entries.has(p) || wholesale.has(p);

  const out: Offender[] = [];
  for (const p of paths) {
    if (exempt(p)) continue;
    const home = rootOf(p);
    for (const d of declarations(by.get(p)!)) {
      let wired = false;
      for (const f of by.values()) {
        const fr = rootOf(f.path);
        if (fr !== home && fr !== "src" && f.path !== "mod.ts") continue;
        const at = f.idents.get(d.name);
        if (!at) continue;
        // Neither the declaration itself nor an import that binds the name is
        // a reference. Everything left is somebody actually reaching for it.
        const uses = at.filter((i) =>
          !f.bindOffsets.has(i) && !(f.path === d.file && f.declOffsets.has(i))
        );
        if (uses.length === 0) continue;
        wired = true;
        break;
      }
      if (!wired) out.push(d);
    }
  }
  return out.sort((a, b) =>
    a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1
  );
}

// ─── the ledger ────────────────────────────────────────────────────────────
//
// Frozen on the day the detector landed. It may ONLY get shorter. Every line
// is a symbol `src/` exports and `src/` never reaches: a test-only seam that
// should say so with `// aio-ok:`, a helper waiting to be deleted, or — the
// reason this file exists — a wiring somebody believed was there.

export const LEDGER: readonly string[] = [
  "src/air/dev-readonly-hint.ts|_resetReadOnlyHint",
  "src/air/renderer-flush.ts|_setFlushBudget",
  "src/air/time-travel-panel.ts|setSendFn",
  "src/air/ui-surface.ts|_resetForwardedHandles",
  "src/air/vdom-create.ts|_componentChainOf",
  "src/air/vdom-events.ts|_resetEventWarnings",
  "src/am/am-cmd-data.ts|_internals",
  "src/am/am-components.ts|componentsRoot",
  "src/am/am-http.ts|_resetInstanceVerify",
  "src/am/am-http.ts|verifyInstance",
  "src/am/am-utils.ts|writePid",
  "src/am/am-utils.ts|runTrojanPost",
  "src/am/am-versions.ts|removeVersion",
  "src/browser/browser-ack.ts|_setAckTimeoutMs",
  "src/browser/browser-ack.ts|_setAckGraceMs",
  "src/browser/browser-ack.ts|_pendingAckCount",
  "src/browser/browser-protocol.ts|_setSyncLoaderForTest",
  "src/browser/browser-protocol.ts|_resetEnsured",
  "src/browser/browser-sync.ts|syncCellNames",
  "src/browser/browser-sync.ts|getBrowserSyncEngine",
  "src/browser/browser-sync.ts|_resetBrowserSync",
  "src/browser/console-intercept.ts|uninstallConsoleIntercept",
  "src/browser/server-fns-client.ts|_resetSfnClient",
  "src/build/capabilities.ts|_SCANNED_FS_APIS",
  "src/build/electron-runtime.ts|electronZipUrl",
  "src/build/electron-runtime.ts|electronCacheDir",
  "src/db/state-sync.ts|_resetDbReports",
  "src/diagnostics/degraded.ts|_degradedRegistrySize",
  "src/diagnostics/diagnostic-bus.ts|isDiagDev",
  "src/diagnostics/diagnostic-bus.ts|_diagDedupSize",
  "src/protocol/broadcast-utils.ts|SubClient",
  "src/protocol/envelope.ts|SERVES",
  "src/server/aio-cli.ts|_resetParsedCli",
  "src/server/app-dirs.ts|ensureAppPayloadDir",
  "src/server/auth-oidc.ts|_resetOidcCaches",
  "src/server/auth-totp.ts|_resetTotpReplay",
  "src/server/blobs.ts|_resetBlobStores",
  "src/server/client-log.ts|_rateSlotCount",
  "src/server/config.ts|_resetConfigConflicts",
  "src/server/graph-validator.ts|extractImports",
  "src/server/pairing.ts|currentPin",
  "src/server/pairing.ts|clearPairing",
  "src/server/server-auth.ts|_extractToken",
  "src/server/server-auth.ts|_resetAuthFails",
  "src/server/server-auth.ts|_resetMachineHostname",
  "src/server/server-fns.ts|_resetServerFns",
  "src/server/server-html-importmap.ts|_resetImportMapWarnings",
  "src/server/server-vendor.ts|_resetVendorCache",
  "src/server/server.ts|_resetSecurityWarnings",
  "src/server/single-instance-lock.ts|removeLaunchInfo",
  "src/server/updates-check.ts|cacheCurrentEtag",
  "src/server/updates-check.ts|isShipManifest",
  "src/server/win-pipe.ts|overlappedEvent",
  "src/state/cell-catalog.ts|flattenOnto",
  "src/state/cell-config-types.ts|SelectorReturn",
  "src/state/cell-impl.ts|unwrapDraftDo",
  "src/state/cell-types.ts|FilterUser",
  "src/state/feedback-cell.ts|_resetFeedbackRate",
  "src/state/method-cancel.ts|_cancelTriggerCount",
  "src/state/own.ts|_resetPendingFactories",
  "src/state/own.ts|_pendingFactoryCount",
  "src/sync/op-buffer.ts|createMemoryStorage",
  "src/sync/server-store.ts|_resetServerTsForTest",
  "src/sync/types.ts|OpRejectedMessage",
  "src/testing/test-display.ts|_resetTestDisplay",
  "src/vitals/types.ts|RenderFreezeReport",
];

export type Verdict = {
  offenders: Offender[];
  added: Offender[];
  fixed: string[];
};

export function verdict(
  offenders: Offender[],
  ledger: readonly string[],
): Verdict {
  const seen = new Set(offenders.map(key));
  const known = new Set(ledger);
  return {
    offenders,
    added: offenders.filter((o) => !known.has(key(o))),
    fixed: [...known].filter((k) => !seen.has(k)).sort(),
  };
}

export function report(v: Verdict): string {
  const lines: string[] = [];
  if (v.added.length) {
    lines.push(
      `${v.added.length} symbol${
        v.added.length === 1 ? "" : "s"
      } exported that nothing in the owning root (or src/) reaches:\n`,
    );
    for (const o of v.added) {
      lines.push(`  ${o.file}:${o.line}  ${o.kind} ${o.name}`);
    }
    lines.push(
      `\n  A doc comment naming a caller is a claim, not a call. Wire it, ` +
        `delete it, or — if it is a seam the product is not supposed to ` +
        `reach — say so on the line:\n      // aio-ok: <why this may live ` +
        `unwired>`,
    );
  }
  if (v.fixed.length) {
    lines.push(
      `\n${v.fixed.length} ledger entr${
        v.fixed.length === 1 ? "y is" : "ies are"
      } wired (or gone) — good. Delete these lines from LEDGER in ` +
        `scripts/check-dead-wiring.ts and commit:\n`,
    );
    for (const k of v.fixed) lines.push(`  ${JSON.stringify(k)},`);
  }
  return lines.join("\n");
}

/** Every source file under ROOTS, read and masked — the input the aliased
 *  import scan needs and `scan()` keeps to itself. */
async function readSources(root: string): Promise<File[]> {
  const out: File[] = [];
  for (const r of ROOTS) {
    for await (const p of walk(`${root}${r}`)) {
      out.push(await loadFile(root, p.slice(root.length)));
    }
  }
  return out;
}

/** One read + one mask per file per process. `scan`, the aliased-import scan
 *  and the `@decider` check all walk the same tree; before this each re-read
 *  and re-masked it (the whole gate runs before every `deno task test`). */
const _files = new Map<string, File>();
async function loadFile(root: string, rel: string): Promise<File> {
  const key = root + rel;
  let f = _files.get(key);
  if (!f) {
    f = readFile(rel, await Deno.readTextFile(key));
    _files.set(key, f);
  }
  return f;
}

/** `mask(src)`, memoised by content — the re-export walk revisits files. */
const _masked = new Map<string, string>();
function maskOnce(src: string): string {
  let m = _masked.get(src);
  if (m === undefined) {
    m = mask(src);
    _masked.set(src, m);
  }
  return m;
}

/** An `_`-aliased import that is never used — the one dead wiring the LANGUAGE
 *  tools cannot see.
 *
 *  `deno lint`'s `no-unused-vars` deliberately ignores identifiers that start
 *  with `_`, and its own hint teaches the alias as the way to keep a binding it
 *  would otherwise flag. So `import { resetTT as _resetTT } from …` is an
 *  unused import that type-checks, lints clean, and reads as deliberate.
 *
 *  Measured when this landed: exactly one, and it mattered — the time-travel
 *  panel's reset, whose doc comment named a caller in a file deleted three
 *  releases earlier. Nothing called it, so every client teardown left a
 *  `keydown` listener on `document` and a node in the DOM. Six other aliased
 *  imports in `src/` were all genuinely used; the class was empty except for
 *  the one, and nothing was keeping it that way. */
export function aliasedDeadImports(files: readonly File[]): Offender[] {
  const out: Offender[] = [];
  for (const f of files) {
    // The MASKED copy: a name that appears only inside a comment or a string
    // is not a use, and this scan exists precisely because such a mention is
    // what made the dead one look alive.
    const code = f.masked;
    const path = f.path;
    for (const m of code.matchAll(/\bimport\s+(?:type\s+)?\{([^}]*)\}/g)) {
      const block = m[1] ?? "";
      for (const a of block.matchAll(/\bas\s+(_[A-Za-z0-9_$]*)/g)) {
        const name = a[1]!;
        // Every occurrence of the local name: the import itself is one, so a
        // total of one means nothing else in the file mentions it.
        const uses = code.split(new RegExp(`\\b${name}\\b`)).length - 1;
        if (uses > 1) continue;
        const line = code.slice(0, m.index ?? 0).split("\n").length;
        out.push({ file: path, line, kind: "import", name });
      }
    }
  }
  return out;
}

// ─── @decider: a single decider is pinned by a test ─────────────────────────
//
// ~85 files call something "THE decider" / "ONE decider" in prose. That is a
// claim that a whole class of behaviour flows through one function — and the
// claim is only worth anything if a test holds that function still. Prose is
// never the gate (grepping the WORD would be all noise); the gate is a JSDoc
// TAG, placed deliberately on the functions that really are one decider:
//
//     /** THE decider for "is this app reachable off loopback?" …
//      *
//      *  @decider */
//     export function _exposeOf(…)
//
//   THE RULE — a function whose JSDoc carries `@decider` (as a tag: at the
//   start of a doc line) must be EXPORTED, and some `tests/**/*.test.ts(x)`
//   must IMPORT it — from its own file, or from any module that re-exports it
//   (`export { x } from` / `export * from`, followed to the declaration). An
//   import that sits in a comment or a fixture string does not count.

/** A `@decider` tag at the start of a JSDoc line — never a prose mention. */
const DECIDER_TAG = /(?:^|\n)[ \t]*\*?[ \t]*@decider\b/;

/** The declaration a doc block documents: whatever follows it, past blank
 *  lines and `//` comments (an `aio-ok:` marker often sits between). */
const DOC_TARGET =
  /^(?:\s|\/\/[^\n]*\n)*(export\s+)?(?:(?:async\s+)?function\s*\*?\s*|(?:const|let)\s+)([A-Za-z_$][\w$]*)/;

/** Every `@decider`-tagged declaration in a file. */
export function taggedDeciders(
  f: File,
): { name: string; line: number; exported: boolean }[] {
  const out: { name: string; line: number; exported: boolean }[] = [];
  for (const m of f.src.matchAll(/\/\*\*([\s\S]*?)\*\//g)) {
    if (!DECIDER_TAG.test(m[1]!)) continue;
    const end = m.index + m[0].length;
    const t = DOC_TARGET.exec(f.src.slice(end));
    out.push({
      name: t?.[2] ?? "",
      line: lineOf(f.src, t ? end + t[0].length - t[2]!.length : m.index),
      exported: !!t?.[1],
    });
  }
  return out;
}

/** What a test file imports: `[resolved path, imported name]` pairs, from
 *  static named imports, and — for a namespace import (`ns.x`) or a dynamic
 *  `import("…")` — every name in `wanted` the test's CODE uses. Only matches
 *  whose `import` keyword is code in the masked copy count, so an import
 *  written inside a fixture string or a comment is not one. */
export function testImports(
  t: File,
  resolveSpec: (from: string, spec: string) => string | null,
  wanted: ReadonlySet<string>,
): [string, string][] {
  const out: [string, string][] = [];
  const isCode = (i: number) => t.masked.startsWith("import", i);
  for (
    const m of t.src.matchAll(
      /\bimport\s+(type\s+)?(?:[\w$]+\s*,\s*)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g,
    )
  ) {
    if (m[1] || !isCode(m.index)) continue;
    const file = resolveSpec(t.path, m[3]!);
    if (!file) continue;
    for (const spec of m[2]!.split(",")) {
      const s = spec.trim();
      if (!s || /^type\s/.test(s)) continue;
      out.push([file, s.split(/\s+as\s+/)[0]!.trim()]);
    }
  }
  const byName = (file: string) => {
    for (const name of wanted) if (t.idents.has(name)) out.push([file, name]);
  };
  for (
    const m of t.src.matchAll(
      /\bimport\s+\*\s+as\s+[\w$]+\s+from\s*["']([^"']+)["']/g,
    )
  ) {
    if (!isCode(m.index)) continue;
    const file = resolveSpec(t.path, m[1]!);
    if (file) byName(file);
  }
  for (
    const m of t.src.matchAll(/\bimport\s*\(\s*["'`]([^"'`$]+)["'`]\s*\)/g)
  ) {
    if (!isCode(m.index)) continue;
    const file = resolveSpec(t.path, m[1]!);
    if (file) byName(file);
  }
  return out;
}

/** `export { a as b } from "x"` / `export * from "x"` edges of one file:
 *  `[exported name | "*", target file, source name]`. */
function reexports(
  file: string,
  read: (p: string) => string | undefined,
): [string, string, string][] {
  const src = read(file);
  if (src === undefined) return [];
  const code = maskOnce(src);
  const out: [string, string, string][] = [];
  for (
    const m of src.matchAll(
      /\bexport\s+(?:type\s+)?(?:\{([^}]*)\}|\*)\s*from\s*["']([^"']+)["']/g,
    )
  ) {
    if (!code.startsWith("export", m.index)) continue;
    const next = resolve(file, m[2]!);
    if (m[1] === undefined) {
      out.push(["*", next, "*"]);
      continue;
    }
    for (const spec of m[1].split(",")) {
      const [from, alias] = spec.trim().replace(/^type\s+/, "").split(
        /\s+as\s+/,
      );
      if (from?.trim()) out.push([(alias ?? from).trim(), next, from.trim()]);
    }
  }
  return out;
}

/** A resolver from `(file, name)` to the `@decider` declarations
 *  (`"<file>|<name>"` in `targets`) it leads to, following re-export chains.
 *  Memoised per file, so a whole test tree resolves in one pass. */
export function decidersReached(
  targets: ReadonlySet<string>,
  read: (p: string) => string | undefined,
): (file: string, name: string) => boolean {
  const edges = new Map<string, [string, string, string][]>();
  const memo = new Map<string, boolean>();
  const go = (file: string, name: string, seen: Set<string>): boolean => {
    const key = `${file}|${name}`;
    if (targets.has(key)) return true;
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    if (seen.has(key)) return false;
    seen.add(key);
    if (!edges.has(file)) edges.set(file, reexports(file, read));
    let ok = false;
    for (const [as, next, from] of edges.get(file)!) {
      if (
        as === "*" ? go(next, name, seen) : as === name && go(next, from, seen)
      ) {
        ok = true;
        break;
      }
    }
    memo.set(key, ok);
    return ok;
  };
  return (file, name) => go(file, name, new Set());
}

/** `@decider`-tagged functions no test imports (or that no test COULD
 *  import, being unexported). */
export function unpinnedDeciders(
  sources: readonly File[],
  tests: readonly File[],
  resolveSpec: (from: string, spec: string) => string | null,
  read: (p: string) => string | undefined,
): Offender[] {
  const out: Offender[] = [];
  const live: { file: string; line: number; name: string }[] = [];
  for (const f of sources) {
    for (const d of taggedDeciders(f)) {
      const at = { file: f.path, line: d.line, name: d.name || "?" };
      if (!d.name) out.push({ ...at, kind: "@decider on no function" });
      else if (!d.exported) out.push({ ...at, kind: "@decider not exported" });
      else live.push(at);
    }
  }
  const wanted = new Set(live.map((d) => d.name));
  const pinned = new Set<string>();
  const reached = (target: string) => decidersReached(new Set([target]), read);
  // One resolver per decider keeps each answer exact (a name re-exported from
  // two files cannot credit the wrong one); the memo inside keeps it cheap.
  const resolvers = new Map(live.map((d) => {
    const k = `${d.file}|${d.name}`;
    return [k, reached(k)] as const;
  }));
  // Only an import of a decider's OWN name is followed. A re-export that
  // renames a decider (`export { x as y }`) would read as unpinned — a loud
  // false positive, never a silent pass.
  for (const t of tests) {
    for (const [file, name] of testImports(t, resolveSpec, wanted)) {
      if (!wanted.has(name)) continue;
      for (const d of live) {
        const k = `${d.file}|${d.name}`;
        if (d.name !== name || pinned.has(k)) continue;
        if (resolvers.get(k)!(file, name)) pinned.add(k);
      }
    }
  }
  for (const d of live) {
    if (!pinned.has(`${d.file}|${d.name}`)) {
      out.push({ ...d, kind: "@decider no test imports" });
    }
  }
  return out.sort((a, b) =>
    a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1
  );
}

/** Resolve a test's import specifier to a repo-relative path: relative
 *  paths, and `deno.json`'s `imports` entries that point into the repo. */
export function specResolver(
  importMap: Record<string, string>,
): (from: string, spec: string) => string | null {
  return (from, spec) => {
    if (spec.startsWith(".")) return resolve(from, spec);
    const mapped = importMap[spec];
    if (mapped?.startsWith("./")) return mapped.slice(2);
    return null;
  };
}

async function* walkTests(dir: string): AsyncGenerator<string> {
  for await (const e of Deno.readDir(dir)) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory) yield* walkTests(p);
    else if (/\.test\.tsx?$/.test(e.name)) yield p;
  }
}

/** The whole `@decider` check against the repo at `root`. */
export async function checkDeciders(root: string): Promise<Offender[]> {
  const sources = await readSources(root);
  // Only a test whose TEXT names some decider can import one; the rest (the
  // vast majority) are never masked or indexed. A substring test is a
  // superset of every import form the parser credits, so it drops nothing.
  const names = [
    ...new Set(sources.flatMap((f) => taggedDeciders(f).map((d) => d.name))),
  ].filter(Boolean);
  const tests: File[] = [];
  for await (const p of walkTests(`${root}tests`)) {
    const text = await Deno.readTextFile(p);
    if (!names.some((n) => text.includes(n))) continue;
    tests.push(readFile(p.slice(root.length), text));
  }
  const dj = JSON.parse(await Deno.readTextFile(`${root}deno.json`)) as {
    imports?: Record<string, string>;
  };
  const cache = new Map<string, string | undefined>();
  const read = (p: string) => {
    const hit = _files.get(root + p);
    if (hit) return hit.src;
    if (!cache.has(p)) {
      try {
        cache.set(p, Deno.readTextFileSync(`${root}${p}`));
      } catch {
        cache.set(p, undefined); // aio-ok(silent-catch): an unresolvable specifier is simply not a route to the decider
      }
    }
    return cache.get(p);
  };
  return unpinnedDeciders(
    sources,
    tests,
    specResolver(dj.imports ?? {}),
    read,
  );
}

if (import.meta.main) {
  const root = new URL("../", import.meta.url).pathname;
  const all = await scan(root);
  const v = verdict(all, LEDGER);
  if (Deno.args.includes("--print-ledger")) {
    for (const o of all) console.log(`  ${JSON.stringify(key(o))},`);
    Deno.exit(0);
  }
  if (Deno.args.includes("--all")) {
    for (const o of all) {
      console.log(`${o.file}:${o.line}  ${o.kind} ${o.name}`);
    }
    console.log(`\n${all.length} offenders, ${LEDGER.length} on the ledger`);
  }
  const text = report(v);
  if (text) {
    console.error(text);
    Deno.exit(1);
  }
  const aliased = aliasedDeadImports(await readSources(root));
  if (aliased.length) {
    console.error(
      `\n${aliased.length} \`_\`-aliased import(s) that nothing uses — the ` +
        `alias is what silences \`no-unused-vars\`, so these look deliberate ` +
        `and are dead:\n` +
        aliased.map((o) => `  ${o.file}:${o.line}  ${o.name}`).join("\n") +
        `\n\nWire it, or delete the import.`,
    );
    Deno.exit(1);
  }
  const unpinned = await checkDeciders(root);
  // check:persist-decider rides along here so the pre-test ratchet reads and
  // masks src/ ONCE (its own CLI stays for running it alone).
  const persist = persistCheck(
    (await readSources(root)).filter((f) => f.path.startsWith("src/")),
  );
  if (persist.length) {
    console.error(
      `\ncheck:persist-decider — cell state can reach a store around ` +
        `src/state/cell-persist-filter.ts:\n` + persistReport(persist),
    );
    Deno.exit(1);
  }
  if (unpinned.length) {
    console.error(
      `\n${unpinned.length} \`@decider\` function(s) no test holds still:\n` +
        unpinned.map((o) => `  ${o.file}:${o.line}  ${o.name}  (${o.kind})`)
          .join("\n") +
        `\n\nA function tagged \`@decider\` claims a whole behaviour flows ` +
        `through it. Import it from a tests/*.test.ts and pin that behaviour ` +
        `(export it first if it is not), or drop the tag.`,
    );
    Deno.exit(1);
  }
  console.log(
    `check:dead-wiring — clean. ${all.length} known unwired export${
      all.length === 1 ? "" : "s"
    } on the ledger, no new ones.`,
  );
}
