// Coverage ratchet gate — src/ line coverage must not drop below the floor.
// Run via `deno task check:coverage` (tests with --coverage → lcov → this).
// RATCHET RULE: when real coverage rises, raise FLOOR to just below it.
// Never lower it — a drop below the floor means new code shipped untested.
//
// WHICH src/. The filter used to be `path.includes("/src/")`, and on any
// machine that has ever run `install.sh` that matches a SECOND copy of this
// source: `~/.local/lib/aio/src/…`, exercised sparsely by the tests that drive
// the installed CLI. The gate then averaged the repo (83.5%, 374 files) with an
// installation of it (10.3%, 237 files) and reported 52.4% — thirty points
// under the truth, and only on developer machines, because a fresh CI runner
// has no global install to find.
//
// That is the whole of "the coverage floor is flaky by nature". It was never
// flake: it was a filter that could not tell this repo from a copy of it, and
// the number moved with whether the last `install.sh` had run. Anchored to the
// repo root, the same profile reads 83.5%.
//
// The floor stays at 73 for now: the measurement was corrected, coverage did
// not rise, and ratcheting on one machine's first correct reading is the thing
// the comment above warns against. Let CI confirm, then raise it.

const FLOOR = 73; // % of src/ lines covered (deno coverage, full suite)

/** This repo. Every path the gate counts must live under it. */
const ROOT = new URL("../", import.meta.url).pathname;

const LCOV = "coverage/lcov.info";

/** Which records count: this repo's own `src/`, and nothing else that merely
 *  has a `/src/` in its path. Exported so the rule can be tested rather than
 *  re-read — the version it replaces cost thirty points of a measurement. */
export const includeFile = (f: string, root: string): boolean =>
  f.startsWith(`${root}src/`) && !f.includes("/examples/");

export type Coverage = {
  found: number;
  hit: number;
  pct: number;
  perFile: Array<{ file: string; pct: number; lf: number }>;
};

/** lcov: SF:<path> starts a record; LF:<n> lines found; LH:<n> lines hit. */
export function coverageOf(text: string, root: string): Coverage {
  let sf = "";
  let found = 0;
  let hit = 0;
  const perFile: Coverage["perFile"] = [];
  let recLf = 0;
  let recLh = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("SF:")) {
      sf = line.slice(3).trim();
      recLf = 0;
      recLh = 0;
    } else if (line.startsWith("LF:")) {
      recLf = Number(line.slice(3));
    } else if (line.startsWith("LH:")) {
      recLh = Number(line.slice(3));
    } else if (line === "end_of_record" && includeFile(sf, root)) {
      found += recLf;
      hit += recLh;
      if (recLf > 0) {
        perFile.push({ file: sf, pct: (recLh / recLf) * 100, lf: recLf });
      }
    }
  }
  return { found, hit, pct: found === 0 ? 0 : (hit / found) * 100, perFile };
}

if (import.meta.main) {
  let text: string;
  try {
    text = await Deno.readTextFile(LCOV);
  } catch {
    console.error(
      `[coverage] ✗ ${LCOV} not found — run \`deno task check:coverage\` ` +
        `(it generates the profile + lcov before this gate).`,
    );
    Deno.exit(1);
  }
  const { found, perFile, pct } = coverageOf(text, ROOT);

  if (found === 0) {
    console.error(
      `[coverage] ✗ no records under ${ROOT}src/ in ${LCOV} — the profile is ` +
        `empty, or every path in it is outside this repo.`,
    );
    Deno.exit(1);
  }

  const rounded = Math.round(pct * 10) / 10;

  if (pct < FLOOR) {
    console.error(
      `[coverage] ✗ src/ line coverage ${rounded}% is below the ${FLOOR}% floor.`,
    );
    console.error(`[coverage]   worst-covered files (≥50 lines):`);
    for (
      const f of perFile
        .filter((f) => f.lf >= 50)
        .sort((a, b) => a.pct - b.pct)
        .slice(0, 10)
    ) {
      const rel = f.file.slice(f.file.indexOf("/src/") + 1);
      console.error(`[coverage]     ${rel} — ${Math.round(f.pct)}%`);
    }
    console.error(
      `[coverage]   fix: add tests for the files above; never lower FLOOR.`,
    );
    Deno.exit(1);
  }

  console.log(
    `✓ src/ line coverage ${rounded}% (floor ${FLOOR}%${
      pct - FLOOR > 3
        ? ` — consider ratcheting FLOOR up to ${Math.floor(pct - 1)}`
        : ""
    })`,
  );
}
