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
import { detectMode, fail, out, outError } from "./am-output.ts";
import {
  applyElectronPrune,
  type CacheEntry,
  DEFAULT_ELECTRON_VERSION,
  electronCacheRoot,
  humanBytes,
  planElectronPrune,
  PRUNE_DEFAULT_MIN_AGE_DAYS,
  type PrunePlan,
  readElectronCache,
} from "../build/electron-cache.ts";

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
      const n = Number(a.slice("--days=".length));
      if (!Number.isInteger(n) || n < 0) {
        return {
          apply,
          days,
          keep,
          error: `--days must be a whole number of days (got "${
            a.slice("--days=".length)
          }")`,
        };
      }
      days = n;
    } else if (a.startsWith("--keep=")) {
      for (const v of a.slice("--keep=".length).split(",")) {
        if (v.trim()) keep.push(v.trim());
      }
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

export async function cmdPrune(
  args: string[],
  flags: GlobalFlags,
): Promise<void> {
  const mode = detectMode(flags);
  const parsed = parsePruneArgs(args);
  if (parsed.error) fail(parsed.error, mode);

  const now = Date.now();
  const entries = await readElectronCache();
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
    const freed = removed === null ? plan.freed : plan.remove
      .filter((d) => removed.includes(d.entry.path))
      .reduce((n, d) => n + d.entry.bytes, 0);
    return {
      root: electronCacheRoot(),
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
  const willApply = parsed.apply && plan.remove.length > 0;

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
  }
  if (!willApply) {
    if (mode === "json") out(asJson(null), mode);
    return;
  }

  const result = await applyElectronPrune(plan);
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
        console.error(
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
