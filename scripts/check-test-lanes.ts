#!/usr/bin/env -S deno run --allow-read
// check-test-lanes.ts — every fast/seam path exists, no overlap mistakes,
// and every *differential* / *prod-parity* / transport seam file is either in
// the seam lane or explicitly demoted with a why.
//
// Without this, test:fast quietly shrinks as people add pins under new names
// and the "clever suite" becomes a second forgotten list.
import { fromFileUrl, join } from "@std/path";

const ROOT = fromFileUrl(new URL("../", import.meta.url));
const lanes = JSON.parse(
  Deno.readTextFileSync(join(ROOT, "scripts/test-lanes.json")),
) as {
  fast: string[];
  seam: string[];
  demoted: { file: string; lane: string; why: string }[];
};

const errors: string[] = [];

function exists(rel: string): boolean {
  try {
    Deno.statSync(join(ROOT, rel));
    return true;
  } catch {
    return false;
  }
}

for (const rel of lanes.fast) {
  if (!exists(rel)) errors.push(`fast lane lists missing file: ${rel}`);
}
for (const rel of lanes.seam) {
  if (!exists(rel)) errors.push(`seam lane lists missing file: ${rel}`);
}
for (const d of lanes.demoted) {
  if (!d.why || d.why.trim().length < 12) {
    errors.push(`demoted ${d.file} needs a real why (≥12 chars)`);
  }
  if (!["full", "nightly", "seam"].includes(d.lane)) {
    errors.push(`demoted ${d.file} has unknown lane ${d.lane}`);
  }
}

const fastSet = new Set(lanes.fast);
const seamSet = new Set(lanes.seam);
for (const rel of lanes.fast) {
  if (seamSet.has(rel)) {
    errors.push(`${rel} is in BOTH fast and seam — pick one (prefer seam)`);
  }
}

// Seam obligation: differential / prod-parity / transport* files must be
// classified (seam or demoted), so a new wire pin cannot hide in full-only.
const demotedSet = new Set(lanes.demoted.map((d) => d.file));
const obligated: string[] = [];
for (const e of Deno.readDirSync(join(ROOT, "tests"))) {
  if (!e.isFile) continue;
  const name = e.name;
  if (!/\.test\.tsx?$/.test(name)) continue;
  const rel = `tests/${name}`;
  const seamish =
    /differential|prod-parity|transport-|hunter-seeds|seam-method|wire-patch|chaos-fuzz/
      .test(name);
  if (seamish) obligated.push(rel);
}
for (const rel of obligated) {
  if (!seamSet.has(rel) && !demotedSet.has(rel) && !fastSet.has(rel)) {
    errors.push(
      `${rel} looks like a seam test but is not in seam/fast/demoted — ` +
        `add it to scripts/test-lanes.json`,
    );
  }
}

if (errors.length) {
  console.error("check:test-lanes FAIL\n  " + errors.join("\n  "));
  Deno.exit(1);
}
console.log(
  `✓ test lanes: ${lanes.fast.length} fast, ${lanes.seam.length} seam, ` +
    `${lanes.demoted.length} demoted; ${obligated.length} seam-shaped files classified`,
);
