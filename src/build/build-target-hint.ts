/**
 * The refusal for a direct `build.ts` flag set that names no fleet target —
 * and the nearest target it probably meant.
 *
 * Since alpha73 a direct `deno run build.ts <flags>` resolves its target from
 * the fleet's TARGETS table by EXACT flag-set equality, so the old spelling
 * `--compile --android` (android is `["--android"]`) matched nothing and was
 * refused with the list of target names only — the reader had to diff flag
 * sets by hand to find `--android` (remote-desktop field report §6). The nearest target is a
 * pure function of the same table, so the refusal says it.
 *
 * Pure: the table is a parameter, so there is no second copy to drift.
 */

/** The shape of one TARGETS row this module reads. */
export interface TargetFlags {
  flags: readonly string[];
}

/** `--cli` and `--electron` imply `--compile` — the same rule
 *  `targetForFlags` applies, so "nearest" and "exact" agree on one table. */
function normalize(flags: Iterable<string>): Set<string> {
  const s = new Set(flags);
  if (s.has("--cli") || s.has("--electron")) s.add("--compile");
  return s;
}

/** The targets whose flag set is nearest `given`'s build flags, best first
 *  (ties all returned, in table order); empty when `given` has none.
 *
 *  Distance is the symmetric difference, with `--compile` weighted half: it is
 *  the flag old spellings carried everywhere (`--compile --android`), so an
 *  extra or missing `--compile` is a smaller mistake than a wrong platform
 *  flag — without the weight `--compile --android` ties `browser`
 *  (`--compile`) with `android` (`--android`). */
export function nearestTargets(
  given: readonly string[],
  targets: Record<string, TargetFlags>,
): string[] {
  const vocab = new Set(Object.values(targets).flatMap((t) => t.flags));
  const want = normalize(given.filter((f) => vocab.has(f)));
  if (want.size === 0) return [];
  const cost = (f: string) => f === "--compile" ? 0.5 : 1;
  const scored = Object.entries(targets).map(([name, t]) => {
    const have = normalize(t.flags);
    let d = 0;
    for (const f of want) if (!have.has(f)) d += cost(f);
    for (const f of have) if (!want.has(f)) d += cost(f);
    return { name, d };
  });
  const best = Math.min(...scored.map((s) => s.d));
  return scored.filter((s) => s.d === best).map((s) => s.name);
}

/** The whole refusal text (without the leading mark), naming the nearest
 *  target's flags and fleet name. */
export function notATargetMessage(
  given: readonly string[],
  targets: Record<string, TargetFlags>,
): string {
  const near = nearestTargets(given, targets);
  const hint = near.length === 0
    ? ""
    : `  Did you mean ${
      near.map((n) => `${targets[n]!.flags.join(" ")} (target "${n}")`)
        .join(" or ")
    }?\n`;
  return `${given.join(" ")} is not a build target.\n` + hint +
    `  Every build goes through the fleet, so one artifact is one name, ` +
    `one version and one manifest entry.\n` +
    `  Targets: ${Object.keys(targets).join(", ")}\n` +
    `  Run:     deno task build --targets=<name>   (or \`am build <name>\`)\n` +
    `  If this came from a pre-alpha52 \`compile:*\` task, \`am fix ` +
    `--migrate-tasks\` rewrites them into the targets they encoded.`;
}
