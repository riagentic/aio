/**
 * @module
 * aio doctor — config sanity checks for the magic deno.json lines (AIO-8.3).
 * Run `deno task doctor` (wired in every scaffold), or explicitly
 * `deno run -A dep/aio/src/server/doctor.ts [dir]` (vendored) /
 * `jsr:@riagentic/aio/doctor` (once published). Each check prints PASS/FAIL
 * with a one-line fix; exits 1 on any failure.
 */
import { meetsMinDeno, MIN_DENO } from "./deno-version.ts";

/** One doctor check — a named config assertion with a one-line fix on failure. */
interface Check {
  name: string;
  ok: boolean;
  fix: string;
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

  checks.push({
    name: 'unstable includes "kv"',
    ok: (cfg.unstable ?? []).includes("kv"),
    fix: 'add "unstable": ["kv"] — persistence needs Deno KV',
  });

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
  if (!ok) Deno.exit(1);
}
