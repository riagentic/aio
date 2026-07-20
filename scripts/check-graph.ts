// check-graph.ts — one-shot, exit-code client-graph validator (risoto 2026-07-20f).
//
// The dev server already walks the client-bound module graph and blocks on
// guaranteed browser breaks (a `node:` builtin or an omitted `aio` server
// symbol like `createDB` statically imported into a client-reachable module).
// This wraps the SAME `validateGraph` in a CLI so CI — `deno test`, a pre-push
// hook — catches those breaks too, not only a running dev server.
//
//   deno task check:graph                 # validates ./App.tsx
//   deno run -A <aio>/scripts/check-graph.ts --entry src/ui/App.tsx
//
// Exits 1 on any BLOCKING error (client would blank-screen), 0 otherwise.
// Warnings (conditional `Deno.*` usage, maybe-safe `@std/*`) print but pass.

import { join, resolve } from "@std/path";
import { validateGraph } from "../src/server/graph-validator.ts";
import { transpile } from "../src/server/server-transpile.ts";
import { buildBrowserImportMap } from "../src/server/server-html-importmap.ts";
import { hasVendorImmer } from "../src/server/server-vendor.ts";

function arg(name: string, fallback: string): string {
  const hit = Deno.args.find((a) => a.startsWith(`--${name}=`)) ??
    (Deno.args.includes(`--${name}`)
      ? Deno.args[Deno.args.indexOf(`--${name}`) + 1]
      : undefined);
  return hit?.includes("=") ? hit.split("=").slice(1).join("=") : (hit ?? fallback);
}

function fileExists(path: string): boolean {
  try {
    Deno.statSync(path);
    return true;
  } catch {
    return false;
  }
}

const cwd = Deno.cwd();
const entry = resolve(cwd, arg("entry", "App.tsx"));

// Import map from the app's deno.json (same source the dev server reads).
let denoImports: Record<string, string> = {};
try {
  denoImports = JSON.parse(Deno.readTextFileSync(join(cwd, "deno.json"))).imports ??
    {};
} catch { /* no/invalid deno.json — defaults suffice */ }
const importMap = buildBrowserImportMap(denoImports, {
  vendorImmer: hasVendorImmer(),
});

if (!fileExists(entry)) {
  // No UI entry = a server-only/CLI app; nothing client-bound to validate.
  console.log(
    `check:graph — no UI entry at ${entry} (server-only/CLI app?); nothing to validate.`,
  );
  Deno.exit(0);
}

const result = await validateGraph(entry, importMap, (s, f) => transpile(s, f));

// server-only-import is a guaranteed client break → blocking (non-zero exit).
// server-only-api (conditional Deno.* / maybe-safe @std) + circular = warnings.
const isWarning = (c: string) =>
  c === "server-only-api" || c === "circular-dependency";
const blocking = result.errors.filter((e) => !isWarning(e.category));
const warnings = result.errors.filter((e) => isWarning(e.category));

const rel = (f: string) => f.startsWith(cwd) ? f.slice(cwd.length + 1) : f;
const fmt = (e: typeof result.errors[number]) =>
  `${rel(e.file)}${e.line ? `:${e.line}` : ""} — ${e.message}\n    fix: ${e.fix}`;

for (const e of warnings) console.warn(`⚠ [${e.category}] ${fmt(e)}`);
for (const e of blocking) console.error(`✗ [${e.category}] ${fmt(e)}`);

if (result.valid) {
  console.log(
    `✓ check:graph — ${result.modules.size} client-bound modules, no blocking breaks` +
      (warnings.length ? ` (${warnings.length} warning(s))` : "") +
      ` (${result.durationMs.toFixed(0)}ms)`,
  );
  Deno.exit(0);
}
console.error(
  `\n✗ check:graph — ${blocking.length} blocking break(s) would blank-screen the client at boot.`,
);
Deno.exit(1);
