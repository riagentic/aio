/**
 * @module
 * `am prune` — what the shared Electron runtime cache is holding, and what of
 * it can go.
 *
 * `~/.cache/aio/tools/electron` grows one ~250–370 MB directory per Electron
 * version+platform and has never lost one. The box this was written on held
 * **7.7 GB** across 32 entries, 41.2.1 through 44.4.2. Nothing was wrong with
 * any of them — the cache simply has no forgetting.
 *
 * It is also MACHINE-WIDE. Every aio app on the box starts from it, and the
 * app you happen to be standing in cannot know which Electron the app next
 * door needs: deleting a runtime an offline app starts from turns its next
 * launch into a 250 MB download it cannot make. So this is a verb you run, not
 * a thing that happens to you, and it is **report-only by default**:
 *
 *   am prune            list every entry, its size, when it was last used, and
 *                       whether it would go — and delete NOTHING
 *   am prune --yes      delete exactly the entries that listing named
 *
 * There is no form that deletes without having first printed what it would
 * delete, and `--yes` re-prints the plan before acting. The reasoning behind
 * the rules (and the three plausible ones that were rejected) is in
 * `build/electron-cache.ts`.
 */
import type { GlobalFlags } from "./am-types.ts";
import { detectMode, fail, out, outError, sayErr } from "./am-output.ts";
import { parseNumArg } from "./am-utils.ts";
import {
  applyElectronPrune,
  type CacheEntry,
  DEFAULT_ELECTRON_VERSION,
  electronCacheRoot,
  humanBytes,
  planElectronPrune,
  planSharedPrune,
  PRUNE_DEFAULT_MIN_AGE_DAYS,
  type PrunePlan,
  readElectronCache,
  type SharedPruneDecision,
} from "../build/electron-cache.ts";
import { resolve } from "@std/path";
import { instances } from "../server/single-instance-lock.ts";
import { repoRoot } from "./am-cmd-create.ts";
import { resolveAioRoot } from "./am-cmd-link.ts";
import {
  applyVersionPrune,
  currentLink,
  isPathPin,
  latestTag,
  planVersionPrune,
  provisioned,
  readPin,
  refOfLink,
  sortVersions,
  type VersionPruneDecision,
  versionsDir,
} from "./am-versions.ts";

/** The flags this verb reads, parsed out of its own argv. A bad value is a
 *  refusal, never a silent default — the number in `--days` decides whether
 *  250 MB stays or goes. */
export function parsePruneArgs(args: readonly string[]): {
  apply: boolean;
  days: number;
  keep: string[];
  error?: string;
} {
  let days = PRUNE_DEFAULT_MIN_AGE_DAYS;
  const keep: string[] = [];
  let apply = false;
  for (const a of args) {
    if (a === "--yes" || a === "-y") apply = true;
    else if (a.startsWith("--days=")) {
      // `parseNumArg`, not `Number(…)`: `Number("")` is 0, so `--days=` (a
      // script's empty variable) meant "no age floor" — every unprotected
      // runtime, however recently used, went with `--yes`.
      const n = parseNumArg(a.slice("--days=".length), "--days", {
        min: 0,
        integer: true,
      });
      if (!n.ok) return { apply, days, keep, error: n.error };
      days = n.value;
    } else if (a.startsWith("--keep=")) {
      for (const v of a.slice("--keep=".length).split(",")) {
        if (v.trim()) keep.push(v.trim());
      }
    } else {
      // Anything else is a typo, never "no argument": `am prune versoins
      // --yes` deleted Electron runtimes instead of version checkouts.
      return {
        apply,
        days,
        keep,
        error: `am prune: ${JSON.stringify(a)} is not an argument it ` +
          `takes — it takes --yes (-y), --days=N, --keep=a,b, or the ` +
          `subcommand \`versions\` first (\`am prune versions --yes\`)`,
      };
    }
  }
  return { apply, days, keep };
}

/** The plan, as a human reads it: name, size, and the SENTENCE that decided
 *  it. Three columns and no fourth — the age already lives inside the reason,
 *  and a column that repeats the next column is a column nobody reads. */
