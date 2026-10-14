// scripts/check-bench.ts — the D12 perf gate. Runs the benchmark suite
// (or reads bench-results.json with --cached) and compares each metric's
// p10 against the committed floors in scripts/bench-baselines.json.
//
// p10, not the median, since alpha72: a median on a shared machine is
// dominated by whatever else is running. Three back-to-back runs of the SAME
// build spread `proxy-array-10k`'s median across 53-70 ms — wider than any
// regression worth catching, which is how a ceiling could sit 2x above the
// real number while the real number drifted underneath it. A benchmark asks
// "how fast can this go", so every sample above the floor is contamination.
// The low quantile is the estimator for that question. Older results without
// a `p10` field fall back to the median so a stale bench-results.json still
// reports rather than crashing.
// "Correct but slower" fails here like a broken test.
//
// A metric over its floor is measured AGAIN, alone, up to twice more, and the
// best of the attempts is what the gate judges. Not leniency: a p10 is "how
// fast can this go", and one attempt on a machine that was busy for those
// seconds has not answered that. A real regression is over its floor three
// times out of three; a neighbour's build is not. The machine's load is
// printed beside the verdict, so a red here can be read for what it is.
// Run: deno task check:bench   (add --cached to reuse bench-results.json)

const root = new URL("../", import.meta.url);
const resultsPath = new URL("bench-results.json", root);
const baselinesPath = new URL("bench-baselines.json", import.meta.url);

export type Metric = {
  unit: string;
  p10?: number;
  min?: number;
  median: number;
  p95: number;
  n: number;
};
export type Results = {
  meta: Record<string, string>;
  metrics: Record<string, Metric>;
};
type Baselines = { maxMedian: Record<string, number> };

/** What the gate compares — see the header. */
const gated = (m: Metric): number => m.p10 ?? m.median;

/** The metrics measured over their floor. A MISSING metric is not in this
 *  list: measuring it again cannot make it exist, and it fails on its own
 *  line. Pure. */
export function overFloor(
  metrics: Record<string, Metric>,
  floors: Record<string, number>,
): string[] {
  return Object.entries(floors)
    .filter(([name, floor]) => metrics[name] && gated(metrics[name]!) > floor)
    .map(([name]) => name);
}

/** How many times a red metric is measured again before the gate fails. */
export const RETRIES = 2;

/** Measure, then measure each red metric again — alone — up to
 *  {@linkcode RETRIES} times, keeping the best attempt per metric. `measure`
 *  runs the suite (`only` absent) or the named metrics, and returns what it
 *  measured. Returns the metrics to judge and how often each was retried. */
export async function measureWithRetries(
  measure: (only?: string[]) => Promise<Record<string, Metric>>,
  floors: Record<string, number>,
  say: (line: string) => void = () => {},
): Promise<
  { metrics: Record<string, Metric>; retried: Record<string, number> }
> {
  const metrics = { ...await measure() };
  const retried: Record<string, number> = {};
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    const red = overFloor(metrics, floors);
    if (red.length === 0) break;
    say(`retry ${attempt}/${RETRIES}: ${red.join(", ")} — ${machineLoad()}`);
    const again = await measure(red);
    for (const name of red) {
      retried[name] = attempt;
      const m = again[name];
      if (m && gated(m) < gated(metrics[name]!)) metrics[name] = m;
    }
  }
  return { metrics, retried };
}

/** The machine's load, for the report: a p10 measured beside sixteen busy
 *  cores and one measured on an idle box are different facts. */
export function machineLoad(): string {
  const cores = navigator.hardwareConcurrency;
  try {
    const [one, five] = Deno.loadavg();
    return `load ${one!.toFixed(1)} (1 min) ${five!.toFixed(1)} (5 min) on ` +
      `${cores} cores`;
  } catch {
    return `load unknown on ${cores} cores`; // aio-ok: no loadavg on this OS
  }
}

