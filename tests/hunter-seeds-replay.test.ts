// Hunter-seed replay — seconds, not sweeps.
//
// Randomized differentials explore. When they kill something, the kill becomes
// a pinned Deno.test (or a named seed). This file is the CATALOGUE gate: every
// seed in tests/hunter-seeds.json still has its pin text in the named file.
// That is cheaper than re-running FUZZ_ROUNDS=120 on every edit, and it stops
// a "cleanup" from deleting the only regression that remembered the bug.
import { assert } from "@std/assert";
import { fromFileUrl, join } from "@std/path";

const ROOT = fromFileUrl(new URL("..", import.meta.url));
const catalog = JSON.parse(
  Deno.readTextFileSync(join(ROOT, "tests/hunter-seeds.json")),
) as {
  seeds: {
    id: string;
    what: string;
    file: string;
    pinIncludes: string[];
  }[];
};

Deno.test("hunter seeds: catalogue is non-empty and each pin still exists", () => {
  assert(catalog.seeds.length >= 5, "catalogue shrank below the floor");
  for (const s of catalog.seeds) {
    assert(
      s.pinIncludes.length > 0,
      `hunter seed ${s.id} has no pinIncludes — the catalogue row is vacuous`,
    );
    const src = Deno.readTextFileSync(join(ROOT, s.file));
    for (const needle of s.pinIncludes) {
      assert(
        src.includes(needle),
        `hunter seed ${s.id} (${s.what}) — pin text missing from ${s.file}: ` +
          JSON.stringify(needle),
      );
    }
  }
});

Deno.test("hunter seeds: ids are unique", () => {
  const ids = catalog.seeds.map((s) => s.id);
  assert(new Set(ids).size === ids.length, "duplicate hunter seed ids");
});
