// The removal registry is the ONE record of what aio dropped in 1.x, and these
// tests are what keep it that way.
//
// The failure being prevented is specific and has happened to every framework:
// a key is removed, three surfaces learn to complain about it in their own
// words, and a release later they disagree — the runtime names one migration,
// the linter names another, and the version that still ran the old spelling is
// named nowhere, so the user's only real escape hatch is invisible.
//
// So: every surface that announces a removal MUST read it from
// src/state/removals.ts, and every row MUST carry a pin that actually exists.
// A future removal that skips the registry fails here, not in the field.
import {
  assert,
  assertEquals,
  assertMatch,
  assertStringIncludes,
} from "@std/assert";
import { join } from "@std/path";
import {
  type Removal,
  removalFor,
  removalMessage,
  removalOf,
  REMOVALS,
  removalsUsedBy,
  REMOVED_CELL_KEYS,
} from "../src/state/removals.ts";
import { cell } from "../src/state/cell-create.ts";
import { buildContext } from "../aiol/context.ts";
import { checkCells } from "../aiol/checks.ts";

const cellRows = REMOVALS.filter((r) => r.kind === "cell-config");

// ── the rows themselves ──────────────────────────────────────────────

Deno.test("removals: every row is well-formed and internally consistent", () => {
  assert(REMOVALS.length > 0, "the registry is the record — it is never empty");
  const seen = new Set<string>();
  for (const r of REMOVALS) {
    assert(!seen.has(r.key), `duplicate row for '${r.key}'`);
    seen.add(r.key);
    assertMatch(r.removedIn, /^alpha\d+$/, `${r.key}: removedIn is a series`);
    assertMatch(
      r.lastGood,
      /^v\d+\.\d+\.\d+(-alpha\d+)?$/,
      `${r.key}: lastGood is a tag a user can pass to \`am pin\``,
    );
    // A hint is the migration a user follows, so it has to be a sentence —
    // `length > 0` was satisfied by any single character.
    assert(
      r.hint.trim().split(/\s+/).length >= 3,
      `${r.key}: hint must SAY how to migrate, got ${JSON.stringify(r.hint)}`,
    );
    assertMatch(r.guide, /^docs\/.+\.md$/, `${r.key}: guide is a repo doc`);
  }
});

Deno.test("removals: lastGood is the release BEFORE the removal", () => {
  for (const r of REMOVALS) {
    const removed = Number(r.removedIn.slice("alpha".length));
    const good = Number(/-alpha(\d+)$/.exec(r.lastGood)?.[1] ?? NaN);
    assertEquals(
      good,
      removed - 1,
      `${r.key}: removed in ${r.removedIn}, so the last version that ran it ` +
        `is alpha${removed - 1} — ${r.lastGood} would pin the wrong thing`,
    );
  }
});

Deno.test("removals: every guide named by a row exists", async () => {
  for (const r of REMOVALS) {
    const stat = await Deno.stat(r.guide).catch(() => null);
    assert(stat?.isFile, `${r.key}: guide ${r.guide} does not exist`);
  }
});

Deno.test("removals: the escape-hatch pin is a real tag", async () => {
  const out = await new Deno.Command("git", {
    args: ["tag", "--list"],
    stdout: "piped",
    stderr: "null",
  }).output().catch(() => null);
  const tags = new Set(
    new TextDecoder().decode(out?.stdout ?? new Uint8Array()).trim().split(
      "\n",
    ),
  );
  // A clone with no tags at all is not evidence about the registry.
  if (tags.size <= 1 && !tags.has("v1.0.0-alpha1")) return;
  for (const r of REMOVALS) {
    assert(
      tags.has(r.lastGood),
      `${r.key}: lastGood ${r.lastGood} is not a tag in this repo — ` +
        `\`am pin ${r.lastGood}\` would fail, so the escape hatch is fiction`,
    );
  }
});

// ── the message ──────────────────────────────────────────────────────

Deno.test("removals: the message carries BOTH exits — migrate, or pin", () => {
  for (const r of REMOVALS) {
    const msg = removalMessage(r);
    assertStringIncludes(msg, r.key);
    assertStringIncludes(msg, r.removedIn);
    assertStringIncludes(msg, r.hint);
    assertStringIncludes(msg, r.guide, "the migration exit");
    assertStringIncludes(msg, `am pin ${r.lastGood}`, "the keep-shipping exit");
  }
});

Deno.test("removalOf throws for a key with no row — a guard never no-ops", () => {
  let threw = false;
  try {
    removalOf("neverRemoved");
  } catch (e) {
    threw = true;
    assertStringIncludes(String(e), "removals.ts has no row");
  }
  assert(threw, "a missing row must be loud, not a silently skipped guard");
  assertEquals(removalFor("neverRemoved"), null);
});

// ── surface parity: the runtime ──────────────────────────────────────

Deno.test("removals: cell() rejects every removed key with the registry message", () => {
  for (const r of cellRows) {
    const config = { state: { n: 0 }, [r.key]: {} } as Record<string, unknown>;
    let msg = "";
    try {
      // deno-lint-ignore no-explicit-any
      cell(`removal_${r.key}`, config as any);
    } catch (e) {
      msg = String(e);
    }
    assert(msg, `cell() accepted removed key '${r.key}:'`);
    assertStringIncludes(msg, removalMessage(r, `removal_${r.key}`));
  }
});

Deno.test("removalsUsedBy reports cell-config rows only, in registry order", () => {
  const all = Object.fromEntries(REMOVALS.map((r) => [r.key, {}]));
  assertEquals(
    removalsUsedBy(all).map((r) => r.key),
    cellRows.map((r) => r.key),
    "an API-shape removal is not a cell config key",
  );
  assertEquals(removalsUsedBy({ state: {}, methods: {} }).length, 0);
  assertEquals(REMOVED_CELL_KEYS, cellRows.map((r) => r.key));
});

