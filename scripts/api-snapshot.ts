#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run
// api-snapshot.ts — mechanical no-accidental-breaking gate (roadmap A2).
//
// Snapshots the public API surface of every deno.json export entry via
// `deno doc --json`, normalized to a compact, reviewable JSON file:
// per symbol: name, kind, @experimental flag, and a SHA-256 digest of the
// normalized declarations (params, return types, type params, members) —
// so *any* signature change flips the digest, not just adds/removes.
//
// Rules enforced beyond the diff:
// - symbols tagged `@internal` are excluded from the surface;
// - a `_`-prefixed export that is NOT tagged `@internal` fails the gate
//   (audit rule: `_` names are never public surface).
//
// Usage:
//   deno task update:api   — regenerate docs/api-snapshot.json (deliberate)
//   deno task check:api    — diff current surface vs snapshot; exit 1 on drift

const SNAPSHOT_PATH = new URL("../docs/api-snapshot.json", import.meta.url);
const ROOT = new URL("../", import.meta.url);

type SymbolEntry = { kind: string; sig: string; experimental?: true };
type EntrySnapshot = {
  experimental?: true;
  symbols: Record<string, SymbolEntry>;
};
type Snapshot = {
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
      const sig = await sha256Hex(
        JSON.stringify(normalize(decls.map((d) => ({
          kind: d.kind,
          def: d.def,
        })))),
      );
      symbolEntries[sym.name] = {
        kind: kinds.join("+"),
        sig,
        ...(experimental ? { experimental: true as const } : {}),
      };
    }

    entries[entry] = {
      ...(entryExperimental ? { experimental: true as const } : {}),
      symbols: Object.fromEntries(
        Object.entries(symbolEntries).sort(([a], [b]) => a.localeCompare(b)),
      ),
    };
  }

  return {
    snapshot: {
      $comment:
        "Public API surface lock (roadmap A2). Regenerate DELIBERATELY with `deno task update:api` — any diff here is a surface change and must be intentional. sig = digest of the normalized declaration; a changed sig means the symbol's signature changed.",
      entries,
    },
    violations,
  };
}

// ── Diff ─────────────────────────────────────────────────────────────

function diffSnapshots(committed: Snapshot, current: Snapshot): string[] {
  const lines: string[] = [];
  const allEntries = new Set([
    ...Object.keys(committed.entries),
    ...Object.keys(current.entries),
  ]);
  for (const entry of [...allEntries].sort()) {
    const a = committed.entries[entry];
    const b = current.entries[entry];
    if (!a) {
      lines.push(`+ entry ${entry} (new export entry)`);
      continue;
    }
    if (!b) {
      lines.push(`- entry ${entry} (export entry removed)`);
      continue;
    }
    if (!!a.experimental !== !!b.experimental) {
      lines.push(
        `~ entry ${entry}: @experimental ${
          a.experimental ? "removed" : "added"
        }`,
      );
    }
    const names = new Set([
      ...Object.keys(a.symbols),
      ...Object.keys(b.symbols),
    ]);
    for (const name of [...names].sort()) {
      const sa = a.symbols[name];
      const sb = b.symbols[name];
      if (!sa) lines.push(`+ ${entry} › ${name} (${sb!.kind}) added`);
      else if (!sb) lines.push(`- ${entry} › ${name} (${sa.kind}) removed`);
      else if (sa.sig !== sb.sig || sa.kind !== sb.kind) {
        lines.push(`~ ${entry} › ${name} signature changed`);
      } else if (!!sa.experimental !== !!sb.experimental) {
        lines.push(
          `~ ${entry} › ${name}: @experimental ${
            sa.experimental ? "removed" : "added"
          }`,
        );
      }
    }
  }
  return lines;
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
    console.error(
      `✗ public API surface drifted from the committed snapshot (${diff.length} change${
        diff.length === 1 ? "" : "s"
      }):\n`,
    );
    for (const line of diff) console.error(`  ${line}`);
    console.error(
      "\nIf this change is intentional, regenerate with `deno task update:api`, review the diff, and commit it.",
    );
    Deno.exit(1);
  }
  console.log("✓ public API surface matches the committed snapshot");
}

if (import.meta.main) await main();
