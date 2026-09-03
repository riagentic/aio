// The contract document must name the surface it governs.
//
// `docs/basics/semver-policy.md` is THE promise — what counts as breaking, and
// over which symbols. Its list of entry points named `aio/schedule` and
// `aio/selectors`, both DELETED in alpha52, and omitted thirteen real ones,
// `aio/ui` among them: sixty-four symbols, the entire component library,
// governed by a contract that did not mention them. Nobody noticed for six
// alphas, because prose has no compiler.
//
// `src/entries.ts` is the one list (`tests/entry-surface-parity.test.ts`
// already pins it against `deno.json`'s `exports` map, in both directions).
// This adds the third reader: the document. (audit a16/8)
import { assertEquals } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { AIO_ENTRY_PATHS, AIO_RUN_ONLY_ENTRIES } from "../src/entries.ts";

const POLICY = fromFileUrl(
  new URL("../docs/basics/semver-policy.md", import.meta.url),
);

/** The `| \`aio/x\` | … |` rows of the entry-point table, in document order. */
async function documentedEntries(): Promise<string[]> {
  const text = await Deno.readTextFile(POLICY);
  const rows = [...text.matchAll(/^\s*\|\s*`(aio(?:\/[a-z-]+)*)`\s*\|/gm)];
  return rows.map((m) => m[1]!);
}

Deno.test("semver policy: the entry table is exactly src/entries.ts, in order", async () => {
  assertEquals(
    await documentedEntries(),
    Object.keys(AIO_ENTRY_PATHS),
    "docs/basics/semver-policy.md names a different set (or order) of entry " +
      "points than src/entries.ts. The document is the CONTRACT: an entry it " +
      "omits is a published surface nothing promises, and an entry it invents " +
      "is a promise about nothing. Fix the table from src/entries.ts.",
  );
});

Deno.test("semver policy: every run-only entry is marked run-only", async () => {
  // The table's second column is what an app is being told it can import. A
  // run-only entry (`aio/am`, `aio/doctor`, …) exports nothing to import, and
  // a row that described one as a library would send a reader looking for
  // symbols that do not exist.
  const text = await Deno.readTextFile(POLICY);
  const missing: string[] = [];
  for (const spec of AIO_RUN_ONLY_ENTRIES) {
    const row = new RegExp(`^\\s*\\|\\s*\`${spec}\`\\s*\\|(.*)\\|`, "m").exec(
      text,
    );
    if (!row) {
      missing.push(`${spec}: no row at all`);
    } else if (!row[1]!.includes("run-only")) {
      missing.push(`${spec}: row does not say run-only — "${row[1]!.trim()}"`);
    }
  }
  assertEquals(missing, []);
});

Deno.test("semver policy: the check can fail — a deleted entry would be caught", async () => {
  // The instrument, verified. `aio/schedule` is the entry that sat in this
  // document for six alphas after it was deleted; if the parser cannot see a
  // row, it cannot see a wrong one either.
  const rows = await documentedEntries();
  assertEquals(rows.includes("aio/schedule"), false);
  assertEquals(rows.includes("aio/selectors"), false);
  assertEquals(rows.length > 20, true, "the table parser found almost nothing");
  assertEquals(rows.includes("aio/ui"), true);
});