export function renderPrunePlan(plan: PrunePlan, _now: number): string {
  const lines: string[] = [];
  lines.push(`Electron runtime cache — ${electronCacheRoot()}`);
  lines.push(
    `${humanBytes(plan.total)} in ${
      plan.keep.length + plan.remove.length
    } entries. Shared by EVERY aio app on this machine.`,
  );
  lines.push("");
  const rows = [...plan.remove, ...plan.keep];
  const w = Math.max(4, ...rows.map((d) => d.entry.name.length));
  const s = Math.max(4, ...rows.map((d) => humanBytes(d.entry.bytes).length));
  const row = (d: { entry: CacheEntry; why: string }) =>
    `  ${d.entry.name.padEnd(w)}  ${
      humanBytes(d.entry.bytes).padStart(s)
    }  ${d.why}`;
  if (plan.remove.length) {
    lines.push(`WOULD REMOVE (${humanBytes(plan.freed)}):`);
    for (const d of plan.remove) lines.push(row(d));
    lines.push("");
  }
  lines.push(`KEEPING (${humanBytes(plan.total - plan.freed)}):`);
  for (const d of plan.keep) lines.push(row(d));
  lines.push("");
  if (plan.remove.length === 0) {
    lines.push(
      `Nothing to reclaim: every entry is either in use, newer than ` +
        `${plan.minAgeDays} days, or pinned. ` +
        `\`am prune --days=<n>\` looks further back.`,
    );
  } else {
    lines.push(
      `Nothing has been deleted. \`am prune --yes\` removes exactly the ` +
        `${plan.remove.length} entr${
          plan.remove.length === 1 ? "y" : "ies"
        } above and frees ${humanBytes(plan.freed)}.`,
    );
    lines.push(
      `An app that is pinned to one of them re-downloads it on its next ` +
        `launch — which an OFFLINE machine cannot do. Keep one by name: ` +
        `\`am prune --keep=43.4.1\`.`,
    );
  }
  return lines.join("\n");
}

/** The shared-runtime store's section of the plan. Pure. */
export function renderSharedPlan(
  root: string,
  decisions: readonly SharedPruneDecision[],
): string {
  const lines = [
    `Shared Electron store — ${root}`,
    `What apps built with "build": { "electronRuntime": "online" } start ` +
    `from. Age decides nothing here: only what no installed app names goes.`,
    "",
  ];
  const w = Math.max(4, ...decisions.map((d) => d.name.length));
  const row = (d: SharedPruneDecision) =>
    `  ${d.name.padEnd(w)}  ${humanBytes(d.bytes).padStart(7)}  ${d.why}`;
  const gone = decisions.filter((d) => !d.keep);
  const kept = decisions.filter((d) => d.keep);
  if (gone.length) {
    lines.push(
      `WOULD REMOVE (${humanBytes(gone.reduce((n, d) => n + d.bytes, 0))}):`,
    );
    for (const d of gone) lines.push(row(d));
    lines.push("");
  }
  if (kept.length) {
    lines.push("KEEPING:");
    for (const d of kept) lines.push(row(d));
    lines.push("");
  }
  if (gone.length) {
    lines.push(
      `Nothing has been deleted. \`am prune --yes\` removes these ` +
        `${gone.length} too.`,
    );
  }
  return lines.join("\n");
}

/** The refs `am prune versions` never offers, each with the sentence why:
 *  `--keep`, what this directory's app and every RUNNING app pin or link,
 *  the checkout am itself runs from, and the newest release. */
async function versionProtections(
  root: string | null,
  keep: readonly string[],
): Promise<Map<string, string>> {
  const protect = new Map<string, string>();
  const add = (ref: string | null, why: string) => {
    if (ref && !protect.has(ref)) protect.set(ref, why);
  };
  for (const k of keep) add(k, "kept by --keep");
  const appDirs = new Set([Deno.cwd(), ...instances().map((i) => i.cwd)]);
  for (const dir of appDirs) {
    if (!dir) continue;
    const pin = await readPin(dir);
    if (pin && !isPathPin(pin)) add(pin, `pinned by ${dir}`);
    const link = await currentLink(dir);
    if (link) add(refOfLink(resolve(dir, "dep", link)), `linked by ${dir}`);
  }
  for (const own of [repoRoot(), root]) {
    if (own) add(refOfLink(resolve(own)), "the aio checkout am runs from");
  }
  add(root ? await latestTag(root) : null, "the newest release");
  add(
    sortVersions(await provisioned())[0]?.raw ?? null,
    "the newest release on this machine",
  );
  return protect;
}

