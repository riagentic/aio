#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run
// api-snapshot.ts — mechanical no-accidental-breaking gate (roadmap A2).
//
// Snapshots the public API surface of every deno.json export entry via
// `deno doc --json`, normalized to a compact, reviewable JSON file:
// per symbol: name, kind, @experimental flag, a SHA-256 digest of the
// normalized declarations (params, return types, type params, members) —
// so *any* signature change flips the digest, not just adds/removes — and
// per-MEMBER digests, which are what let the gate tell an added optional
// config key (additive) from a renamed one (breaking). Without them both
// printed "signature changed / BREAKING", so the alarm was usually noise and
// the way past it — regenerating — is the one move that erases the record.
//
// From the first beta the surface is frozen until 1.0, and `update:api`
// refuses to absorb a breaking diff without `--allow-break="<why>"`.
//
// Rules enforced beyond the diff:
// - symbols tagged `@internal` are excluded from the surface;
// - a `_`-prefixed export that is NOT tagged `@internal` fails the gate
//   (audit rule: `_` names are never public surface).
//
// Usage:
//   deno task update:api   — regenerate docs/api-snapshot.json (deliberate)
//   deno task check:api    — diff current surface vs snapshot; exit 1 on drift

import {
  BUILD_BOOL_FLAGS,
  BUILD_VALUE_FLAGS,
  FLEET_BOOL_FLAGS,
  FLEET_VALUE_FLAGS,
  SHIP_BOOL_FLAGS,
  SHIP_VALUE_FLAGS,
} from "../src/build/build-flags.ts";
import { HELP_TEXT } from "../src/am/am-help-text.ts";
import { AIO_RUNTIME_FLAG_SPECS } from "../src/diagnostics/runtime-flags.ts";

const SNAPSHOT_PATH = new URL("../docs/api-snapshot.json", import.meta.url);
const ROOT = new URL("../", import.meta.url);

/** The synthetic entry holding the COMMAND-LINE surface.
 *
 *  A flag spelling is a promise exactly like an exported symbol: an app's
 *  `deno.json` tasks, a Dockerfile, a systemd unit and a CI job all name
 *  flags, and none of them type-check. `deno doc` cannot see any of it, so
 *  before this entry existed the only guard was a test asserting each flag was
 *  DOCUMENTED — which stays green when a flag is renamed in both places at
 *  once. Snapshotting the spellings puts them under the same additive-only
 *  policy, and under the same beta freeze, as the types. */
const CLI_ENTRY = "(cli)";

type SymbolEntry = {
  kind: string;
  /** Digest of the normalized declaration, or {@link UNPINNED} when `deno doc`
   *  describes the symbol as an opaque const and no alias target explains it. */
  sig: string;
  experimental?: true;
  /** This symbol IS another one under a second name: it carries that
   *  symbol's signature, so the two can never drift apart silently. */
  alias?: string;
  /** Per-MEMBER digests, when the declaration has members that can be named
   *  one by one: an object type's properties, an interface's or class's
   *  members, a function's parameters (keyed by POSITION, since TypeScript
   *  binds them positionally and a rename is not a break) and its return.
   *
   *  Without this the gate held one digest for the whole declaration, so
   *  ADDING an optional config key and RENAMING one produced the identical
   *  verdict — "signature changed", BREAKING. Every routine addition made the
   *  gate cry wolf, and the only way past it was `update:api`, which erases
   *  the record of what changed. A freeze that beta has to hold until 1.0
   *  cannot rest on an instrument whose alarm is usually noise.
   *
   *  Value is `"opt:<digest>"` or `"req:<digest>"` — optionality is part of
   *  the promise, not part of the type. */
  members?: Record<string, string>;
};
/** One line of API drift, and whether it BREAKS a caller.
 *
 *  The gate used to print every change with one verdict — "regenerate, review,
 *  commit" — so a removed export and a new one read identically, and the
 *  additive-only policy (the post-alpha70 insurance, and the standing rule
 *  that a compat break needs explicit approval) rested on a human spotting
 *  which lines were which in an undifferentiated list. */
type ApiChange = { line: string; breaking: boolean; experimental: boolean };
type EntrySnapshot = {
  experimental?: true;
  symbols: Record<string, SymbolEntry>;
};
export type Snapshot = {
  $comment: string;
  entries: Record<string, EntrySnapshot>;
};

