// `am migrate` — the retired spellings THIS app still uses.
//
// A field report asked for `am migrate --from=alpha76` (risoto §22.7). Every
// piece already existed with no front door: REMOVALS carries each retired
// spelling with its hint and its guide, `removalsInSource` finds them in real
// source, and `aiol --safe-fix` rewrites the renames.
//
// It SCANS rather than lists. "Everything removed since alpha76" is a
// changelog, and the changelog exists; the useful answer is the intersection
// with your code, which is usually much shorter and always actionable.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import {
  removalsAfter,
  scanMigrations,
  seriesRank,
} from "../src/am/am-cmd-migrate.ts";
import { REMOVALS } from "../src/state/removals.ts";

const REPO = new URL("..", import.meta.url).pathname;

async function am(
  args: string[],
  cwd: string,
): Promise<{ code: number; out: string; err: string }> {
  const p = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", `${REPO}src/am.ts`, ...args],
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: p.code,
    out: new TextDecoder().decode(p.stdout),
    err: new TextDecoder().decode(p.stderr),
  };
}

Deno.test("seriesRank orders the release vocabulary", () => {
  assert(seriesRank("alpha52") < seriesRank("alpha76"));
  assert(seriesRank("alpha76") < seriesRank("beta1"));
  assert(seriesRank("beta1") < seriesRank("1.0.0"));
  // The tagged spelling and the bare series are the same release.
  assertEquals(seriesRank("v1.0.0-alpha76"), seriesRank("alpha76"));
  // Unreadable sorts LAST, so an unrecognised --from shows EVERYTHING. A
  // migration tool that under-reports is worse than one that over-reports:
  // the app boots and then explodes.
  assertEquals(seriesRank("who-knows"), Number.MAX_SAFE_INTEGER);
});

Deno.test("--from narrows to what was removed after it", () => {
  const all = removalsAfter(undefined);
  assertEquals(
    all.length,
    REMOVALS.length,
    "no --from means the whole registry",
  );
  const after76 = removalsAfter("alpha76");
  assert(
    after76.length < all.length,
    "alpha76 is not the first release — something must be filtered out",
  );
  for (const r of after76) {
    assert(
      seriesRank(r.removedIn) > seriesRank("alpha76"),
      `${r.key} was removed in ${r.removedIn}, which is not after alpha76`,
    );
  }
  // An unreadable --from must not silently hide rows.
  assertEquals(removalsAfter("nonsense").length, all.length);
});

