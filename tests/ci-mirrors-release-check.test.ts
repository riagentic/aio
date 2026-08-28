// CI runs what `check:release` runs — checked, not assumed.
//
// alpha56 shipped with `deno lint` red because the local loop and the remote
// loop were two lists maintained by hand. `scripts/release-check.ts` is now
// THE list (FAST + HEAVY); this test reads it and `.github/workflows/ci.yml`
// and requires every gate on it to be a `run:` step somewhere in CI. A gate
// added to the release check without a CI step is red here, on the same push.
import { assertEquals } from "@std/assert";

const REPO = new URL("../", import.meta.url).pathname;

/** The gate commands `release-check.ts` runs, read off its FAST/HEAVY lists
 *  as `deno task <name>` or `deno <verb> …` strings. */
async function releaseGates(): Promise<string[]> {
  const src = await Deno.readTextFile(REPO + "scripts/release-check.ts");
  const out: string[] = [];
  for (const list of ["FAST", "HEAVY"]) {
    const m = src.match(
      new RegExp(`const ${list}[^=]*=\\s*\\[([\\s\\S]*?)\\n\\];`),
    );
    if (!m) throw new Error(`release-check.ts: no ${list} list`);
    for (const row of m[1]!.matchAll(/\[\s*"[^"]+",\s*\[([^\]]*)\]/g)) {
      const words = [...row[1]!.matchAll(/"([^"]*)"/g)].map((w) => w[1]!);
      out.push(words.join(" "));
    }
  }
  return out;
}

Deno.test("ci: every gate check:release runs is a CI step", async () => {
  const ci = await Deno.readTextFile(REPO + ".github/workflows/ci.yml");
  const steps = [...ci.matchAll(/^\s*run:\s*(.+)$/gm)].map((m) => m[1]!.trim());
  const gates = await releaseGates();
  assertEquals(gates.length > 10, true, "read the lists");
  const missing = gates.filter((g) => {
    // `deno task update:docs -- --check` is spelled the same way in both.
    return !steps.some((s) => s === g || s.startsWith(g + " "));
  });
  assertEquals(
    missing,
    [],
    `gates in scripts/release-check.ts with no \`run:\` step in ci.yml — add ` +
      `one (a slow gate may go in the scheduled \`heavy\` job, and say so)`,
  );
});

Deno.test("ci: the heavy tier is scheduled AND on demand, and says it is not on every push", async () => {
  const ci = await Deno.readTextFile(REPO + ".github/workflows/ci.yml");
  assertEquals(/^\s*schedule:/m.test(ci), true, "a nightly schedule");
  assertEquals(/^\s*workflow_dispatch:/m.test(ci), true, "on demand");
  assertEquals(
    /heavy:[\s\S]*?if:.*schedule.*workflow_dispatch/.test(ci),
    true,
    "the heavy job is gated on those two events",
  );
});
