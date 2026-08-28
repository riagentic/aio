// The public entry surface is ONE fact, and everything that restates it must
// agree with the manifest.
//
// It was restated four times — `deno.json` `exports` (published truth),
// `deno.json` `imports` (this repo's self-alias), `frameworkSpecs()` (the map
// every scaffolded app gets), and `AIO_ENTRIES` in `aiol/checks.ts` (what the
// linter believes exists) — and three of them were stale. `aio/build` is a
// published entry that docs/build/targets.md and docs/persistence/sqlite.md
// both tell you to import (`dbWorkerInclude`, `compileArgs`, `assetIncludes`),
// and an app that followed them got:
//   ✗ ERROR [imports] "aio/build" is not an aio entry point …
// from the project's own linter, no mapping from the scaffold, and no fix from
// either. The tooling told the author a documented entry did not exist.
//
// The list now lives once in `src/entries.ts`. These tests bind it to the
// manifest in BOTH directions, so publishing a new entry without classifying it
// is a red gate rather than a half-published specifier.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  AIO_ENTRY_PATHS,
  AIO_LIBRARY_ENTRIES,
  AIO_RUN_ONLY_ENTRIES,
  entryExportKey,
} from "../src/entries.ts";
import { frameworkSpecs } from "../src/am/am-cmd-create.ts";
import { buildContext } from "../aiol/context.ts";
import { checkImports } from "../aiol/checks.ts";

const ROOT = new URL("../", import.meta.url);

async function denoJson(): Promise<{
  exports: Record<string, string>;
  imports: Record<string, string>;
}> {
  return JSON.parse(await Deno.readTextFile(new URL("deno.json", ROOT)));
}

Deno.test("entries: src/entries.ts and deno.json exports name the same entries", async () => {
  const cfg = await denoJson();
  const fromManifest = Object.keys(cfg.exports).sort();
  const fromList = Object.keys(AIO_ENTRY_PATHS).map(entryExportKey).sort();
  assertEquals(
    fromList,
    fromManifest,
    "src/entries.ts must mirror deno.json's exports map exactly — a new " +
      "export has to be classified (library vs run-only) or it ships as a " +
      "specifier no scaffold maps and no linter recognises",
  );
});

Deno.test("entries: every entry's path is the module deno.json publishes", async () => {
  const cfg = await denoJson();
  for (const [spec, path] of Object.entries(AIO_ENTRY_PATHS)) {
    assertEquals(
      cfg.exports[entryExportKey(spec)],
      `./${path}`,
      `${spec}: src/entries.ts and deno.json exports disagree on the module`,
    );
    // …and the module has to exist, or the entry is a promise with nothing
    // behind it.
    await Deno.stat(new URL(path, ROOT));
  }
});

Deno.test("entries: the scaffold maps every importable entry (both modes)", () => {
  for (const source of [true, false]) {
    const fw = frameworkSpecs(source);
    // The entry set must be NON-EMPTY, or every check below it is skipped and
    // this test reports a clean surface for a scaffold it never looked at.
    assert(
      Object.keys(AIO_LIBRARY_ENTRIES).length > 1,
      "no library entries to check — the parity claim would be vacuous",
    );
    for (const spec of Object.keys(AIO_LIBRARY_ENTRIES)) {
      assert(
        fw.imports[spec],
        `frameworkSpecs(${source}) does not map "${spec}" — an app that ` +
          `follows the docs gets "not a dependency and not in import map", ` +
          `which never says the mapping is simply missing`,
      );
    }
    // Run-only entries are `deno run` targets (tasks), never import-map keys.
    for (const spec of AIO_RUN_ONLY_ENTRIES) {
      assert(
        !(spec in fw.imports),
        `frameworkSpecs(${source}) maps "${spec}", a deno-run-only entry`,
      );
    }
  }
});

Deno.test("entries: this repo's own import map carries every importable entry", async () => {
  const cfg = await denoJson();
  const missing = Object.keys(AIO_LIBRARY_ENTRIES).filter((s) =>
    !(s in cfg.imports)
  );
  assertEquals(
    missing,
    [],
    "deno.json's `imports` is how docs snippets, examples and tests in THIS " +
      "repo resolve the public specifiers — an entry missing here cannot be " +
      "exercised by the repo that publishes it",
  );
});

// ── the docs are an INDEPENDENT authority on what is importable ──────────