/** The version store's plan, as a human reads it. Pure. */
export function renderVersionPlan(
  root: string,
  plan: readonly VersionPruneDecision[],
): string {
  if (plan.length === 0) {
    return `No provisioned aio versions (${root}). Nothing to prune.`;
  }
  const w = Math.max(4, ...plan.map((d) => d.ref.length));
  const row = (d: VersionPruneDecision) => `  ${d.ref.padEnd(w)}  ${d.why}`;
  const gone = plan.filter((d) => !d.keep);
  const kept = plan.filter((d) => d.keep);
  const lines = [
    `aio version store — ${root}`,
    `One git checkout per version an app was pinned to. Shared by EVERY aio ` +
    `app on this machine; am knows only the apps here and the running ones.`,
    "",
  ];
  if (gone.length) {
    lines.push(`WOULD REMOVE (${gone.length}):`, ...gone.map(row), "");
  }
  if (kept.length) {
    lines.push(`KEEPING (${kept.length}):`, ...kept.map(row), "");
  }
  lines.push(
    gone.length
      ? `Nothing has been deleted. \`am prune versions --yes\` removes ` +
        `these ${gone.length} (git worktree remove). An app elsewhere pinned ` +
        `to one gets it back on its next \`am fix\`. Keep one by name: ` +
        `\`am prune versions --keep=<ref>\`.`
      : "Nothing to remove.",
  );
  return lines.join("\n");
}

/** `am prune versions [--yes] [--keep=<ref,…>]` — the version store. */
async function cmdPruneVersions(
  args: string[],
  flags: GlobalFlags,
): Promise<void> {
  const mode = detectMode(flags);
  if (args.some((a) => a.startsWith("--days="))) {
    fail(
      "--days does not apply to the version store (age decides nothing " +
        "there: only what no known app uses goes)",
      mode,
    );
  }
  const parsed = parsePruneArgs(args);
  if (parsed.error) fail(parsed.error, mode);
  let aioRoot: string | null;
  try {
    aioRoot = resolveAioRoot(args);
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e), mode);
  }
  const protect = await versionProtections(aioRoot, parsed.keep);
  const plan = await planVersionPrune(protect);
  const root = versionsDir();
  const doc = (
    removed: string[] | null,
    failed: { path: string; error: string }[] = [],
  ) => ({
    root,
    applied: removed !== null,
    plan,
    removed: removed ?? [],
    failed,
  });
  if (mode !== "json") out(null, mode, () => renderVersionPlan(root, plan));
  if (!parsed.apply || plan.every((d) => d.keep)) {
    if (mode === "json") out(doc(null), mode);
    return;
  }
  const result = await applyVersionPrune(plan);
  if (result.failed.length > 0) {
    const summary = `removed ${result.removed.length}; could NOT remove ` +
      `${result.failed.length}:\n` +
      result.failed.map((f) => `  ${f.path} — ${f.error}`).join("\n");
    if (mode === "json") {
      out({ ...doc(result.removed, result.failed), error: summary }, mode);
    } else outError(summary, mode);
    Deno.exit(1);
  }
  out(
    doc(result.removed),
    mode,
    () =>
      `\nRemoved ${result.removed.length}:\n` +
      result.removed.map((p) => `  ${p}`).join("\n"),
  );
}