// ── surface parity: the linter ───────────────────────────────────────

async function lintCell(source: string): Promise<string[]> {
  const dir = await Deno.makeTempDir({ prefix: "aio-removals-" });
  try {
    await Deno.mkdir(join(dir, "src"), { recursive: true });
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({ imports: { aio: "./dep/aio/mod.ts" } }),
    );
    await Deno.writeTextFile(join(dir, "src", "cell.ts"), source);
    const { ctx, report } = await buildContext(dir);
    await checkCells(ctx);
    return report.issues
      .filter((i) => i.severity === "error")
      .map((i) => i.message);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("removals: aiol flags every removed key BEFORE the app boots", async () => {
  for (const r of cellRows) {
    const errors = await lintCell(
      `import { cell } from "aio";\n` +
        `export const demo = cell("demo", {\n` +
        `  state: { n: 0 },\n` +
        `  ${r.key}: {},\n` +
        `  methods: { bump(s: { n: number }) { s.n++ } },\n` +
        `});\n`,
    );
    const hit = errors.find((m) => m.includes(`'${r.key}:'`));
    assert(
      hit,
      `aiol missed removed key '${r.key}:' — got: ${errors.join(" | ")}`,
    );
    assertStringIncludes(hit, `am pin ${r.lastGood}`);
    assertStringIncludes(hit, r.guide);
  }
});

Deno.test("removals: aiol stays quiet on a current-style cell", async () => {
  const errors = await lintCell(
    `import { cell } from "aio";\n` +
      `export const demo = cell("demo", {\n` +
      `  state: { n: 0 },\n` +
      `  methods: { bump(s: { n: number }) { s.n++ } },\n` +
      `});\n`,
  );
  assertEquals(
    errors.filter((m) => m.includes("was removed in")),
    [],
    "a modern cell must not be accused of using a removed key",
  );
});

// ── the gate: no surface may invent its own removal message ──────────

/** Source with comments stripped — prose ABOUT a removal is fine; a MESSAGE
 *  printed to a user is what must come from the registry. */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.replace(/(^|[^:"'`\\])\/\/.*$/, "$1"))
    .join("\n");
}

async function tsFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  for await (const e of Deno.readDir(root)) {
    const p = join(root, e.name);
    if (e.isDirectory) out.push(...await tsFiles(p));
    else if (e.name.endsWith(".ts") || e.name.endsWith(".tsx")) out.push(p);
  }
  return out;
}

Deno.test("removals: no file announces a removal in its own words", async () => {
  // "removed in alpha27", "removed in v1.2" — a removal tied to a version is a
  // registry fact. Unversioned prose ("removed in compaction") is not.
  const ANNOUNCE = /removed in\s+(the\s+)?(alpha\d+|v?\d+\.\d+)/i;
  const REGISTRY = "src/state/removals.ts";
  const offenders: string[] = [];
  for (const root of ["src", "aiol"]) {
    for (const file of await tsFiles(root)) {
      if (file === REGISTRY) continue;
      const body = code(await Deno.readTextFile(file));
      if (!ANNOUNCE.test(body)) continue;
      // Reading the registry is exactly right; restating it is not.
      if (body.includes("removals.ts")) continue;
      offenders.push(file);
    }
  }
  assertEquals(
    offenders,
    [],
    `these files state a version-scoped removal without sourcing it from ` +
      `${REGISTRY} — add a row and print removalMessage(), so the migration ` +
      `and the \`am pin\` escape hatch stay identical on every surface`,
  );
});

/** Every removal 1.x has ever made, frozen. The registry is the only record of
 *  these facts, so it cannot also be the only witness that a fact went missing:
 *  drop a row and the key silently stops being explained, which is the exact
 *  regression this file exists to prevent. Rows are APPEND-ONLY within 1.x —
 *  add here when you add there; never delete. (Same contract as api-snapshot.) */
const EVER_REMOVED: readonly string[] = [
  "aio.run(initialState, config)",
  "actions",
  "reduce",
  "execute",
  "machine",
  "generators",
  "call({ timeout })",
  "useCell()",
  // alpha70 — the last breaking release: one import path per symbol.
  'import { createDB } from "aio/db"',
  'import { shipApp } from "aio/build"',
  'import { appDirs } from "aio/testing"',
  'import { installUpdatesRuntime } from "aio/testing"',
  'import { testComponent } from "aio/air"',
  'import { testCell } from "aio"',
  'lint() from "aio/extras"',
  "testgen()",
  "memory.gcStressRatio",
  "aio.run({ appVersion })",
];

Deno.test("removals: no row is ever deleted — the record is append-only", () => {
  const keys = new Set(REMOVALS.map((r) => r.key));
  const lost = EVER_REMOVED.filter((k) => !keys.has(k));
  assertEquals(
    lost,
    [],
    "these removals lost their row — an app hitting them would get no " +
      "migration and no pin to fall back to. Restore them (and if a key came " +
      "BACK as real API in 1.x, that is a public-surface change: say so in " +
      "the changelog and delete it from EVER_REMOVED deliberately).",
  );
});

Deno.test("removals: every registry row is reachable from a real surface", () => {
  // A row nobody consumes is documentation pretending to be a gate.
  // An empty registry would make "every row is reachable" trivially true —
  // and the registry going empty is exactly the regression this guards.
  assert(
    REMOVALS.length > 0,
    "the removals registry is empty — nothing was checked",
  );
  for (const r of REMOVALS as readonly Removal[]) {
    assertEquals(
      removalOf(r.key),
      r,
      `${r.key}: rows are looked up by key — keep them unique and stable`,
    );
  }
});
