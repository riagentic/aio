/**
 * @module
 * aio doctor — config sanity checks for the magic deno.json lines (AIO-8.3).
 * Run `deno task doctor` (wired in every scaffold), or explicitly
 * `deno run -A dep/aio/src/server/doctor.ts [dir]` (vendored) /
 * `jsr:@riagentic/aio/doctor` (once published). Each check prints PASS/FAIL
 * with a one-line fix; exits 1 on any failure.
 */
import { resolve } from "@std/path";
import { meetsMinDeno, MIN_DENO } from "./deno-version.ts";
import {
  linkSatisfiesPin,
  pinDisagreementHint,
  pinnedFrameworkPath,
} from "./framework-pin.ts";
import { VERSION } from "./aio-cli.ts";
import { LOCAL_PIN_FILE, readFrameworkPin } from "./deno-json.ts";
import { buildContext } from "../../aiol/context.ts";
import {
  checkCells,
  checkImports,
  checkPersistence,
  checkUI,
  checkWorkerPeerReads,
} from "../../aiol/checks.ts";
import { manifestReport, scanCapabilities } from "../build/capabilities.ts";
import { log } from "../diagnostics/logger-api.ts";

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
  /** Read to ask what this app actually DOES — a dependency only some apps
   *  need is checked only where its task exists. */
  tasks?: Record<string, string>;
}

/** Pull the pinned aio version out of an import-map spec, or null. Handles
 *  `jsr:@riagentic/aio@^1.0.0-alpha33`, `npm:…@1.2.3`, bare `…/aio@1.2.3`.
 *  A vendored path (`./`, `../`) or an unpinned spec has no version → null.
 *  @internal alpha70 — test seam via src/testing/internal.ts */
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
  // last month" stops being reproducible. doctor lives in server/, which may not
  // import am/ (see scripts/check-boundaries.ts) — so the pin/link rule lives in
  // server/framework-pin.ts and `am` imports it from there. Restating it here
  // instead is what made every local-dev (`path:`) pin fail forever.
  const usesDepAio = Object.values(cfg.imports ?? {}).some((v) =>
    typeof v === "string" && v.includes("dep/aio")
  );
  if (usesDepAio) {
    // `readFrameworkPin` is THE reader: `.aio/pin.local` (per-machine path
    // pin) first, then `aioVersion` — restating it here made a local
    // override invisible to doctor and red on a correct setup.
    const { pin, source } = await readFrameworkPin(dir);
    checks.push({
      name: `framework pin (${
        source === "local" ? LOCAL_PIN_FILE : "deno.json aioVersion"
      })`,
      ok: pin !== null,
      fix: "run `am pin --latest` and commit deno.json — otherwise a clone " +
        "builds against whatever aio is installed. Following a framework " +
        "CHECKOUT on this machine instead? That is a pin too: " +
        "`am pin path:/abs/path/to/aio` — the form that keeps doctor AND " +
        "aiol green at once",
    });
    if (pin) {
      let linked: string | null = null;
      try {
        // A relative link target is relative to the link's own directory.
        linked = resolve(`${dir}/dep`, await Deno.readLink(`${dir}/dep/aio`));
      } catch { /* not linked yet — `am fix` handles that */ }
      checks.push({
        name: `framework pin matches dep/aio (${pin})`,
        // Unlinked is not drift; it's a fresh clone, and `am fix` is the answer.
        // `linkSatisfiesPin` is THE decider (shared with `am pin`): restating
        // the rule here made a local-dev `path:` pin fail forever, with `am fix`
        // — which recreates that exact link — as the "fix".
        ok: linked === null || linkSatisfiesPin(pin, linked),
        // A CHECKOUT that is simply not under the version store is a choice,
        // not a defect — and "run `am fix`" is the one exit that throws the
        // choice away. `pinDisagreementHint` is THE decider for saying so, so
        // doctor and aiol cannot word it differently.
        fix: (linked !== null ? pinDisagreementHint(pin, linked) : null) ??
          `dep/aio points at ${linked}, not ${
            pinnedFrameworkPath(pin)
          } — run \`am fix\``,
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

  // Vendored mode: aio maps to a relative path, so AIO's OWN dependencies
  // resolve through the APP's import map. Miss one and the app type-checks
  // cleanly, then fails at boot, at build, or in `testUI` — which is where a
  // field report found the other two: `immer` and `@std/path` were listed here,
  // `esbuild` and `happy-dom` were not, and they were discovered one failure at
  // a time. Four now, and the two that are not needed by every app are asked
  // for only where they are used, so this cannot become a permanent red on an
  // app that has no build step or no UI (a report filed that class too).
  const aioTarget = imports["aio"] ?? "";
  if (aioTarget.startsWith("./") || aioTarget.startsWith("../")) {
    const tasks = Object.values(cfg.tasks ?? {}).join("\n");
    const builds = /build\.ts|build-all\.ts|--compile|compile:/.test(tasks);
    const tests = /deno test|\btest\b/.test(tasks);
    const vendored: Array<[string, boolean, string]> = [
      [
        "immer",
        true,
        "the state model itself — a cell cannot commit without it",
      ],
      ["@std/path", true, "used on every path aio resolves"],
      ["esbuild", builds, "the bundler `deno task build`/`compile` runs"],
      [
        "happy-dom",
        tests,
        "the DOM `testUI` renders into — without it UI tests fail at import",
      ],
    ];
    for (const [dep, needed, why] of vendored) {
      if (!needed) continue;
      checks.push({
        name: `vendored aio: "${dep}" in import map`,
        ok: dep in imports,
        fix: `add "${dep}" to imports — vendored aio resolves it from your ` +
          `map, and it is ${why}. \`am fix\` writes the whole set.`,
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
      log.info(`  PASS  ${c.name}`);
    } else {
      failed++;
      log.info(`  FAIL  ${c.name}\n        fix: ${c.fix}`);
    }
  }
  log.info(`\n${checks.length - failed} checks passed, ${failed} failed`);
  const manifest = await capabilityManifest(dir);
  if (manifest) log.info(`\n${manifest}`);
  if (!ok) Deno.exit(1);
}
