// proof-claims-have-gates.test.ts — the proof matrix cannot claim a gate that
// does not exist, and no gate can write a row the matrix does not list.
//
// The matrix is the release's evidence file, so its own honesty needs a gate.
// Two ways it went wrong, both real:
//
//   1. A claim marked `auto: true` with nothing calling `recordProof` for it —
//      the matrix says "never run", the reader hears "somebody just has to run
//      it", and nobody can, because there is no it.
//   2. A `recordProof(target, env)` whose pair is not in CLAIMS — the row is
//      written into proof-matrix.json and never printed. Proof that vanishes.
//
// Both are the "a key in 2 of 3 surfaces" shape this project keeps finding, so
// they are checked against the SOURCE of every gate rather than by memory.

import { assertEquals } from "@std/assert";
import { CLAIMS } from "../scripts/proof.ts";

const ROOT = new URL("../", import.meta.url);

/** Every `recordProof("<target>", "<env>"` in tests/ and scripts/, with the
 *  file it lives in. Read as text: importing the gates would run them. */
async function recordedPairs(): Promise<Map<string, string[]>> {
  const found = new Map<string, string[]>();
  for (const dir of ["tests", "scripts"]) {
    for await (const e of Deno.readDir(new URL(dir, ROOT))) {
      if (!e.isFile || !/\.(ts|tsx)$/.test(e.name)) continue;
      if (e.name === "proof.ts" || e.name.startsWith("proof-claims")) continue;
      const src = await Deno.readTextFile(new URL(`${dir}/${e.name}`, ROOT));
      for (
        const m of src.matchAll(
          /recordProof\(\s*"([^"]+)",\s*"([^"]+)"/g,
        )
      ) {
        const key = `${m[1]}/${m[2]}`;
        found.set(key, [...(found.get(key) ?? []), `${dir}/${e.name}`]);
      }
    }
  }
  return found;
}

Deno.test("every automatic claim has a gate that writes its row", async () => {
  const recorded = await recordedPairs();
  const orphans = CLAIMS
    .filter((c) => c.auto)
    .map((c) => `${c.target}/${c.env}`)
    .filter((key) => !recorded.has(key));
  assertEquals(
    orphans,
    [],
    `these claims say auto:true but nothing calls recordProof for them — ` +
      `either wire the gate, or set auto:false and say in \`how\` that there ` +
      `is none: ${orphans.join(", ")}`,
  );
});

Deno.test("no claim marked NO GATE actually has one", async () => {
  const recorded = await recordedPairs();
  const lying = CLAIMS
    .filter((c) => !c.auto)
    .map((c) => `${c.target}/${c.env}`)
    .filter((key) => recorded.has(key));
  assertEquals(
    lying,
    [],
    `these claims say NO GATE, but a gate writes their row — flip auto to ` +
      `true so the matrix stops under-reporting itself: ${lying.join(", ")}`,
  );
});

Deno.test("no gate writes a row the matrix never prints", async () => {
  const claimed = new Set(CLAIMS.map((c) => `${c.target}/${c.env}`));
  const stray: string[] = [];
  for (const [key, files] of await recordedPairs()) {
    if (!claimed.has(key)) stray.push(`${key} (${files.join(", ")})`);
  }
  assertEquals(
    stray,
    [],
    `these gates record proof for a pair CLAIMS does not list, so the row is ` +
      `written and never shown — add the claim, or fix the spelling: ` +
      stray.join("; "),
  );
});

Deno.test("no two claims share a target+env", () => {
  const keys = CLAIMS.map((c) => `${c.target}/${c.env}`);
  assertEquals(
    keys.length,
    new Set(keys).size,
    `a duplicate pair would make one claim unprovable: recordProof replaces ` +
      `the row by target+env, so the second claim reads the first one's run`,
  );
});
