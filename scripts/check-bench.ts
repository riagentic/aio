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
// Run: deno task check:bench   (add --cached to reuse bench-results.json)

const root = new URL("../", import.meta.url);
const resultsPath = new URL("bench-results.json", root);
const baselinesPath = new URL("bench-baselines.json", import.meta.url);

if (!Deno.args.includes("--cached")) {
  const cmd = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "--v8-flags=--expose-gc", "scripts/bench.ts"],
    cwd: new URL(root).pathname,
    stdout: "inherit",
    stderr: "inherit",
  });
  const { code } = await cmd.output();
  if (code !== 0) {
    console.error(`\nbench:check FAIL — scripts/bench.ts exited ${code}`);
    Deno.exit(1);
  }
}

type Metric = {
  unit: string;
  p10?: number;
  min?: number;
  median: number;
  p95: number;
  n: number;
};
type Results = {
  meta: Record<string, string>;
  metrics: Record<string, Metric>;
};
type Baselines = { maxMedian: Record<string, number> };

/** What the gate compares — see the header. */
const gated = (m: Metric): number => m.p10 ?? m.median;

let results: Results;
try {
  results = JSON.parse(await Deno.readTextFile(resultsPath));
} catch {
  console.error(
    "bench:check FAIL — bench-results.json missing/unreadable " +
      "(run `deno task bench` first, or drop --cached)",
  );
  Deno.exit(1);
}
const baselines: Baselines = JSON.parse(await Deno.readTextFile(baselinesPath));

const violations: string[] = [];
console.log("\nperf gate (p10 vs floor, bench-baselines.json):");
for (const [name, floor] of Object.entries(baselines.maxMedian)) {
  const m = results.metrics[name];
  if (!m) {
    violations.push(
      `${name}: MISSING from bench-results.json (floor ${floor})`,
    );
    console.log(`  ✗ ${name.padEnd(16)} missing`);
    continue;
  }
  const v = gated(m);
  const ok = v <= floor;
  console.log(
    `  ${ok ? "✓" : "✗"} ${name.padEnd(16)} ${v.toFixed(3)} ${m.unit}` +
      ` (floor ${floor} ${m.unit}${
        m.p10 === undefined ? ", median — stale results" : ""
      })`,
  );
  if (!ok) {
    violations.push(
      `${name}: measured p10 ${v.toFixed(3)} ${m.unit} exceeds floor ` +
        `${floor} ${m.unit} — a ${
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
  const m = results.metrics[name];
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
  console.log(`\nheadroom (a floor this far above the number gates nothing):`);
  for (const s of slack) console.log(`  · ${s}`);
}

if (violations.length) {
  console.error(`\nbench:check FAIL — ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  • ${v}`);
  Deno.exit(1);
}
console.log("\n✓ bench:check — all metrics within perf floors");
