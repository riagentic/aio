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

export type Offender = {
  file: string;
  line: number;
  name: string;
  kind: string;
};

/** `<file>|<name>` — deliberately line-free, so moving a declaration inside
 *  its file does not churn the ledger. */
export const key = (o: Offender): string => `${o.file}|${o.name}`;

// ─── source masking ────────────────────────────────────────────────────────
// Every scan below runs over a copy of the source in which comments and string
// literals have been replaced by spaces of the SAME length, so offsets still
// line up with the original. This is the whole point of the detector: a doc
// comment that NAMES a function is exactly the evidence that fooled everyone
// about `_noteDispatch`, and it must not count as a reference.
//
// It differs from `check-vacuous.ts`'s `mask` in one way, and the difference
// is load-bearing here: a template `${…}` hole is real CODE. Blanking it whole
// (right for a test file, where masking asks "is this structure?") loses
// `` `__set${capitalize(m)}` `` — 23 real call sites in src/, every one of
// which would have been reported as dead.

export function mask(src: string): string {
  const out = src.split("");
  const n = src.length;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < n; k++) if (out[k] !== "\n") out[k] = " ";
  };
  // Returns the index of the `}` that closed this level (or `n`).
  const scan = (start: number, stop: "}" | ""): number => {
    let i = start;
    while (i < n) {
      const c = src[i]!, d = src[i + 1];
      if (stop === "}" && c === "}") return i;
      if (c === "/" && d === "/") {
        const e = src.indexOf("\n", i);
        const end = e === -1 ? n : e;
        blank(i, end);
        i = end;
      } else if (c === "/" && d === "*") {
        const e = src.indexOf("*/", i + 2);
        const end = e === -1 ? n : e + 2;
        blank(i, end);
        i = end;
      } else if (c === '"' || c === "'") {
        let k = i + 1;
        while (k < n) {
          if (src[k] === "\\") k += 2;
          // A newline ends a quoted string in valid TS. Without this, an
          // apostrophe inside a regex character class blanks the rest of the
          // file and every reference in it disappears.
          else if (src[k] === c || src[k] === "\n") break;
          else k++;
        }
        blank(i + 1, k);
        i = Math.min(k + 1, n);
      } else if (c === "/" && _regexStart(src, i)) {
        // A REGEX LITERAL, skipped whole. Its CONTENTS can hold a backtick —
        // `/["'`]?/` in `src/db/reactive.ts` does — and the template branch
        // below would then read that backtick as an opener and blank forward
        // to the next one in the file, hiding every reference and declaration
        // between. Harmless there only by luck (the next backtick is two lines
        // away); the next such regex would take the rest of its file with it.
        // Quotes already stop at a newline for the same reason one line up.
        let k = i + 1;
        let inClass = false;
        while (k < n) {
          const ch = src[k]!;
          if (ch === "\\") {
            k += 2;
            continue;
          }
          if (ch === "\n") break; // unterminated — it was division after all
          if (inClass) {
            if (ch === "]") inClass = false;
          } else if (ch === "[") inClass = true;
          else if (ch === "/") break;
          k++;
        }
        blank(i + 1, k);
        i = Math.min(k + 1, n);
      } else if (c === "`") {
        let k = i + 1, text = i + 1;
        while (k < n) {
          if (src[k] === "\\") k += 2;
          else if (src[k] === "`") break;
          else if (src[k] === "$" && src[k + 1] === "{") {
            blank(text, k);
            k = scan(k + 2, "}");
            text = k + 1;
            k = text;
          } else k++;
        }
        blank(text, k);
        i = Math.min(k + 1, n);
      } else if (c === "{") {
        i = scan(i + 1, "}") + 1;
      } else i++;
    }
    return n;
  };
  scan(0, "");
  return out.join("");
}

const lineOf = (src: string, idx: number): number =>
  src.slice(0, idx).split("\n").length;

/** The acknowledgement marker, spelled the way the rest of the repo spells it
 *  (`scripts/check-vacuous.ts`, `scripts/check-silent-catch.ts`,
 *  `src/server/graph-validator.ts`). A bare `aio-ok` with nothing after it is
 *  not an acknowledgement, it is a mute button. */
const JUSTIFIED = /\baio-ok\b\s*[:\-—]\s*\S/;

/** Is the `/` at `i` a REGEX literal rather than division?
 *
 *  The same lookback `src/diagnostics/code-mask.ts` uses — this file keeps its
 *  own mask on purpose (that one counts `${…}` holes as template content,
 *  while this gate needs them as CODE, worth 23 false positives), so the
 *  heuristic is mirrored rather than shared. */
function _regexStart(src: string, i: number): boolean {
  for (let j = i - 1; j >= 0; j--) {
    const c = src[j]!;
    if (c === " " || c === "\t") continue;
    if (c === "\n" || c === "\r") return true; // line start = expression position
    // No `<`: `</div>` in a .tsx file is a closing tag, not a regex — with it
    // in the set, everything between two closing tags on one line vanished.
    return "([{,;:=!&|?+-*%~^>".includes(c);
  }
  return true; // start of file
}

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
  for (const p of paths) {
    by.set(p, readFile(p, await Deno.readTextFile(`${root}${p}`)));
  }

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
  "src/air/compat.ts|_resetHints",
  "src/air/dev-readonly-hint.ts|_resetReadOnlyHint",
  "src/air/renderer-flush.ts|_setFlushBudget",
  "src/air/time-travel-panel.ts|setSendFn",
  "src/air/ui-surface.ts|_resetForwardedHandles",
  "src/air/vdom-create.ts|_componentChainOf",
  "src/air/vdom-events.ts|_resetEventWarnings",
  "src/am/am-cmd-data.ts|_internals",
  "src/am/am-cmd-inspect.ts|_scope",
  "src/am/am-components.ts|componentsRoot",
  "src/am/am-http.ts|_resetInstanceVerify",
  "src/am/am-http.ts|verifyInstance",
  "src/am/am-utils.ts|writePid",
  "src/am/am-utils.ts|runTrojanPost",
  "src/am/am-versions.ts|removeVersion",
  "src/browser/browser-ack.ts|_setAckTimeoutMs",
  "src/browser/browser-ack.ts|_setAckGraceMs",
  "src/browser/browser-ack.ts|_isAckWritten",
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
  "src/server/aio-boot.ts|getSyncReplayContext",
  "src/server/aio-cli.ts|_resetParsedCli",
  "src/server/app-dirs.ts|ensureAppPayloadDir",
  "src/server/auth-oidc.ts|_resetOidcCaches",
  "src/server/auth-totp.ts|_resetTotpReplay",
  "src/server/blobs.ts|_resetBlobStores",
  "src/server/client-log.ts|_rateSlotCount",
  "src/server/config.ts|unknownBuildKeys",
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
  "src/state/method-cancel.ts|pendingCalls",
  "src/state/own.ts|_resetPendingFactories",
  "src/state/own.ts|_pendingFactoryCount",
  "src/state/removals.ts|REMOVED_CELL_KEYS",
  "src/state/signal.ts|_openScopeDepth",
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
  console.log(
    `check:dead-wiring — clean. ${all.length} known unwired export${
      all.length === 1 ? "" : "s"
    } on the ledger, no new ones.`,
  );
}