export async function cmdPrune(
  args: string[],
  flags: GlobalFlags,
): Promise<void> {
  if (args[0] === "versions") return cmdPruneVersions(args.slice(1), flags);
  const mode = detectMode(flags);
  const parsed = parsePruneArgs(args);
  if (parsed.error) fail(parsed.error, mode);

  const now = Date.now();
  const entries = await readElectronCache();
  const shared = await planSharedPrune();
  const sharedGone = shared.decisions.filter((d) => !d.keep);
  const plan = planElectronPrune(entries, {
    // What this aio ships is never on the table: every app on this machine is
    // being moved onto it by `am pin`/`am fix`, so it is the one version that
    // is certainly needed.
    keepVersions: [DEFAULT_ELECTRON_VERSION, ...parsed.keep],
    minAgeDays: parsed.days,
    now,
  });

  /** ONE document for `--json`: plan + outcome. `freed` is what the plan
   *  would reclaim when `removed === null` (report-only), and what actually
   *  went when applied — never the planned total after a half-prune. */
  const asJson = (
    removed: string[] | null,
    failed: { path: string; error: string }[] = [],
  ) => {
    const sharedFreed = sharedGone
      .filter((d) => removed === null || removed.includes(d.path))
      .reduce((n, d) => n + d.bytes, 0);
    const freed = sharedFreed + (removed === null ? plan.freed : plan.remove
      .filter((d) => removed.includes(d.entry.path))
      .reduce((n, d) => n + d.entry.bytes, 0));
    return {
      root: electronCacheRoot(),
      // The shared-runtime store: its own rules (planSharedPrune), its own
      // list, removed by the same `--yes`.
      shared: {
        root: shared.root,
        plan: shared.decisions,
        removed: removed === null
          ? []
          : sharedGone.map((d) => d.path).filter((p) => removed.includes(p)),
      },
      total: plan.total,
      freed,
      minAgeDays: plan.minAgeDays,
      protectedVersions: plan.protectedVersions,
      applied: removed !== null,
      removed: removed ?? [],
      failed,
      plan: [...plan.remove, ...plan.keep].map((d) => ({
        name: d.entry.name,
        path: d.entry.path,
        kind: d.entry.kind,
        version: d.entry.version,
        slug: d.entry.slug,
        bytes: d.entry.bytes,
        lastUsed: d.entry.lastUsed,
        lastUsedSource: d.entry.lastUsedSource,
        keep: d.keep,
        why: d.why,
      })),
    };
  };

  const empty = entries.length === 0;
  const willApply = parsed.apply &&
    (plan.remove.length > 0 || sharedGone.length > 0);

  // HUMAN mode prints the plan BEFORE acting, always — `--yes` says "I have
  // decided", not "do not tell me what you did". JSON mode prints ONE
  // document, at the end, carrying both the plan and what was removed: the
  // `--json` contract is that the whole of stdout parses (see
  // tests/am-json-contract.test.ts), and two documents do not.
  if (mode !== "json") {
    out(
      null,
      mode,
      empty
        ? `No Electron runtime cache yet (${electronCacheRoot()}). Nothing to prune.`
        : () => renderPrunePlan(plan, now),
    );
    if (shared.decisions.length > 0) {
      out(
        null,
        mode,
        () => "\n" + renderSharedPlan(shared.root, shared.decisions),
      );
    }
  }
  if (!willApply) {
    if (mode === "json") out(asJson(null), mode);
    return;
  }

  const result = await applyElectronPrune(plan);
  for (const d of sharedGone) {
    try {
      await Deno.remove(d.path, { recursive: d.kind !== "record" });
      result.removed.push(d.path);
    } catch (e) {
      result.failed.push({
        path: d.path,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  const doc = asJson(result.removed, result.failed);
  if (result.failed.length > 0) {
    // Same shape as `am remove`: say what went and what did not, then exit 1.
    // In `--json` the failures ride INSIDE the one document — a preceding
    // `outError` would print a second `{error:…}` and break the contract this
    // verb's own comment cites. Exit 0 after printing failures used to leave
    // `am prune --yes && …` claiming success while runtimes stayed put, and
    // `freed` used to be the planned total even when nothing was removed.
    const summary =
      `removed ${result.removed.length} entr${
        result.removed.length === 1 ? "y" : "ies"
      }, freed ${
        humanBytes(doc.freed)
      }; could NOT remove ${result.failed.length}:\n` +
      result.failed.map((f) => `  ${f.path} — ${f.error}`).join("\n");
    if (mode === "json") {
      out({ ...doc, error: summary }, mode);
    } else {
      outError(summary, mode);
      if (result.removed.length) {
        sayErr(
          result.removed.map((p) => `  removed: ${p}`).join("\n"),
        );
      }
    }
    Deno.exit(1);
  }
  out(
    doc,
    mode,
    () =>
      `\nRemoved ${result.removed.length} entr${
        result.removed.length === 1 ? "y" : "ies"
      }, freed ${humanBytes(doc.freed)}:\n` +
      result.removed.map((p) => `  ${p}`).join("\n"),
  );
}