// ── Normalization ────────────────────────────────────────────────────

/** Recursively strip machine/doc-text noise so digests are stable. */
function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (
      const key of Object.keys(value as Record<string, unknown>).sort()
    ) {
      // location: absolute file paths + line/col churn; jsDoc: prose churn.
      if (key === "location" || key === "jsDoc") continue;
      out[key] = normalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

// deno-lint-ignore no-explicit-any
type DocDeclaration = Record<string, any>;
// deno-lint-ignore no-explicit-any
type DocSymbol =
  & { name: string; declarations: DocDeclaration[] }
  & Record<
    string,
    // deno-lint-ignore no-explicit-any
    any
  >;

function hasTag(decl: DocDeclaration, tag: string): boolean {
  const tags = decl.jsDoc?.tags as { kind: string }[] | undefined;
  return tags?.some((t) => t.kind === tag) ?? false;
}

/** The digest a symbol carries when nothing about it can be pinned.
 *
 *  `deno doc` describes some `export const` declarations as bare
 *  `{"kind":"const"}` — no type, no value. Digesting THAT produced one
 *  identical hash for every such symbol (`1588a0f075829371`, shared by ten
 *  public exports), which reads in the snapshot exactly like a real
 *  signature: `jsxs` looked pinned for a year while a change to `jsx()`'s
 *  signature could not have been caught through it. A marker that says
 *  "unpinned" cannot be mistaken for one that says "unchanged". */
const UNPINNED = "unpinned";

/** The hash the OLD code produced for that same "nothing to describe" state.
 *  Every opaque symbol shared it, so a snapshot committed before this marker
 *  existed carries it — and a symbol moving from that hash to a real
 *  signature is the gate gaining sight, not a caller-visible break. */
const LEGACY_UNPINNED_SIG = "1588a0f075829371";

/** Does `sig` mean "this symbol was never pinned"? */
export function isUnpinnedSig(sig: string): boolean {
  return sig === UNPINNED || sig === LEGACY_UNPINNED_SIG;
}

/** Did `deno doc` describe this symbol at all? An opaque declaration is a
 *  `variable` whose `def` carries nothing but its own `kind`. */
function isOpaque(decls: DocDeclaration[]): boolean {
  return decls.length > 0 && decls.every((d) => {
    if (d.kind !== "variable") return false;
    const def = (d.def ?? {}) as Record<string, unknown>;
    return Object.keys(def).filter((k) => k !== "kind").length === 0;
  });
}

/** `export const jsxs = jsx;` → `"jsx"`. Null when the initializer is not a
 *  bare identifier (a real value — `Fragment = Symbol(…)` — is not an alias).
 *
 *  An ALIAS is the same function under a second name, so it must carry the
 *  same signature and change with it. Which shape `deno doc` reports for one
 *  has already flipped once between deno versions (2.9.6 started emitting the
 *  target's full declarations where earlier versions emitted an opaque
 *  const), so the snapshot resolves it itself rather than inheriting that
 *  churn as a "BREAKING" surface change. */
export function aliasTarget(source: string, name: string): string | null {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(
    `(?:^|\\n)\\s*(?:export\\s+)?(?:const|let|var)\\s+${esc}\\s*(?::[^=\\n]+)?=\\s*([A-Za-z_$][\\w$]*)\\s*;`,
  ).exec(source);
  return m ? m[1]! : null;
}

/** The file a symbol is declared in, or null. */
function declFile(decls: DocDeclaration[]): string | null {
  for (const d of decls) {
    const f = (d.location as { filename?: string } | undefined)?.filename;
    if (typeof f === "string" && f.startsWith("file://")) return f;
  }
  return null;
}

/** The digest of one member, with its own name and optionality removed —
 *  those are carried by the map KEY and the `opt:`/`req:` prefix, so a member
 *  that merely became optional does not read as a changed type. */
async function memberDigest(member: DocDeclaration): Promise<string> {
  const { name: _n, optional: _o, ...rest } = member as Record<string, unknown>;
  return await sha256Hex(JSON.stringify(normalize(rest)));
}

/** A short, human label for one type — what the diff line shows. Equality is
 *  decided by the digest beside it, never by this. */
function typeLabel(t: DocDeclaration | undefined): string {
  if (!t) return "?";
  const v = t.value as Record<string, unknown> | string | undefined;
  const raw = t.kind === "literal" && v && typeof v === "object"
    ? JSON.stringify((v as { string?: string }).string ?? v)
    : typeof t.repr === "string" && t.repr !== ""
    ? t.repr
    : String(t.kind ?? "?");
  // `~` and `+` are the part separators; a label must not carry them.
  return raw.replace(/[~+]/g, " ").slice(0, 32);
}

/** The branches of a union, or the type itself as a single branch.
 *
 *  A PARAMETER that gains a branch accepts strictly more than it did, so every
 *  existing call still type-checks — the one "signature changed" that is
 *  genuinely additive, and the one a config option grows by constantly
 *  (`theme: string` becoming `string | Theme`). Without this the gate reported
 *  it as BREAKING, and the only way past a failing gate is `update:api`, which
 *  erases the record. Each part is `<digest>~<label>`: compared by digest,
 *  printed by label. */
async function unionParts(t: DocDeclaration | undefined): Promise<string[]> {
  const branches = t?.kind === "union" && Array.isArray(t.value)
    ? t.value as DocDeclaration[]
    : t
    ? [t]
    : [];
  const parts = await Promise.all(
    branches.map(async (b) =>
      `${await sha256Hex(JSON.stringify(normalize(b)))}~${typeLabel(b)}`
    ),
  );
  return parts.sort();
}

/** The object-ish members of a `tsType`, following intersections (an
 *  `A & B` config type is its parts' keys) but NOT unions — one branch of a
 *  union does not promise the other's keys, so a union stays whole-digest. */
function objectMembers(tsType: DocDeclaration | undefined): DocDeclaration[] {
  if (!tsType) return [];
  if (tsType.kind === "typeLiteral") {
    return (tsType.value?.properties as DocDeclaration[] | undefined) ?? [];
  }
  if (tsType.kind === "intersection") {
    const parts = (tsType.intersection ?? tsType.types) as
      | DocDeclaration[]
      | undefined;
    if (!parts) return [];
    return parts.flatMap(objectMembers);
  }
  return [];
}

/** Per-member digests for one symbol, or `undefined` when its shape has no
 *  members the gate can name — a union, a mapped type, a bare alias. Those
 *  keep the whole-declaration digest and its blunt verdict, which is correct:
 *  nothing there can be pointed at as "the part that was added".
 *
 *  Overloaded functions are deliberately excluded: a change could belong to
 *  any overload, so naming one would be a guess. */
async function extractMembers(
  decls: DocDeclaration[],
): Promise<Record<string, string> | undefined> {
  if (decls.length !== 1) return undefined;
  const decl = decls[0]!;
  const def = (decl.def ?? {}) as DocDeclaration;
  const out: Record<string, string> = {};
  const put = async (
    key: string,
    optional: boolean,
    member: DocDeclaration,
  ): Promise<void> => {
    out[key] = `${optional ? "opt" : "req"}:${await memberDigest(member)}`;
  };

  if (decl.kind === "function") {
    const params = (def.params as DocDeclaration[] | undefined) ?? [];
    for (let i = 0; i < params.length; i++) {
      const p = params[i]!;
      // A rest param can always absorb more, so it is never "required".
      await put(`param${i}`, !!p.optional || p.kind === "rest", p);
      const parts = await unionParts(p.tsType as DocDeclaration | undefined);
      out[`param${i}`] += `|${parts.join("+")}`;
    }
    await put("return", false, { tsType: def.returnType });
    // A type parameter list is part of the call signature.
    if (def.typeParams) await put("typeParams", false, { t: def.typeParams });
    return out;
  }

  const props: DocDeclaration[] = [];
  if (decl.kind === "interface" || decl.kind === "class") {
    props.push(
      ...((def.properties as DocDeclaration[] | undefined) ?? []),
      ...((def.methods as DocDeclaration[] | undefined) ?? []),
    );
    if (def.constructors) {
      await put("constructor", false, { c: def.constructors });
    }
    if (def.extends) await put("extends", false, { e: def.extends });
  } else if (decl.kind === "typeAlias" || decl.kind === "variable") {
    props.push(...objectMembers(def.tsType as DocDeclaration | undefined));
    if (props.length === 0) return undefined;
    if (decl.kind === "typeAlias" && def.typeParams) {
      await put("typeParams", false, { t: def.typeParams });
    }
  } else {
    return undefined;
  }

  for (const m of props) {
    if (typeof m?.name !== "string") continue;
    await put(m.name, !!m.optional, m);
  }
  return out;
}

// ── Surface extraction ───────────────────────────────────────────────

async function docEntry(
  path: string,
): Promise<{ moduleDoc?: DocDeclaration; symbols: DocSymbol[] }> {
  const cmd = new Deno.Command(Deno.execPath(), {
    args: ["doc", "--json", path],
    cwd: ROOT.pathname,
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await cmd.output();
  if (code !== 0) {
    throw new Error(
      `deno doc --json ${path} failed:\n${new TextDecoder().decode(stderr)}`,
    );
  }
  const parsed = JSON.parse(new TextDecoder().decode(stdout)) as {
    nodes: Record<
      string,
      { module_doc?: DocDeclaration; symbols: DocSymbol[] }
    >;
  };
  const mod = Object.values(parsed.nodes)[0];
  if (!mod) throw new Error(`deno doc --json ${path}: no module node`);
  return { moduleDoc: mod.module_doc, symbols: mod.symbols ?? [] };
}

async function buildSnapshot(): Promise<{
  snapshot: Snapshot;
  violations: string[];
}> {
  const denoJson = JSON.parse(
    await Deno.readTextFile(new URL("deno.json", ROOT)),
  ) as { exports: Record<string, string> };

  const violations: string[] = [];
  const entries: Record<string, EntrySnapshot> = {};

  for (const [entry, path] of Object.entries(denoJson.exports).sort()) {
    const { moduleDoc, symbols } = await docEntry(path);
    const moduleTags = (moduleDoc?.tags as { kind: string }[] | undefined) ??
      [];
    const entryExperimental = moduleTags.some((t) => t.kind === "experimental");

    const symbolEntries: Record<string, SymbolEntry> = {};
    /** [name, declaring file] for every symbol `deno doc` could not describe
     *  — resolved against their alias targets in a second pass below. */
    const opaqueSymbols: [string, string][] = [];
    for (const sym of symbols) {
      const decls = sym.declarations ?? [];
      // `deno doc` also emits NON-exported local symbols that are merely
      // reachable from an exported type (e.g. a private `interface Common`
      // behind `export interface ButtonProps extends Common`). Those are not
      // importable, so they are not surface — skip symbols whose every
      // declaration is `declarationKind: "private"`. Deliberately NOT
      // `!== "export"`: if a future deno drops the field, nothing matches
      // "private" and the snapshot stays over-inclusive (visible in review)
      // instead of silently emptying the surface.
      if (
        decls.length > 0 &&
        decls.every((d) => d.declarationKind === "private")
      ) {
        continue;
      }
      const internal = decls.some((d) => hasTag(d, "internal"));
      if (internal) {
        continue; // excluded from the public surface by tag
      }
      if (sym.name.startsWith("_")) {
        violations.push(
          `${entry}: export "${sym.name}" is _-prefixed but not tagged @internal`,
        );
        continue;
      }
      const experimental = entryExperimental ||
        decls.some((d) => hasTag(d, "experimental"));
      const kinds = [...new Set(decls.map((d) => d.kind as string))].sort();
      const opaque = isOpaque(decls);
      const sig = opaque ? UNPINNED : await sha256Hex(
        JSON.stringify(normalize(decls.map((d) => ({
          kind: d.kind,
          def: d.def,
        })))),
      );
      const members = opaque ? undefined : await extractMembers(decls);
      symbolEntries[sym.name] = {
        kind: kinds.join("+"),
        sig,
        ...(experimental ? { experimental: true as const } : {}),
        ...(members && Object.keys(members).length ? { members } : {}),
      };
      if (opaque) {
        const file = declFile(decls);
        if (file) opaqueSymbols.push([sym.name, file]);
      }
    }

    // Second pass: an opaque symbol that is just another symbol under a
    // second name (`export const jsxs = jsx;`) inherits its target's
    // signature, so a change to the target is a change to BOTH. Only within
    // this entry — an alias whose target is not exported here is not surface
    // anyone can compare against.
    const sourceCache = new Map<string, string>();
    for (const [name, file] of opaqueSymbols) {
      let source = sourceCache.get(file);
      if (source === undefined) {
        try {
          source = await Deno.readTextFile(new URL(file));
        } catch {
          source = "";
        }
        sourceCache.set(file, source);
      }
      const target = aliasTarget(source, name);
      const to = target ? symbolEntries[target] : undefined;
      if (!target || !to || to.sig === UNPINNED) continue;
      symbolEntries[name] = {
        ...symbolEntries[name]!,
        kind: to.kind,
        sig: to.sig,
        alias: target,
        ...(to.members ? { members: to.members } : {}),
      };
    }

    entries[entry] = {
      ...(entryExperimental ? { experimental: true as const } : {}),
      symbols: Object.fromEntries(
        Object.entries(symbolEntries).sort(([a], [b]) => a.localeCompare(b)),
      ),
    };
  }

  const cli = cliSurface();
  if (Object.keys(cli).length < 60) {
    // A parse that silently came back short would quietly un-guard the whole
    // command line — the "verify the instrument" rule, applied to the gate.
    violations.push(
      `${CLI_ENTRY}: only ${
        Object.keys(cli).length
      } spellings parsed — the flag tables or \`am help\` changed shape`,
    );
  }
  entries[CLI_ENTRY] = { symbols: cli };

  return {
    snapshot: {
      $comment:
        'Public API surface lock (roadmap A2). Regenerate DELIBERATELY with `deno task update:api` — any diff here is a surface change and must be intentional. sig = digest of the normalized declaration; a changed sig means the symbol\'s signature changed. members = per-member digests (`opt:`/`req:` + hash), so ADDING an optional key reads as additive while removing or reshaping one reads as BREAKING; parameters are keyed by position. From the first beta the surface is frozen until 1.0 and `update:api` REFUSES a breaking diff without `--allow-break="<why>"`.',
      entries,
    },
    violations,
  };
}

// ── Diff ─────────────────────────────────────────────────────────────

/** Split `opt:abc` / `req:abc|<part>+<part>` into its pieces. The parts are
 *  present only for function parameters, where widening is unambiguous. */
function splitMember(
  v: string,
): { optional: boolean; digest: string; parts: string[] } {
  const i = v.indexOf(":");
  const rest = v.slice(i + 1);
  const bar = rest.indexOf("|");
  return {
    optional: v.slice(0, i) === "opt",
    digest: bar === -1 ? rest : rest.slice(0, bar),
    parts: bar === -1 ? [] : rest.slice(bar + 1).split("+").filter(Boolean),
  };
}

/** The label half of `<digest>~<label>`. */
const partLabel = (p: string) => p.slice(p.indexOf("~") + 1);

/** Name the parts of a changed declaration, and say which of them a caller
 *  can actually feel.
 *
 *  ADDING an optional member is the one change that breaks nobody: a caller
 *  passing the old shape still type-checks, and a caller reading the new
 *  shape gets a field it may ignore. Everything else — a removal, a rename
 *  (seen as one removal plus one addition), a changed type, an optional
 *  member becoming required, and a required one becoming optional (a reader
 *  could be relying on it being there) — is a break, and is reported as one.
 *
 *  Parameters are keyed by POSITION, which handles insertion for free: put a
 *  parameter in the middle and every position after it changes type, so the
 *  shift is reported as the several breaks it is. An ADDED position is
 *  therefore always the new last one — verified on `bindCell`, where inserting
 *  an optional second parameter reports two changed positions plus a required
 *  addition, not one harmless append.
 *
 *  Returns `null` when either side has no member map — an older snapshot, a
 *  union, an overload — so the caller falls back to the blunt whole-symbol
 *  verdict rather than guessing. */
export function diffMembers(
  entry: string,
  name: string,
  a: SymbolEntry,
  b: SymbolEntry,
): ApiChange[] | null {
  if (!a.members || !b.members) return null;
  const experimental = !!a.experimental;
  const at = (breaking: boolean, line: string): ApiChange => ({
    line: `${line}`,
    breaking: breaking && !experimental,
    experimental,
  });
  const out: ApiChange[] = [];
  const keys = [
    ...new Set([...Object.keys(a.members), ...Object.keys(b.members)]),
  ].sort();
  for (const key of keys) {
    const va = a.members[key];
    const vb = b.members[key];
    const where = `${entry} › ${name}.${key}`;
    if (va === vb) continue;
    if (va === undefined) {
      const { optional } = splitMember(vb!);
      out.push(
        optional ? at(false, `+ ${where} added (optional)`) : at(
          true,
          `+ ${where} added (REQUIRED — every existing caller must change)`,
        ),
      );
      continue;
    }
    if (vb === undefined) {
      out.push(at(true, `- ${where} removed`));
      continue;
    }
    const ma = splitMember(va), mb = splitMember(vb);
    if (ma.digest !== mb.digest) {
      // A parameter that still accepts every form it used to, plus more, is
      // additive: every existing call site still compiles. Only parameters —
      // for a property the same change is additive for something written and
      // breaking for something read, and the snapshot cannot tell which.
      const widened = ma.parts.length > 0 && mb.parts.length > 0 &&
        ma.parts.every((p) => mb.parts.includes(p));
      const added = mb.parts.filter((p) => !ma.parts.includes(p));
      out.push(
        widened
          ? at(
            false,
            `~ ${where} widened — it now also accepts ${
              added.map(partLabel).join(", ")
            }`,
          )
          : at(true, `~ ${where} type changed`),
      );
    }
    if (ma.optional !== mb.optional) {
      out.push(at(
        true,
        `~ ${where} became ${mb.optional ? "OPTIONAL" : "REQUIRED"}`,
      ));
    }
  }
  // The digest moved but no member explains it — the change is in a part the
  // member map does not cover. Say so rather than reporting a clean diff.
  if (out.length === 0) {
    out.push(at(true, `~ ${entry} › ${name} signature changed`));
  }
  return out;
}

export function diffSnapshots(
  committed: Snapshot,
  current: Snapshot,
): ApiChange[] {
  const lines: ApiChange[] = [];
  const add = (line: string, breaking: boolean, experimental = false): void => {
    lines.push({ line, breaking, experimental: !!experimental });
  };
  const allEntries = new Set([
    ...Object.keys(committed.entries),
    ...Object.keys(current.entries),
  ]);
  for (const entry of [...allEntries].sort()) {
    const a = committed.entries[entry];
    const b = current.entries[entry];
    if (!a) {
      add(`+ entry ${entry} (new export entry)`, false);
      continue;
    }
    if (!b) {
      add(`- entry ${entry} (export entry removed)`, true);
      continue;
    }
    if (!!a.experimental !== !!b.experimental) {
      // Dropping @experimental is a PROMOTION (the promise gets stronger).
      // Adding it to something that was stable withdraws a promise, which is
      // exactly the thing the additive-only policy exists to catch.
      add(
        `~ entry ${entry}: @experimental ${
          a.experimental ? "removed" : "added"
        }`,
        !a.experimental,
      );
    }
    const names = new Set([
      ...Object.keys(a.symbols),
      ...Object.keys(b.symbols),
    ]);
    for (const name of [...names].sort()) {
      const sa = a.symbols[name];
      const sb = b.symbols[name];
      if (!sa) add(`+ ${entry} › ${name} (${sb!.kind}) added`, false);
      // A symbol the committed snapshot marked @experimental carries no
      // stability promise — removing or reshaping it is the marker working,
      // not a break. That is the whole reason the marker exists.
      else if (!sb) {
        add(
          `- ${entry} › ${name} (${sa.kind}) removed`,
          !sa.experimental,
          sa.experimental,
        );
      } else if (
        // Two spellings of "never pinned" are the same non-promise.
        !(sa.sig === sb.sig ||
          (isUnpinnedSig(sa.sig) && isUnpinnedSig(sb.sig))) ||
        (sa.kind !== sb.kind && !isUnpinnedSig(sa.sig))
      ) {
        // A symbol that was never PINNED cannot have broken: the committed
        // side held no signature to compare against, only a placeholder.
        // Calling that "BREAKING" told the release to get a compat break
        // approved for a symbol whose promise had just been made stronger.
        const wasUnpinned = isUnpinnedSig(sa.sig);
        const nowUnpinned = isUnpinnedSig(sb.sig);
        if (wasUnpinned && !nowUnpinned) {
          add(
            `~ ${entry} › ${name} now carries a real signature${
              sb.alias ? ` (an alias of ${sb.alias})` : ""
            } — it was unpinned`,
            false,
          );
        } else if (nowUnpinned && !wasUnpinned) {
          // The other direction IS a loss: the gate stops watching a symbol
          // it used to watch.
          add(
            `~ ${entry} › ${name} became UNPINNED — deno doc no longer ` +
              `describes it, so the gate can no longer see it change`,
            !sa.experimental,
            sa.experimental,
          );
        } else {
          const detail = diffMembers(entry, name, sa, sb);
          if (detail) {
            for (const c of detail) lines.push(c);
          } else {
            add(
              `~ ${entry} › ${name} signature changed${
                sb.alias ? ` (an alias of ${sb.alias})` : ""
              }`,
              !sa.experimental,
              sa.experimental,
            );
          }
        }
      } else if (!!sa.experimental !== !!sb.experimental) {
        add(
          `~ ${entry} › ${name}: @experimental ${
            sa.experimental ? "removed" : "added"
          }`,
          !sa.experimental,
        );
      }
    }
  }
  return lines;
}

/** Which promise the current version carries.
 *
 *  Alpha may break with an approval, a registry row and an upgrade guide.
 *  From the FIRST beta the surface is frozen all the way to 1.0 — so a
 *  breaking diff must not be launderable by regenerating the snapshot, which
 *  is the one action a gate failure tempts everybody into. */
export function releaseChannel(version: string): "alpha" | "frozen" {
  return /-alpha/.test(version) ? "alpha" : "frozen";
}

/** The version this repo currently declares. */
async function declaredVersion(): Promise<string> {
  const { version } = JSON.parse(
    await Deno.readTextFile(new URL("deno.json", ROOT)),
  ) as { version?: string };
  return version ?? "";
}

/** The verbs `am help` lists: the first word of each two-space-indented entry
 *  line. Sub-words (`auth users`) belong to their verb; `help` is the help.
 *  ONE parser, shared with the docs gate — a second copy would be a second
 *  decider about what an `am` verb is. */
export function helpEntryVerbs(text: string): string[] {
  const verbs = new Set<string>();
  for (const m of text.matchAll(/^ {2}([a-z][\w-]*)/gm)) verbs.add(m[1]!);
  verbs.delete("help");
  return [...verbs];
}

/** Every command-line spelling a user can type, as snapshot symbols.
 *
 *  `sig` says what KIND of thing the spelling is, so turning a boolean flag
 *  into one that needs a value — which breaks every task line that passes it
 *  bare — reads as a changed signature rather than as nothing at all.
 *  Internal `--__aio-…` flags are the runtime's own and carry no promise. */
export function cliSurface(): Record<string, SymbolEntry> {
  const out: Record<string, SymbolEntry> = {};
  for (const spec of AIO_RUNTIME_FLAG_SPECS) {
    const bare = spec.replace(/=$/, "");
    if (bare.startsWith("--__")) continue;
    out[`aio ${bare}`] = {
      kind: "flag",
      sig: spec.endsWith("=") ? "value" : "bool",
    };
  }
  const buildFlags: [readonly string[], string][] = [
    [BUILD_BOOL_FLAGS, "bool"],
    [FLEET_BOOL_FLAGS, "bool"],
    [SHIP_BOOL_FLAGS, "bool"],
    [BUILD_VALUE_FLAGS, "value"],
    [FLEET_VALUE_FLAGS, "value"],
    [SHIP_VALUE_FLAGS, "value"],
  ];
  for (const [flags, sig] of buildFlags) {
    for (const f of flags) {
      const bare = f.replace(/=$/, "");
      if (bare.startsWith("--__")) continue;
      out[`build ${bare}`] = { kind: "flag", sig };
    }
  }
  for (const verb of helpEntryVerbs(HELP_TEXT)) {
    out[`am ${verb}`] = { kind: "verb", sig: "verb" };
  }
  return Object.fromEntries(
    Object.entries(out).sort(([a], [b]) => a.localeCompare(b)),
  );
}

// ── Main ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const check = Deno.args.includes("--check");
  const { snapshot, violations } = await buildSnapshot();

  if (violations.length) {
    console.error("✗ audit-rule violations (fix before snapshotting):");
    for (const v of violations) console.error(`  ${v}`);
    Deno.exit(1);
  }

  const rendered = JSON.stringify(snapshot, null, 2) + "\n";

  if (!check) {
    // A regeneration is the one move that ERASES the record of a break, so it
    // is the move the freeze has to guard. From the first beta on, refuse it
    // when the diff breaks a caller unless the person running it says so in
    // words — which then shows up in the commit that carries the reason.
    const version = await declaredVersion();
    if (releaseChannel(version) === "frozen") {
      const reason = Deno.args
        .find((a) => a.startsWith("--allow-break="))
        ?.slice("--allow-break=".length)
        .trim();
      let committedNow: Snapshot | null = null;
      try {
        committedNow = JSON.parse(
          await Deno.readTextFile(SNAPSHOT_PATH),
        ) as Snapshot;
      } catch {
        committedNow = null;
      }
      const breaks = committedNow
        ? diffSnapshots(committedNow, snapshot).filter((c) => c.breaking)
        : [];
      if (breaks.length && !reason) {
        console.error(
          `✗ ${version} is FROZEN — the public surface is promised until 1.0, ` +
            `and this regeneration would quietly absorb ${breaks.length} ` +
            `breaking change${breaks.length === 1 ? "" : "s"}:\n`,
        );
        for (const c of breaks) console.error(`    ${c.line}`);
        console.error(
          "\nMake it additive instead: add the new spelling beside the old " +
            "one and leave the old one working.\nIf the break is genuinely " +
            "unavoidable, it needs a decision, not a regeneration:\n  deno " +
            'task update:api -- --allow-break="<why, in one line>"\nand that ' +
            "line belongs in the commit message, CHANGELOG.md and an upgrade " +
            "guide.",
        );
        Deno.exit(1);
      }
      if (breaks.length && reason) {
        console.error(
          `⚠ ${version} is frozen and this absorbs ${breaks.length} breaking ` +
            `change${
              breaks.length === 1 ? "" : "s"
            }, allowed because: ${reason}`,
        );
        for (const c of breaks) console.error(`    ${c.line}`);
      }
    }
    await Deno.writeTextFile(SNAPSHOT_PATH, rendered);
    const total = Object.values(snapshot.entries)
      .reduce((n, e) => n + Object.keys(e.symbols).length, 0);
    console.log(
      `✓ wrote ${SNAPSHOT_PATH.pathname} — ${
        Object.keys(snapshot.entries).length
      } entries, ${total} public symbols`,
    );
    return;
  }

  let committed: Snapshot;
  try {
    committed = JSON.parse(await Deno.readTextFile(SNAPSHOT_PATH)) as Snapshot;
  } catch {
    console.error(
      `✗ no committed snapshot at ${SNAPSHOT_PATH.pathname} — run \`deno task update:api\` and commit it`,
    );
    Deno.exit(1);
  }

  const diff = diffSnapshots(committed, snapshot);
  if (diff.length) {
    const breaking = diff.filter((c) => c.breaking);
    const additive = diff.filter((c) => !c.breaking);
    console.error(
      `✗ public API surface drifted from the committed snapshot (${diff.length} change${
        diff.length === 1 ? "" : "s"
      }):\n`,
    );
    // Breaking FIRST and named as such. Everything below is additive, which
    // the policy allows; everything here needs a decision from a person.
    if (breaking.length) {
      console.error(
        `  BREAKING — ${breaking.length} change${
          breaking.length === 1 ? "" : "s"
        } a caller can feel:`,
      );
      for (const c of breaking) console.error(`    ${c.line}`);
      console.error("");
    }
    if (additive.length) {
      console.error(
        `  additive — ${additive.length} (the policy allows these):`,
      );
      for (const c of additive) {
        console.error(
          `    ${c.line}${
            c.experimental ? "  [@experimental — no promise]" : ""
          }`,
        );
      }
      console.error("");
    }
    console.error(
      breaking.length
        ? "This removes or reshapes public surface. aio is additive-only since " +
          "alpha70: a compat break is a DECISION, not a regeneration. Get it " +
          "approved, write the upgrade guide and the removals registry row, " +
          "THEN `deno task update:api`.\n" +
          "Nothing to break? Mark the symbol `@experimental` and it carries no " +
          "promise — the snapshot already tracks that per symbol."
        : "Additive only. Regenerate with `deno task update:api`, review the " +
          "diff, and commit it.",
    );
    Deno.exit(1);
  }
  console.log("✓ public API surface matches the committed snapshot");
}

if (import.meta.main) await main();