Deno.test("a clean app is told so, in one line, exit 0", async () => {
  const dir = await tempDir("am-migrate-ok-");
  try {
    await Deno.mkdir(`${dir}/src`, { recursive: true });
    await Deno.writeTextFile(
      `${dir}/src/app.ts`,
      `import { cell } from "aio";\nexport const c = cell("c", { state: { n: 0 }, methods: {} });\n`,
    );
    await Deno.writeTextFile(`${dir}/deno.json`, JSON.stringify({ name: "x" }));
    // Piped stdout means `am` answers in JSON — that is how every verb here
    // behaves, and a test that assumed the pretty line was asserting on a mode
    // no script ever sees.
    const r = await am(["migrate"], dir);
    assertEquals(r.code, 0, r.out + r.err);
    assertEquals(JSON.parse(r.out).findings, []);
    assertEquals(
      JSON.parse(r.out).from,
      null,
      "no pin in this app, so every removal was considered — and none matched",
    );
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("a retired cell-config key is found, with the fix and the guide", async () => {
  const dir = await tempDir("am-migrate-hit-");
  try {
    // A row the registry actually carries, read from the registry rather than
    // remembered — a fixture that names a key by hand goes stale silently.
    const row = REMOVALS.find((r) => r.kind === "cell-config")!;
    assert(row, "the registry has no cell-config removal to drive this with");
    await Deno.mkdir(`${dir}/src`, { recursive: true });
    await Deno.writeTextFile(
      `${dir}/src/app.ts`,
      `import { cell } from "aio";\n` +
        `export const c = cell("c", {\n  ${row.key}: {},\n  state: { n: 0 },\n});\n`,
    );
    await Deno.writeTextFile(`${dir}/deno.json`, JSON.stringify({ name: "x" }));

    const direct = await scanMigrations(dir, undefined);
    assertEquals(direct.length, 1, JSON.stringify(direct));
    assertEquals(direct[0]!.key, row.key);
    assertEquals(direct[0]!.line, 3);
    assertEquals(direct[0]!.file, "src/app.ts");

    const r = await am(["migrate", "--json"], dir);
    assertEquals(
      r.code,
      1,
      "a report that exits 0 is one a pipeline scrolls past",
    );
    const j = JSON.parse(r.out) as {
      findings: { hint: string; guide: string }[];
    };
    assertEquals(j.findings.length, 1);
    // The finding is only worth producing if it says what to DO.
    assertEquals(j.findings[0]!.hint, row.hint);
    assertEquals(j.findings[0]!.guide, row.guide);
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("--from hides what was already migrated", async () => {
  const dir = await tempDir("am-migrate-from-");
  try {
    const row = REMOVALS.find((r) => r.kind === "cell-config")!;
    await Deno.mkdir(`${dir}/src`, { recursive: true });
    await Deno.writeTextFile(
      `${dir}/src/app.ts`,
      `import { cell } from "aio";\nexport const c = cell("c", {\n  ${row.key}: {},\n});\n`,
    );
    // Asking "what changed after the release that removed it" must be silent
    // about it — that is the entire meaning of --from.
    assertEquals(await scanMigrations(dir, row.removedIn), []);
    assertEquals((await scanMigrations(dir, undefined)).length, 1);
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("someone else's code is not the app's problem", async () => {
  const dir = await tempDir("am-migrate-skip-");
  try {
    const row = REMOVALS.find((r) => r.kind === "cell-config")!;
    const bad = `export const c = cell("c", {\n  ${row.key}: {},\n});\n`;
    for (const sub of ["node_modules", "dist", "dep", ".aio"]) {
      await Deno.mkdir(`${dir}/${sub}`, { recursive: true });
      await Deno.writeTextFile(`${dir}/${sub}/x.ts`, bad);
    }
    assertEquals(
      await scanMigrations(dir, undefined),
      [],
      "a hit in a dependency or a build product is not something the reader " +
        "can act on, and burying the real findings under them is how a report " +
        "stops being read",
    );
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("a type member named like a retired key is not a migration", async () => {
  // Found by running the command on a real tree. `removalsInSource` has a
  // documented contract — with no `cell(` in the text it treats every line as
  // cell config, because `aiol` hands it an already-extracted config block —
  // and whole files are not that. Read that way it reported
  // `{ seed: number; actions: string[] }` and `perf: { reduce: 0.4 }` as
  // retired cell keys.
  //
  // A migration report full of things that are not migrations is one nobody
  // finishes reading, and then the real row goes unread with them.
  const dir = await tempDir("am-migrate-fp-");
  try {
    const row = REMOVALS.find((r) => r.kind === "cell-config")!;
    await Deno.mkdir(`${dir}/src`, { recursive: true });
    await Deno.writeTextFile(
      `${dir}/src/types.ts`,
      `export type Perf = { ${row.key}: number };\n` +
        `export const p: Perf = { ${row.key}: 0.4 };\n`,
    );
    assertEquals(
      await scanMigrations(dir, undefined),
      [],
      `"${row.key}" in a file that declares no cell is an ordinary property`,
    );

    // …and the same key in a file that DOES declare a cell is still found, so
    // the narrowing did not simply switch the check off.
    await Deno.writeTextFile(
      `${dir}/src/cell.ts`,
      `import { cell } from "aio";\n` +
        `export const c = cell("c", {\n  ${row.key}: {},\n});\n`,
    );
    const hits = await scanMigrations(dir, undefined);
    assertEquals(hits.length, 1, JSON.stringify(hits));
    assertEquals(hits[0]!.file, "src/cell.ts");
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("a hit in a test is MARKED, not counted as work", async () => {
  // An app's own upgrade test feeds the old shape on purpose. The registry
  // already draws this line for `am pin` (warn, not refuse), and drawing it
  // differently here would be two deciders for one fact.
  const dir = await tempDir("am-migrate-fixture-");
  try {
    const row = REMOVALS.find((r) => r.kind === "cell-config")!;
    await Deno.mkdir(`${dir}/tests`, { recursive: true });
    await Deno.writeTextFile(
      `${dir}/tests/upgrade.test.ts`,
      `import { cell } from "aio";\nconst old = cell("c", { ${row.key}: {} });\n`,
    );
    const hits = await scanMigrations(dir, undefined);
    assertEquals(
      hits.length,
      1,
      "it is still REPORTED — marking is not hiding",
    );
    assertEquals(hits[0]!.fixture, true);
  } finally {
    await dropTempDir(dir);
  }
});
