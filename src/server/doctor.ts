/**
 * @module
 * aio doctor — config sanity checks for the magic deno.json lines (AIO-8.3).
 * Run `deno task doctor` (wired in every scaffold), or explicitly
 * `deno run -A dep/aio/src/server/doctor.ts [dir]` (vendored) /
 * `jsr:@riagentic/aio/doctor` (once published). Each check prints PASS/FAIL
 * with a one-line fix; exits 1 on any failure.
 */
import { meetsMinDeno, MIN_DENO } from "./deno-version.ts";
import { VERSION } from "./aio-cli.ts";
import { buildContext } from "../../aiol/context.ts";
import {
  checkCells,
  checkImports,
  checkPersistence,
  checkUI,
  checkWorkerPeerReads,
} from "../../aiol/checks.ts";
import { manifestReport, scanCapabilities } from "../build/capabilities.ts";

/** One doctor check — a named config assertion with a one-line fix on failure. */
interface Check {
  name: string;
  ok: boolean;
  fix: string;
}

/** Code-integrity sweep: the "green-tests-dead-feature /
 *  silent-corruption" class — reserved cell keys, duplicate imports, orphaned
 *  persistence, and the client/server boundary (a field report #1 defect d: a
 *  server-only import — `@std/`, `node:`, `aio/server`, `createDB`, `Deno.*` —
 *  reaching a browser-bundle module). Reuses aiol's error-level checks so
 *  there's ONE source of truth, surfaced here as doctor FAILs. Best-effort:
 *  never crashes the config doctor. */
async function integritySweep(dir: string): Promise<Check[]> {
  let ctx, report;
  try {
    ({ ctx, report } = await buildContext(dir));
    for (
      const check of [
        checkCells,
        checkImports,
        checkPersistence,
        checkUI,
        // A worker cell reading a peer cell can only ever read staleness —
        // the runtime throws when that line executes, doctor says it first.
        checkWorkerPeerReads,
      ]
    ) {
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

/** Least-privilege capability manifest for the project — the
 *  `--allow-*` set the source actually needs, instead of `-A`. Informational. */
async function capabilityManifest(dir: string): Promise<string | null> {
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

/** Pull the pinned aio version out of an import-map spec, or null. Handles
 *  `jsr:@riagentic/aio@^1.0.0-alpha33`, `npm:…@1.2.3`, bare `…/aio@1.2.3`.
 *  A vendored path (`./`, `../`) or an unpinned spec has no version → null. */
export function extractAioVersion(spec: string): string | null {
  const m = spec.match(/\baio@[~^>=<]*([0-9][^\s"'/]*)/);
  return m ? m[1]! : null;
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

  // Framework version pin. A source-layout app imports aio through a gitignored
  // `dep/aio` symlink, so without `aioVersion` in deno.json a clone of this repo
  // builds against whatever aio the machine happens to have — and "it compiled
  // last month" stops being reproducible. Self-contained on purpose: doctor lives
  // in server/, which may not import am/ (see scripts/check-boundaries.ts).
  const usesDepAio = Object.values(cfg.imports ?? {}).some((v) =>
    typeof v === "string" && v.includes("dep/aio")
  );
  if (usesDepAio) {
    const pin = typeof (cfg as { aioVersion?: unknown }).aioVersion === "string"
      ? (cfg as { aioVersion: string }).aioVersion
      : null;
    checks.push({
      name: "framework pin (deno.json aioVersion)",
      ok: pin !== null,
      fix: "run `am pin --latest` and commit deno.json — otherwise a clone " +
        "builds against whatever aio is installed",
    });
    if (pin) {
      let linked: string | null = null;
      try {
        const target = await Deno.readLink(`${dir}/dep/aio`);
        linked = target.split("/").filter(Boolean).pop() ?? null;
      } catch { /* not linked yet — `am fix` handles that */ }
      checks.push({
        name: `framework pin matches dep/aio (${pin})`,
        // Unlinked is not drift; it's a fresh clone, and `am fix` is the answer.
        ok: linked === null || linked === pin,
        fix: `dep/aio points at ${linked}, not ${pin} — run \`am fix\``,
      });
    }
  }

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

  // aio version drift — the app's import-map pin vs the framework
  // actually running (this doctor's VERSION). Informational, never fails: a
  // pin behind the running build isn't broken, but behavior may have changed,
  // so point at the upgrade guide. A stale pin is how an app silently rots
  // against a fast-moving dep.
  const pinned = extractAioVersion(aioTarget);
  checks.push({
    name: pinned && pinned !== VERSION
      ? `aio version — app pins ${pinned}, running ${VERSION} · review docs/upgrade if you skipped releases`
      : `aio version ${VERSION}`,
    ok: true, // advisory only
    fix: "",
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
