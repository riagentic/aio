/**
 * @module
 * Does the app's committed `deno.lock` describe aio's OWN tools?
 *
 * Field report (a desktop map app, §5): a committed lock was missing aio's dependency
 * entries (`jsr:@std/yaml@1.0.9`, `npm:react@19.1.0`, ranges like
 * `jsr:@std/path@^1.1.4` …). Nothing in the normal loop notices — `deno check
 * src/` and `deno test` never load the framework's build/am/lint modules — so
 * two clones of one commit could resolve aio's build and test tooling
 * differently, the very drift pinning `aioVersion` exists to prevent. The only
 * sign was a lock diff on someone else's machine.
 *
 * ONE list of what "aio's tools" are ({@linkcode aioToolEntries}), read by
 * both `am fix` (which caches it, so its advice is the repair) and
 * `deno task doctor` (which checks it). The check resolves that list against a
 * COPY of the lock in a temp dir and diffs: the app's lock is never written.
 */
import { join } from "@std/path";
import { resolveEntryPath } from "./paths.ts";

/** A framework module spec: this app's `dep/aio/…` source, or the published
 *  package. Anchored to a path segment — `vendor-dep/aio-core` is not aio. */
export function isFrameworkSpec(s: string): boolean {
  return /(^|\/)dep\/aio\//.test(s) || s.startsWith("jsr:@riagentic/aio");
}

/** THE entry points whose module graphs an app's lock must cover: the app's
 *  own entry (what `am fix` always cached), every framework module its tasks
 *  RUN (am, build-all, build spec, doctor, aiol, ship, installers — read from
 *  the app's own `tasks`, so a custom task set is covered as written), and the
 *  test harness its tests import (`aio/testing`). Pure; order-stable, deduped. */
export function aioToolEntries(
  cfg: Record<string, unknown> | null | undefined,
): string[] {
  const out = new Set<string>([resolveEntryPath(cfg)]);
  const tasks = (cfg?.tasks ?? {}) as Record<string, unknown>;
  for (const t of Object.values(tasks)) {
    const cmd = typeof t === "string"
      ? t
      : typeof (t as { command?: unknown })?.command === "string"
      ? (t as { command: string }).command
      : "";
    for (const raw of cmd.split(/\s+/)) {
      // `--build-spec=./dep/aio/src/build.ts` names a module too.
      const tok = raw.replace(/^--?[\w-]+=/, "").replace(/^["']|["']$/g, "");
      if (
        isFrameworkSpec(tok) &&
        (tok.startsWith("jsr:") || /\.(m?[jt]sx?)$/.test(tok))
      ) out.add(tok);
    }
  }
  const imports = (cfg?.imports ?? {}) as Record<string, unknown>;
  const testing = imports["aio/testing"];
  if (typeof testing === "string" && isFrameworkSpec(testing)) {
    out.add(testing);
  }
  return [...out];
}

/** The lock sections a module graph writes — `workspace` mirrors the config,
 *  not a graph, so it is not a coverage question. */
const GRAPH_SECTIONS = ["specifiers", "jsr", "npm", "remote", "redirects"];

/** Entries in `after` that `before` lacks, across the graph sections, spelled
 *  as the lock spells them. Pure. */
export function missingLockEntries(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): string[] {
  const out: string[] = [];
  for (const sec of GRAPH_SECTIONS) {
    const b = (before[sec] ?? {}) as Record<string, unknown>;
    const a = (after[sec] ?? {}) as Record<string, unknown>;
    for (const k of Object.keys(a)) if (!(k in b)) out.push(k);
  }
  return out;
}

/** The lock file the app's config names: `"lock": false` → none, a string or
 *  `{ path }` → that, else `deno.lock`. Pure. */
export function lockPathOf(
  cfg: Record<string, unknown> | null | undefined,
): string | null {
  const l = cfg?.lock;
  if (l === false) return null;
  if (typeof l === "string") return l;
  const p = (l as { path?: unknown } | undefined)?.path;
  return typeof p === "string" ? p : "deno.lock";
}

export type LockCoverage =
  | { status: "complete"; lock: string; entries: string[] }
  | { status: "missing"; lock: string; entries: string[]; missing: string[] }
  /** Not a verdict: no lock to check, or the graph could not be resolved
   *  (offline with an empty cache, a broken entry). Said, never passed off
   *  as "complete". */
  | { status: "skipped"; reason: string };

/** Resolve {@linkcode aioToolEntries} against a temp COPY of the app's lock
 *  and report what the lock lacks. Never writes inside `dir`: the lock is a
 *  copy, `node_modules`/`vendor` are switched off for the run, and the only
 *  thing touched is Deno's own global module cache — as `am fix` does. */
export async function checkLockCoverage(
  dir: string,
  cfg: Record<string, unknown> | null | undefined,
  timeoutMs = 120_000,
): Promise<LockCoverage> {
  const rel = lockPathOf(cfg);
  if (rel === null) return { status: "skipped", reason: `"lock": false` };
  const lockFile = join(dir, rel);
  let text: string;
  try {
    text = await Deno.readTextFile(lockFile);
  } catch {
    return { status: "skipped", reason: `no ${rel}` };
  }
  let before: Record<string, unknown>;
  try {
    before = JSON.parse(text);
  } catch (e) {
    return {
      status: "skipped",
      reason: `${rel} does not parse: ${e instanceof Error ? e.message : e}`,
    };
  }
  const appEntry = resolveEntryPath(cfg);
  const entries: string[] = [];
  for (const e of aioToolEntries(cfg)) {
    if (e.startsWith("jsr:") || !isMissingFile(join(dir, e))) entries.push(e);
    // An app without its own entry (a library, a cli with another layout)
    // has nothing there to cover. A FRAMEWORK file that is absent means
    // `dep/aio` is not linked — checking the rest would call a lock
    // "complete" against a graph that was never loaded.
    else if (e !== appEntry) {
      return {
        status: "skipped",
        reason: `${e} is not on disk (dep/aio not linked? run \`am fix\`)`,
      };
    }
  }
  const tmp = await Deno.makeTempDir({ prefix: "aio-lock-check-" });
  try {
    const copy = join(tmp, "deno.lock");
    await Deno.writeTextFile(copy, text);
    const r = await new Deno.Command(Deno.execPath(), {
      args: [
        "cache",
        `--lock=${copy}`,
        "--node-modules-dir=none",
        "--vendor=false",
        ...entries,
      ],
      cwd: dir,
      stdout: "null",
      stderr: "piped",
      env: { NO_COLOR: "1" },
      signal: AbortSignal.timeout(timeoutMs),
    }).output();
    if (!r.success) {
      const err = new TextDecoder().decode(r.stderr).trim().split("\n")
        .find((l) => /error/i.test(l)) ?? `exit ${r.code}`;
      return { status: "skipped", reason: `deno cache failed: ${err}` };
    }
    const missing = missingLockEntries(
      before,
      JSON.parse(await Deno.readTextFile(copy)),
    );
    return missing.length === 0
      ? { status: "complete", lock: rel, entries }
      : { status: "missing", lock: rel, entries, missing };
  } catch (e) {
    return {
      status: "skipped",
      reason: `could not run deno cache: ${
        e instanceof Error ? e.message : String(e)
      }`,
    };
  } finally {
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
  }
}

function isMissingFile(p: string): boolean {
  try {
    Deno.statSync(p);
    return false;
  } catch {
    return true;
  }
}
