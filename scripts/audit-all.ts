#!/usr/bin/env -S deno run -A
// scripts/audit-all.ts — every randomized audit round, one seed, one exit code.
//
//   deno task check:audit            # the committed seed
//   deno task check:audit -- --seed=12345
//
// Each round runs in its OWN process: several of them install global state (a
// document, an exit function, a logger sink) and one round's leftovers must
// never be another round's premise. That also means a round that hangs — the
// correct failure for "a stream was buffered" — is visible as a timeout on one
// name rather than a suite that never finishes.
const ROUNDS = Array.from({ length: 30 }, (_, i) => String(i + 1));
const seedArg = Deno.args.find((a) => a.startsWith("--seed="));
const seed = seedArg ? seedArg.slice(7) : "20260829";
const script = new URL("audit-round.ts", import.meta.url).pathname;

const failed: string[] = [];
for (const round of ROUNDS) {
  const t0 = performance.now();
  const out = await new Deno.Command(Deno.execPath(), {
    // Env, not argv: a round that boots a real server calls `parseCli()`, and
    // this script's arguments are not that server's.
    args: ["run", "-A", script],
    env: { ...Deno.env.toObject(), AUDIT_ROUND: round, AUDIT_SEED: seed },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const text = new TextDecoder().decode(out.stdout) +
    new TextDecoder().decode(out.stderr);
  const ms = (performance.now() - t0).toFixed(0);
  if (out.code === 0) {
    console.log(`  ✓ round ${round.padStart(2)}  ${ms.padStart(6)}ms`);
  } else {
    failed.push(round);
    console.log(`  ✗ round ${round.padStart(2)}  ${ms.padStart(6)}ms`);
    for (const line of text.split("\n")) {
      if (line.includes("FINDING") || line.includes("error:")) {
        console.log(`      ${line.trim().slice(0, 200)}`);
      }
    }
  }
}
if (failed.length) {
  console.error(
    `\naudit FAIL — round(s) ${failed.join(", ")} (seed ${seed}).\n` +
      `  Replay one: AUDIT_ROUND=<n> AUDIT_SEED=${seed} deno run -A ${script}`,
  );
  Deno.exit(1);
}
console.log(`\n✓ audit: ${ROUNDS.length} rounds clean (seed ${seed})`);
