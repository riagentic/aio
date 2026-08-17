// scripts/check-bench.ts — the D12 perf gate. Runs the benchmark suite
// (or reads bench-results.json with --cached) and compares each metric's
// MEDIAN against the committed floors in scripts/bench-baselines.json.
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

type Metric = { unit: string; median: number; p95: number; n: number };
type Results = {
  meta: Record<string, string>;
  metrics: Record<string, Metric>;
};
type Baselines = { maxMedian: Record<string, number> };

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
console.log("\nperf gate (median vs floor, bench-baselines.json):");
for (const [name, floor] of Object.entries(baselines.maxMedian)) {
  const m = results.metrics[name];
  if (!m) {
    violations.push(
      `${name}: MISSING from bench-results.json (floor ${floor})`,
    );
    console.log(`  ✗ ${name.padEnd(16)} missing`);
    continue;
  }
  const ok = m.median <= floor;
  console.log(
    `  ${ok ? "✓" : "✗"} ${name.padEnd(16)} ${m.median.toFixed(3)} ${m.unit}` +
      ` (floor ${floor} ${m.unit})`,
  );
  if (!ok) {
    violations.push(
      `${name}: measured median ${m.median.toFixed(3)} ${m.unit} exceeds ` +
        `floor ${floor} ${m.unit} — a ${
          (m.median / floor).toFixed(1)
        }x-of-floor regression. Fix the regression; only raise the floor for an ` +
        `accepted, understood cost (never to silence noise).`,
    );
  }
}

if (violations.length) {
  console.error(`\nbench:check FAIL — ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  • ${v}`);
  Deno.exit(1);
}
console.log("\n✓ bench:check — all metrics within perf floors");