async function runBench(only?: string[]): Promise<Record<string, Metric>> {
  const cmd = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      "--v8-flags=--expose-gc",
      "scripts/bench.ts",
      // After a bare `--`: aio.run() inside the bench parses the process's
      // flags, and stops there.
      ...(only ? ["--", `--only=${only.join(",")}`] : []),
    ],
    cwd: new URL(root).pathname,
    stdout: "inherit",
    stderr: "inherit",
  });
  const { code } = await cmd.output();
  if (code !== 0) {
    console.error(`\nbench:check FAIL — scripts/bench.ts exited ${code}`);
    Deno.exit(1);
  }
  return (JSON.parse(await Deno.readTextFile(resultsPath)) as Results).metrics;
}

async function main(): Promise<void> {
  const cached = Deno.args.includes("--cached");
  const baselines: Baselines = JSON.parse(
    await Deno.readTextFile(baselinesPath),
  );
  console.log(`bench: ${machineLoad()}`);
  let metrics: Record<string, Metric>;
  let retried: Record<string, number> = {};
  if (cached) {
    try {
      metrics =
        (JSON.parse(await Deno.readTextFile(resultsPath)) as Results).metrics;
    } catch {
      console.error(
        "bench:check FAIL — bench-results.json missing/unreadable " +
          "(run `deno task bench` first, or drop --cached)",
      );
      Deno.exit(1);
    }
  } else {
    ({ metrics, retried } = await measureWithRetries(
      runBench,
      baselines.maxMedian,
      (l) => console.log(`\n${l}`),
    ));
  }

  const violations: string[] = [];
  console.log(
    `\nperf gate (p10 vs floor, bench-baselines.json) — ${machineLoad()}:`,
  );
  for (const [name, floor] of Object.entries(baselines.maxMedian)) {
    const m = metrics[name];
    if (!m) {
      violations.push(
        `${name}: MISSING from bench-results.json (floor ${floor})`,
      );
      console.log(`  ✗ ${name.padEnd(16)} missing`);
      continue;
    }
    const v = gated(m);
    const ok = v <= floor;
    const tries = retried[name]
      ? `, best of ${retried[name]! + 1} attempts`
      : "";
    console.log(
      `  ${ok ? "✓" : "✗"} ${name.padEnd(16)} ${v.toFixed(3)} ${m.unit}` +
        ` (floor ${floor} ${m.unit}${
          m.p10 === undefined ? ", median — stale results" : ""
        }${tries})`,
    );
    if (!ok) {
      violations.push(
        `${name}: measured p10 ${v.toFixed(3)} ${m.unit} exceeds floor ` +
          `${floor} ${m.unit}${tries} — a ${
            (v / floor).toFixed(1)
          }x-of-floor regression (median ${m.median.toFixed(3)}, min ${
            (m.min ?? m.median).toFixed(3)
          }). Fix the regression; only raise the floor for an accepted, ` +
          `understood cost (never to silence noise).`,
      );
    }
  }

  // A ceiling that sits far above the measurement stops being a gate: the whole
  // reason `proxy-array-10k` could drift 30 → 50 ms unremarked is that its floor
  // was 75. Report the slack — never fail on it, because a genuinely fast metric
  // is not a defect — so the next person to look knows the ratchet has a job.
  const slack: string[] = [];
  for (const [name, floor] of Object.entries(baselines.maxMedian)) {
    const m = metrics[name];
    if (!m) continue;
    const v = gated(m);
    // 3x: the policy is 2x (see bench-baselines.json), so warn only beyond it.
    if (v > 0 && floor / v >= 3) {
      slack.push(
        `${name}: floor ${floor} is ${(floor / v).toFixed(1)}x the measured ${
          v.toFixed(3)
        } — the policy is 2x, so lower it to ~${
          (v * 2).toPrecision(2)
        } and a real regression trips it.`,
      );
    }
  }
  if (slack.length) {
    console.log(
      `\nheadroom (a floor this far above the number gates nothing):`,
    );
    for (const s of slack) console.log(`  · ${s}`);
  }

  if (violations.length) {
    console.error(
      `\nbench:check FAIL — ${violations.length} violation(s) ` +
        `(${machineLoad()}):`,
    );
    for (const v of violations) console.error(`  • ${v}`);
    Deno.exit(1);
  }
  console.log("\n✓ bench:check — all metrics within perf floors");
}

if (import.meta.main) await main();
