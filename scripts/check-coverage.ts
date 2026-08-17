// Coverage ratchet gate — src/ line coverage must not drop below the floor.
// Run via `deno task check:coverage` (tests with --coverage → lcov → this).
// RATCHET RULE: when real coverage rises, raise FLOOR to just below it.
// Never lower it — a drop below the floor means new code shipped untested.

const FLOOR = 73; // % of src/ lines covered (deno coverage, full suite)

const LCOV = "coverage/lcov.info";

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

// lcov: SF:<path> starts a record; LF:<n> lines found; LH:<n> lines hit.
let sf = "";
let found = 0;
let hit = 0;
const perFile: Array<{ file: string; pct: number; lf: number }> = [];
let recLf = 0;
let recLh = 0;

const include = (f: string) => f.includes("/src/") && !f.includes("/examples/");

for (const line of text.split("\n")) {
  if (line.startsWith("SF:")) {
    sf = line.slice(3).trim();
    recLf = 0;
    recLh = 0;
  } else if (line.startsWith("LF:")) {
    recLf = Number(line.slice(3));
  } else if (line.startsWith("LH:")) {
    recLh = Number(line.slice(3));
  } else if (line === "end_of_record" && include(sf)) {
    found += recLf;
    hit += recLh;
    if (recLf > 0) {
      perFile.push({ file: sf, pct: (recLh / recLf) * 100, lf: recLf });
    }
  }
}

if (found === 0) {
  console.error(
    `[coverage] ✗ no src/ records in ${LCOV} — profile looks empty or filtered.`,
  );
  Deno.exit(1);
}

const pct = (hit / found) * 100;
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
