/**
 * @module
 * aio doctor — config sanity checks for the magic deno.json lines (AIO-8.3).
 * Run `deno task doctor` (wired in every scaffold), or explicitly
 * `deno run -A dep/aio/src/server/doctor.ts [dir]` (vendored) /
 * `jsr:@riagentic/aio/doctor` (once published). Each check prints PASS/FAIL
 * with a one-line fix; exits 1 on any failure.
 */
import { meetsMinDeno, MIN_DENO } from "./deno-version.ts";
import { buildContext } from "../../aiol/context.ts";
import {
  checkCells,
  checkImports,
  checkPersistence,
  checkUI,
} from "../../aiol/checks.ts";
import { manifestReport, scanCapabilities } from "../build/capabilities.ts";

/** One doctor check — a named config assertion with a one-line fix on failure. */
interface Check {
  name: string;
  ok: boolean;
  fix: string;
}

/** Code-integrity sweep (risoto 2026-07-24 #3): the "green-tests-dead-feature /
 *  silent-corruption" class — reserved cell keys, duplicate imports, orphaned
 *  persistence, and the client/server boundary (risoto #1 defect d: a
 *  server-only import — `@std/`, `node:`, `aio/server`, `createDB`, `Deno.*` —
 *  reaching a browser-bundle module). Reuses aiol's error-level checks so
 *  there's ONE source of truth, surfaced here as doctor FAILs. Best-effort:
 *  never crashes the config doctor. */
async function integritySweep(dir: string): Promise<Check[]> {
  let ctx, report;
  try {
    ({ ctx, report } = await buildContext(dir));
    for (const check of [checkCells, checkImports, checkPersistence, checkUI]) {
      await check(ctx);
    }
  } catch (e) {
    return [{
      name: "code integrity sweep",
      ok: false,
      fix: `sweep could not run: ${e instanceof Error ? e.message : String(e)}`,
    }];
  }
  const errors = report.issues.filter((i) => i.severity === "error");
  if (errors.length === 0) {
    return [{
      name: "code integrity (cells · imports · persistence · boundary)",
      ok: true,
      fix: "",
    }];
  }
  return errors.map((e) => ({
    name: `integrity [${e.area}]${e.file ? ` ${e.file}` : ""}`,
    ok: false,
    fix: e.message,
  }));
}

/** Least-privilege capability manifest for the project (risoto #9) — the
 *  `--allow-*` set the source actually needs, instead of `-A`. Informational. */
export async function capabilityManifest(dir: string): Promise<string | null> {
  try {
    const { ctx } = await buildContext(dir);
    return manifestReport(scanCapabilities(ctx.sourceFiles));
  } catch {
    return null;
  }
}

interface DenoJson {
  compilerOptions?: { jsx?: string; jsxImportSource?: string };
  imports?: Record<string, string>;
  unstable?: string[];
  nodeModulesDir?: string | boolean;
}

/** Run all doctor checks against a directory containing deno.json. */
export async function runDoctor(
  dir = ".",
): Promise<{ checks: Check[]; ok: boolean }> {
  const checks: Check[] = [];
  let cfg: DenoJson | null = null;
  try {
    const raw = await Deno.readTextFile(`${dir}/deno.json`);
    cfg = JSON.parse(raw) as DenoJson;
  } catch {
    checks.push({
      name: "deno.json readable",
      ok: false,
      fix: `create ${dir}/deno.json — see quickstart`,
    });
    return { checks, ok: false };
  }
  checks.push({ name: "deno.json readable", ok: true, fix: "" });

  const co = cfg.compilerOptions ?? {};
  checks.push({
    name: 'compilerOptions.jsx === "react-jsx"',
    ok: co.jsx === "react-jsx",
    fix: 'set compilerOptions.jsx to "react-jsx"',
  });
  checks.push({
    name: 'compilerOptions.jsxImportSource === "aio"',
    ok: co.jsxImportSource === "aio",
    fix: 'set compilerOptions.jsxImportSource to "aio"',
  });

  const imports = cfg.imports ?? {};
  for (const key of ["aio", "aio/air", "aio/jsx-runtime"]) {
    checks.push({
      name: `import map has "${key}"`,
      ok: key in imports,
      fix: `add "${key}" to imports (jsr:@riagentic/aio or vendored path)`,
    });
  }

  // (aio is SQLite-only — Deno KV is no longer required; the old
  // `unstable: ["kv"]` check was removed. Deno.openKv is only touched as a
  // soft legacy-migration probe and degrades to a no-op without the flag.)

  // Electron needs nodeModulesDir
  const usesElectron = Object.values(imports).some((v) =>
    v.includes("electron")
  );
  if (usesElectron) {
    checks.push({
      name: "nodeModulesDir set (electron imported)",
      ok: cfg.nodeModulesDir === "auto" || cfg.nodeModulesDir === true,
      fix: 'set "nodeModulesDir": "auto" — electron needs node_modules on disk',
    });
  }

  // Vendored mode: aio maps to a relative path → immer + @std/path must be present
  const aioTarget = imports["aio"] ?? "";
  if (aioTarget.startsWith("./") || aioTarget.startsWith("../")) {
    for (const dep of ["immer", "@std/path"]) {
      checks.push({
        name: `vendored aio: "${dep}" in import map`,
        ok: dep in imports,
        fix: `add "${dep}" to imports — vendored aio resolves it from your map`,
      });
    }
  }

  // Deno version — aio's supported floor (uses ≥2.9 behavior directly)
  checks.push({
    name: `Deno ≥ ${MIN_DENO} (running ${Deno.version.deno})`,
    ok: meetsMinDeno(Deno.version.deno),
    fix: "upgrade: deno upgrade",
  });

  // Code-integrity sweep — structural problems no config check catches.
  checks.push(...await integritySweep(dir));

  return { checks, ok: checks.every((c) => c.ok) };
}

if (import.meta.main) {
  const dir = Deno.args[0] ?? ".";
  const { checks, ok } = await runDoctor(dir);
  let failed = 0;
  for (const c of checks) {
    if (c.ok) {
      console.log(`  PASS  ${c.name}`);
    } else {
      failed++;
      console.log(`  FAIL  ${c.name}\n        fix: ${c.fix}`);
    }
  }
  console.log(`\n${checks.length - failed} checks passed, ${failed} failed`);
  const manifest = await capabilityManifest(dir);
  if (manifest) console.log(`\n${manifest}`);
  if (!ok) Deno.exit(1);
}