async function* markdown(dir: URL): AsyncGenerator<URL> {
  for await (const e of Deno.readDir(dir)) {
    // upgrade/specs/release-notes are historical: they deliberately name
    // specifiers that no longer exist.
    if (["upgrade", "specs", "release-notes", "api-ref"].includes(e.name)) {
      continue;
    }
    const child = new URL(e.isDirectory ? `${e.name}/` : e.name, dir);
    if (e.isDirectory) yield* markdown(child);
    else if (e.name.endsWith(".md")) yield child;
  }
}

Deno.test("entries: every `aio/…` specifier the docs tell you to import is importable", async () => {
  // This is the check that does NOT derive from src/entries.ts, so a
  // misclassification there (marking a real, importable entry "run-only")
  // cannot hide behind it. `aio/build` was exactly that: two pages import
  // dbWorkerInclude / compileArgs / assetIncludes from it, and every piece of
  // tooling believed it was not an entry point at all.
  const offenders: string[] = [];
  for await (const doc of markdown(new URL("docs/", ROOT))) {
    const text = await Deno.readTextFile(doc);
    for (const m of text.matchAll(/from\s+["'](aio\/[\w./-]+)["']/g)) {
      const spec = m[1]!;
      if (spec in AIO_LIBRARY_ENTRIES) continue;
      const line = text.slice(0, m.index).split("\n").length;
      offenders.push(
        `${doc.pathname.split("/docs/")[1]}:${line} imports "${spec}"` +
          (spec in AIO_ENTRY_PATHS
            ? " — classified run-only in src/entries.ts, but the docs import it"
            : " — no such entry in deno.json exports"),
      );
    }
  }
  assertEquals(
    offenders,
    [],
    "documented imports must resolve:\n  " + offenders.join("\n  "),
  );
});

// ── the linter must not deny a real entry ────────────────────────────────

async function importIssues(
  imports: Record<string, string>,
  source: string,
): Promise<{ severity: string; message: string; fix?: string }[]> {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(dir, "src"), { recursive: true });
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({ imports }),
    );
    await Deno.writeTextFile(join(dir, "src", "cell.ts"), source);
    const { ctx, report } = await buildContext(dir);
    await checkImports(ctx);
    return report.issues.filter((i) => i.area === "imports");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("aiol: a published entry is never reported as 'not an aio entry point'", async () => {
  const scaffold = frameworkSpecs(true).imports;
  // Deliberately the 4-key map an older scaffold wrote: every other entry is
  // UNMAPPED, so the linter must offer the mapping — never deny the entry.
  const OLD_SCAFFOLD = {
    "aio": "./dep/aio/mod.ts",
    "aio/air": "./dep/aio/src/air.ts",
    "aio/jsx-runtime": "./dep/aio/src/jsx-runtime.ts",
    "aio/testing": "./dep/aio/src/cell-test.ts",
  } as Record<string, string>;
  // Non-empty, or every check below is skipped and this reports a clean
  // surface for a set it never looked at.
  assert(
    Object.keys(AIO_LIBRARY_ENTRIES).length > 1,
    "no library entries to check — the claim would be vacuous",
  );
  for (const spec of Object.keys(AIO_LIBRARY_ENTRIES)) {
    if (spec === "aio") continue; // bare specifier — not an `aio/…` subpath
    const issues = await importIssues(
      OLD_SCAFFOLD,
      `import * as x from "${spec}";\nexport const y = x;\n`,
    );
    const denied = issues.find((i) =>
      i.message.includes("is not an aio entry point")
    );
    assertEquals(
      denied,
      undefined,
      `aiol denies the published entry "${spec}": ${denied?.message}`,
    );
    if (spec in OLD_SCAFFOLD) continue; // already mapped — nothing to report
    const issue = issues[0];
    assert(issue, `aiol said nothing about the unmapped entry "${spec}"`);
    assert(
      issue.fix?.includes(spec),
      `aiol must hand back the mapping for "${spec}"; got: ${issue.fix}`,
    );
    // and the fix it hands back is the mapping the scaffold would have written
    assert(
      issue.fix!.includes(AIO_LIBRARY_ENTRIES[spec]!),
      `the offered fix must point at ${
        AIO_LIBRARY_ENTRIES[spec]
      }: ${issue.fix}`,
    );
    assert(scaffold[spec], `and the scaffold maps ${spec}`);
  }
});
