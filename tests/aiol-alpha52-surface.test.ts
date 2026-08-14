// aiol — alpha52 surface-diet rules + safe-fixes (Package 4).
//
// Every break ships with its migration: the rule NAMES the finding pre-boot
// and `--safe-fix` applies the mechanical rewrite. Each fix is verified on
// file CONTENT (what it rewrote), not just on the fix's return value.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { buildContext } from "../aiol/context.ts";
import {
  checkAlpha52Surface,
  checkUpgrade,
  checkUseCell,
} from "../aiol/checks.ts";
import type { Issue } from "../aiol/types.ts";

async function withProject(
  files: Record<string, string>,
  denoJson: Record<string, unknown>,
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(dir, "src"), { recursive: true });
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({
        imports: { "aio": "jsr:@riagentic/aio@1.0.0" },
        ...denoJson,
      }),
    );
    for (const [rel, content] of Object.entries(files)) {
      await Deno.writeTextFile(join(dir, rel), content);
    }
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

async function surfaceIssues(dir: string): Promise<Issue[]> {
  const { ctx, report } = await buildContext(dir);
  await checkAlpha52Surface(ctx);
  return report.issues;
}

async function applyFix(issues: Issue[], needle: string, dir: string) {
  const issue = issues.find((i) => i.message.includes(needle));
  assert(issue, `an issue matching "${needle}" exists`);
  assert(issue.safeFix, `issue "${needle}" carries a safeFix`);
  assert(await issue.safeFix(dir), "the fix applied a change");
}

// ═════════════════════════════════════════════════════════════════════
// cell `ui:` → `visible:`
// ═════════════════════════════════════════════════════════════════════

const UI_CELL = `import { cell } from "aio";
export const todo = cell("todo", {
  state: { items: [], ui: { theme: "dark" } },
  methods: {
    add(s: { items: string[] }, t: string) { s.items.push(t); },
  },
  ui: { exclude: ["items"] },
});
`;

Deno.test("aiol alpha52: cell ui: key reported + safe-fix renames it (nested `ui` field untouched)", async () => {
  await withProject(
    { "src/cell.ts": UI_CELL, "src/app.ts": "" },
    {},
    async (dir) => {
      const issues = await surfaceIssues(dir);
      await applyFix(issues, "renamed `visible:`", dir);
      const out = await Deno.readTextFile(join(dir, "src", "cell.ts"));
      assert(out.includes(`visible: { exclude: ["items"] }`), out);
      // the STATE field named ui (nested, depth 2) is untouched
      assert(out.includes(`state: { items: [], ui: { theme: "dark" } }`), out);
      // fixed project is clean
      const after = await surfaceIssues(dir);
      assertEquals(
        after.filter((i) => i.message.includes("renamed `visible:`")),
        [],
      );
    },
  );
});

Deno.test("aiol alpha52: cellDefaults.ui reported + renamed", async () => {
  const APP = `import { aio } from "aio";
await aio.run({
  appId: "x",
  cellDefaults: { ui: "none", persist: "all" },
});
`;
  await withProject({ "src/app.ts": APP }, {}, async (dir) => {
    const issues = await surfaceIssues(dir);
    await applyFix(issues, "cellDefaults", dir);
    const out = await Deno.readTextFile(join(dir, "src", "app.ts"));
    assert(
      out.includes(`cellDefaults: { visible: "none", persist: "all" }`),
      out,
    );
  });
});

// ═════════════════════════════════════════════════════════════════════
// deleted entries: aio/schedule + aio/selectors
// ═════════════════════════════════════════════════════════════════════

Deno.test("aiol alpha52: dead specifiers reported + rewritten PER SYMBOL (aio vs aio/extras)", async () => {
  const SRC = `import { isScheduleEffect, schedule } from "aio/schedule";
import { createSelector } from "aio/selectors";
export const x = [schedule, isScheduleEffect, createSelector];
`;
  await withProject(
    { "src/lib.ts": SRC, "src/app.ts": "" },
    { imports: { "aio": "jsr:@riagentic/aio@1.0.0" } },
    async (dir) => {
      const issues = await surfaceIssues(dir);
      assert(
        issues.some((i) =>
          i.severity === "error" && i.message.includes("aio/schedule")
        ),
        "aio/schedule reported as deleted",
      );
      await applyFix(issues, "aio/schedule", dir);
      const out = await Deno.readTextFile(join(dir, "src", "lib.ts"));
      assert(out.includes(`import { schedule } from "aio";`), out);
      assert(
        out.includes(`import { isScheduleEffect } from "aio/extras";`),
        out,
      );
      assert(out.includes(`import { createSelector } from "aio";`), out);
      assert(!out.includes("aio/schedule"), out);
      assert(!out.includes("aio/selectors"), out);
    },
  );
});

// ═════════════════════════════════════════════════════════════════════
// key-default MIGRATION: exposed + no auth + no key → insert key: false
// ═════════════════════════════════════════════════════════════════════

Deno.test("aiol alpha52: exposed app with no key gets the behaviour-preserving key: false", async () => {
  const APP = `import { aio } from "aio";
await aio.run({
  appId: "open-app",
  expose: true,
});
`;
  await withProject(
    { "src/app.ts": APP },
    { imports: { "aio": "jsr:@riagentic/aio@1.0.0-alpha51" } },
    async (dir) => {
      const issues = await surfaceIssues(dir);
      await applyFix(issues, "generates a persisted shared", dir);
      const out = await Deno.readTextFile(join(dir, "src", "app.ts"));
      assert(out.includes("key: false,"), out);
      assert(out.includes("pre-alpha52"), "comment explains the pin");
      // fixed project is clean
      const after = await surfaceIssues(dir);
      assertEquals(
        after.filter((i) => i.message.includes("generates a persisted shared")),
        [],
      );
    },
  );
});

Deno.test("aiol alpha52: task --expose (no config expose) also triggers the key migration", async () => {
  const APP = `import { aio } from "aio";
await aio.run({ appId: "open-app" });
`;
  await withProject(
    { "src/app.ts": APP },
    {
      imports: { "aio": "jsr:@riagentic/aio@1.0.0-alpha51" },
      tasks: { serve: "deno run -A src/app.ts --expose" },
    },
    async (dir) => {
      const issues = await surfaceIssues(dir);
      assert(
        issues.some((i) => i.message.includes("generates a persisted shared")),
      );
    },
  );
});

Deno.test("aiol alpha52: an alpha52+ pin does NOT get the key migration (safe by default)", async () => {
  const APP = `import { aio } from "aio";
await aio.run({ appId: "x", expose: true });
`;
  await withProject(
    { "src/app.ts": APP },
    { imports: { "aio": "jsr:@riagentic/aio@1.0.0-alpha52" } },
    async (dir) => {
      const issues = await surfaceIssues(dir);
      assertEquals(
        issues.filter((i) =>
          i.message.includes("generates a persisted shared")
        ),
        [],
      );
    },
  );
});

Deno.test("aiol alpha52: per-user auth or explicit key → NO key migration", async () => {
  const AUTH_APP = `import { aio } from "aio";
await aio.run({ appId: "x", expose: true, users: { t: { id: "u", role: "admin" } } });
`;
  await withProject(
    { "src/app.ts": AUTH_APP },
    { imports: { "aio": "jsr:@riagentic/aio@1.0.0-alpha51" } },
    async (dir) => {
      const issues = await surfaceIssues(dir);
      assertEquals(
        issues.filter((i) =>
          i.message.includes("generates a persisted shared")
        ),
        [],
      );
    },
  );
  const KEYED = `import { aio } from "aio";
await aio.run({ appId: "x", expose: true, key: true });
`;
  await withProject(
    { "src/app.ts": KEYED },
    { imports: { "aio": "jsr:@riagentic/aio@1.0.0-alpha51" } },
    async (dir) => {
      const issues = await surfaceIssues(dir);
      assertEquals(
        issues.filter((i) =>
          i.message.includes("generates a persisted shared")
        ),
        [],
      );
    },
  );
});

// ═════════════════════════════════════════════════════════════════════
// access-without-visible: the boot refusal, pre-boot
// ═════════════════════════════════════════════════════════════════════

const ACCESS_CELL = `import { cell } from "aio";
export const admin = cell("admin", {
  state: { rows: [] },
  methods: {},
  access: "admin",
});
`;

Deno.test("aiol alpha52: access-no-visible is an ERROR on an exposed app, with the one-word fix", async () => {
  const APP = `import { aio } from "aio";
await aio.run({ appId: "x", expose: true, key: true });
`;
  await withProject(
    { "src/cell.ts": ACCESS_CELL, "src/app.ts": APP },
    {},
    async (dir) => {
      const issues = await surfaceIssues(dir);
      const hit = issues.find((i) =>
        i.severity === "error" && i.message.includes("REFUSES to boot")
      );
      assert(hit, "reported as error");
      assert(hit!.fix?.includes('visible: "all"'), hit!.fix);
    },
  );
});

Deno.test("aiol alpha52: access-no-visible on a loopback single-user app is NOT the refusal", async () => {
  const APP = `import { aio } from "aio";
await aio.run({ appId: "x" });
`;
  await withProject(
    { "src/cell.ts": ACCESS_CELL, "src/app.ts": APP },
    {},
    async (dir) => {
      const issues = await surfaceIssues(dir);
      assertEquals(
        issues.filter((i) => i.message.includes("REFUSES to boot")),
        [],
      );
    },
  );
});

Deno.test("aiol alpha52: access WITH visible on an exposed app is clean", async () => {
  const OK_CELL = `import { cell } from "aio";
export const admin = cell("admin", {
  state: { rows: [] },
  methods: {},
  access: "admin",
  visible: "all",
});
`;
  const APP = `import { aio } from "aio";
await aio.run({ appId: "x", expose: true, key: true });
`;
  await withProject(
    { "src/cell.ts": OK_CELL, "src/app.ts": APP },
    {},
    async (dir) => {
      const issues = await surfaceIssues(dir);
      assertEquals(
        issues.filter((i) => i.message.includes("REFUSES to boot")),
        [],
      );
    },
  );
});

// ═════════════════════════════════════════════════════════════════════
// useCell removal: rule is an ERROR now, safe-fix rewrites the mechanical form
// ═════════════════════════════════════════════════════════════════════

Deno.test("aiol alpha52: useCell reported as REMOVED + mechanical .state.x reads rewritten", async () => {
  const SRC = `import { useCell } from "aio/air";
import { counter } from "./cell.ts";
export function View() {
  const count = useCell(counter).state.count;
  return count;
}
`;
  await withProject(
    { "src/View.ts": SRC, "src/app.ts": "" },
    {},
    async (dir) => {
      const { ctx, report } = await buildContext(dir);
      await checkUseCell(ctx);
      const issue = report.issues.find((i) => i.message.includes("REMOVED"));
      assert(issue, "useCell reported");
      assertEquals(issue!.severity, "error");
      assert(issue!.safeFix, "carries the rewrite");
      assert(await issue!.safeFix!(dir));
      const out = await Deno.readTextFile(join(dir, "src", "View.ts"));
      assert(out.includes("const count = counter.count;"), out);
      // no useCell use remains → the import binding went with it
      assert(!out.includes("useCell"), out);
      assert(out.includes(`import { counter } from "./cell.ts";`), out);
    },
  );
});

// ═════════════════════════════════════════════════════════════════════
// call({ timeout }) is now an ERROR (runtime throws)
// ═════════════════════════════════════════════════════════════════════

Deno.test("aiol alpha52: call({ timeout }) escalated to error (call() now throws)", async () => {
  const SRC = `import { call } from "aio";
export const p = call({ timeout: 5000 }, () => Promise.resolve(1));
`;
  await withProject(
    { "src/lib.ts": SRC, "src/app.ts": "" },
    {},
    async (dir) => {
      const { ctx, report } = await buildContext(dir);
      await checkUpgrade(ctx);
      const issue = report.issues.find((i) =>
        i.message.includes("call({ timeout })")
      );
      assert(issue, "reported");
      assertEquals(issue!.severity, "error");
      assert(issue!.safeFix, "still mechanically fixable");
      assert(await issue!.safeFix!(dir));
      const out = await Deno.readTextFile(join(dir, "src", "lib.ts"));
      assert(out.includes("timeoutMs: 5000"), out);
    },
  );
});

// ═════════════════════════════════════════════════════════════════════
// aio/db went types-only: VALUE imports re-route to aio/server
// ═════════════════════════════════════════════════════════════════════

Deno.test("aiol alpha52: aio/db VALUE import reported + split (types stay on aio/db)", async () => {
  const SRC = `import { createDB, type DB, reactiveDB } from "aio/db";
export const open = (path: string): Promise<DB> => createDB(path);
export const live = reactiveDB;
`;
  await withProject(
    { "src/db.ts": SRC, "src/app.ts": "" },
    {},
    async (dir) => {
      const issues = await surfaceIssues(dir);
      const hit = issues.find((i) =>
        i.message.includes("types + pure helpers")
      );
      assert(hit, "aio/db value import reported");
      assert(hit!.safeFix, "carries the rewrite");
      assert(await hit!.safeFix!(dir));
      const out = await Deno.readTextFile(join(dir, "src", "db.ts"));
      assert(
        out.includes(`import { createDB, reactiveDB } from "aio/server";`),
        out,
      );
      assert(out.includes(`import { type DB } from "aio/db";`), out);
    },
  );
});

Deno.test("aiol alpha52: a type-only aio/db import is NOT flagged", async () => {
  const SRC = `import type { DB, Tx } from "aio/db";
export const x = (db: DB, tx: Tx) => [db, tx];
`;
  await withProject(
    { "src/types.ts": SRC, "src/app.ts": "" },
    {},
    async (dir) => {
      const issues = await surfaceIssues(dir);
      assertEquals(
        issues.filter((i) => i.message.includes("types + pure helpers")),
        [],
      );
    },
  );
});

// ═════════════════════════════════════════════════════════════════════
// GROUND TRUTH under hostile syntax (field regression, alpha52)
//
// A real 33-cell app got 11 of 33 `ui:` findings: the block scanner walked
// RAW text with comment-BLIND string tracking, so one unpaired apostrophe in
// a comment ("don't") swallowed braces until the next quote and whole cells
// were silently skipped — aiol went clean while the runtime kept hinting.
// PRINCIPLE pinned here: after --safe-fix, assert against the FILE (an
// independent grep for the deprecated key), never against the checker's own
// findings — a detector must not be its own referee.
// ═════════════════════════════════════════════════════════════════════

// Modeled on the failure shape: heavy comments with unpaired apostrophes,
// template literals carrying `${…}` and braces, nested objects, a nested
// state field literally named `ui`, and comment/string mentions of `ui:`.
const HOSTILE_CELLS = `import { cell } from "aio";
// The scanner mustn't die on this file — it's the field repro shape.
export const accounts = cell("accounts", {
  state: {
    list: [] as string[],
    // per-account view prefs live under a nested field named ui — keep it!
    prefs: { ui: { theme: "dark" } },
    tpl: \`row \${JSON.stringify({ a: 1 })} { literal brace }\`,
  },
  methods: {
    // don't push twice
    add(s: { list: string[] }, x: string) {
      s.list.push(x);
    },
  },
  ui: { exclude: ["list"] },
});
export const heavy = cell("heavy", {
  state: { rows: [] as number[] },
  methods: {
    // crunch till the cows come home — one stray apostrophe: don't
    crunch(s: { rows: number[] }) {
      s.rows.push(1); // it's fine
    },
  },
  ui: "none",
});
export const bridge = cell("bridge", {
  state: { q: 0 },
  methods: {
    /* block comment with a brace { and a quote " inside */
    tick(s: { q: number }) {
      s.q++;
    },
  },
  ui: { include: ["q"] },
});
// a comment that MENTIONS ui: "all" must not be renamed
export const staking = cell("staking", {
  state: { note: 'contains ui: "all" in a string — not a key' },
  methods: {},
  ui: "all",
});
`;

Deno.test("aiol alpha52: hostile syntax — EVERY ui: cell is found, and the fix leaves zero behind (ground truth)", async () => {
  await withProject(
    { "src/cells.ts": HOSTILE_CELLS, "src/app.ts": "" },
    {},
    async (dir) => {
      const issues = await surfaceIssues(dir);
      const uiFindings = issues.filter((i) =>
        i.message.includes("renamed `visible:`")
      );
      // Ground truth #1: the DETECTOR sees all 4 cells (the field bug was
      // 11-of-33 — a partial count that LOOKS plausible).
      assertEquals(
        uiFindings.length,
        4,
        `expected all 4 cells found, got:\n${
          uiFindings.map((i) => i.message).join("\n")
        }`,
      );
      assert(uiFindings[0]!.safeFix);
      assert(await uiFindings[0]!.safeFix!(dir));
      const out = await Deno.readTextFile(join(dir, "src", "cells.ts"));
      // Ground truth #2: independent of the checker — every cell now carries
      // visible:, and the ONLY remaining `ui` texts are the nested state
      // field, the comment mentions, and the string literal.
      assertEquals((out.match(/\bvisible:/g) ?? []).length, 4, out);
      const residualUi = [...out.matchAll(/\bui:/g)];
      assertEquals(
        residualUi.length,
        3, // nested prefs.ui key + the comment mention + the string literal
        `unexpected residual ui: sites:\n${out}`,
      );
      // …and each residual is one of the intended non-key sites.
      const lines = out.split("\n");
      for (const r of residualUi) {
        const line = lines[out.slice(0, r.index).split("\n").length - 1]!;
        assert(
          line.includes("prefs") || line.trimStart().startsWith("//") ||
            line.includes("MENTIONS") || line.includes("in a string"),
          `residual ui: on a KEY line — the fix missed it: ${line}`,
        );
      }
      // Ground truth #3: a re-lint is clean AND the runtime alias hint has
      // nothing left to fire on (no top-level ui key anywhere).
      const after = await surfaceIssues(dir);
      assertEquals(
        after.filter((i) => i.message.includes("renamed `visible:`")),
        [],
      );
    },
  );
});

Deno.test("aiol alpha52: hostile syntax — the access-without-visible SECURITY gate misses nothing", async () => {
  const CELLS = `import { cell } from "aio";
export const seeds = cell("seeds", {
  state: { words: [] as string[] },
  methods: {
    // the owner's seed phrase mustn't leak — and this apostrophe mustn't
    // blind the scanner to the access key below
    reveal(s: { words: string[] }) {
      s.words.push("x");
    },
  },
  access: "admin",
});
export const hw = cell("hw", {
  state: { path: \`m/44'/501'/\${0}'\` },
  methods: {},
  access: false,
});
`;
  const APP = `import { aio } from "aio";
await aio.run({ appId: "x", expose: true, key: true });
`;
  await withProject(
    { "src/cells.ts": CELLS, "src/app.ts": APP },
    {},
    async (dir) => {
      const issues = await surfaceIssues(dir);
      const hits = issues.filter((i) => i.message.includes("REFUSES to boot"));
      // BOTH cells — an under-count here is a shipped security hole with a
      // green linter.
      assertEquals(
        hits.length,
        2,
        `expected both access-no-visible cells:\n${
          issues.map((i) => i.message).join("\n")
        }`,
      );
    },
  );
});

// ═════════════════════════════════════════════════════════════════════
// --safe-fix exit gating: judged from the POST-fix tree (release review #2)
// ═════════════════════════════════════════════════════════════════════

const AIOL_MOD = new URL("../aiol/mod.ts", import.meta.url).pathname;
const REPO_CONFIG = new URL("../deno.json", import.meta.url).pathname;

async function runAiol(
  dir: string,
  ...flags: string[]
): Promise<{ code: number; out: string }> {
  const r = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "--config", REPO_CONFIG, AIOL_MOD, dir, ...flags],
    stdout: "piped",
    stderr: "piped",
  }).output();
  const dec = new TextDecoder();
  return { code: r.code, out: dec.decode(r.stdout) + dec.decode(r.stderr) };
}

Deno.test("aiol --safe-fix: fixing every error exits 0 (judged post-fix, not pre-fix)", async () => {
  // The one ERROR is fixable (deleted-entry import); everything else is
  // warn/hint, which never gates the exit.
  const SRC = `import { schedule } from "aio/schedule";
export const x = schedule;
`;
  const APP = `import { aio } from "aio";
await aio.run({ appId: "gate", appVersion: "0.1.0" });
`;
  await withProject(
    { "src/lib.ts": SRC, "src/app.ts": APP },
    { version: "0.1.0" },
    async (dir) => {
      const before = await runAiol(dir);
      assertEquals(before.code, 1, "pre-fix: the error gates");
      const fixed = await runAiol(dir, "--safe-fix");
      assertEquals(
        fixed.code,
        0,
        `--safe-fix repaired the only error — exiting 1 anyway punishes a ` +
          `clean fix:\n${fixed.out}`,
      );
      // and the file really was fixed (ground truth, not the exit code)
      const out = await Deno.readTextFile(join(dir, "src", "lib.ts"));
      assert(out.includes(`from "aio";`), out);
    },
  );
});

Deno.test("aiol --safe-fix: a report-only error survives the fixes — exit 1 AND printed", async () => {
  const SRC = `import { schedule } from "aio/schedule";
import { nothing } from "aio/nonexistent";
export const x = [schedule, nothing];
`;
  const APP = `import { aio } from "aio";
await aio.run({ appId: "gate", appVersion: "0.1.0" });
`;
  await withProject(
    { "src/lib.ts": SRC, "src/app.ts": APP },
    { version: "0.1.0" },
    async (dir) => {
      const fixed = await runAiol(dir, "--safe-fix");
      assertEquals(fixed.code, 1, "the unfixable error must keep gating");
      assert(
        fixed.out.includes("aio/nonexistent"),
        `the residual report must stay VISIBLE after fixing:\n${fixed.out}`,
      );
      assert(
        !(await Deno.readTextFile(join(dir, "src", "lib.ts"))).includes(
          "aio/schedule",
        ),
        "the fixable half was still applied",
      );
    },
  );
});

// ═════════════════════════════════════════════════════════════════════
// key migration: the am-created population pins via aioVersion (review #5)
// ═════════════════════════════════════════════════════════════════════

Deno.test("aiol alpha52: an am-created app (dep/aio link + aioVersion alpha51) gets the key migration", async () => {
  const APP = `import { aio } from "aio";
await aio.run({ appId: "open-app", expose: true });
`;
  await withProject(
    { "src/app.ts": APP },
    {
      imports: { "aio": "./dep/aio/mod.ts" },
      aioVersion: "v1.0.0-alpha51",
    },
    async (dir) => {
      const issues = await surfaceIssues(dir);
      assert(
        issues.some((i) => i.message.includes("generates a persisted shared")),
        `aioVersion pin must count — am-created apps are the main ` +
          `population:\n${issues.map((i) => i.message).join("\n")}`,
      );
    },
  );
});

Deno.test("aiol alpha52: aioVersion alpha52+ (or no version anywhere) → no key migration", async () => {
  const APP = `import { aio } from "aio";
await aio.run({ appId: "open-app", expose: true });
`;
  await withProject(
    { "src/app.ts": APP },
    { imports: { "aio": "./dep/aio/mod.ts" }, aioVersion: "v1.0.0-alpha52" },
    async (dir) => {
      const issues = await surfaceIssues(dir);
      assertEquals(
        issues.filter((i) =>
          i.message.includes("generates a persisted shared")
        ),
        [],
      );
    },
  );
  await withProject(
    { "src/app.ts": APP },
    { imports: { "aio": "./dep/aio/mod.ts" } }, // unversioned source checkout
    async (dir) => {
      const issues = await surfaceIssues(dir);
      assertEquals(
        issues.filter((i) =>
          i.message.includes("generates a persisted shared")
        ),
        [],
      );
    },
  );
});

// A finding's line number is the only part a reader acts on. The `+1` here
// compensates for the `\n` the pattern is allowed to start on — but a FIRST
// LINE import matches at index 0, where there is no newline to skip, and was
// reported one line down. An error-severity finding that points at the wrong
// line sends the reader to correct code.
Deno.test("aiol alpha52: a dead-entry import on line 1 is reported as line 1", async () => {
  const FIRST = `import { schedule } from "aio/schedule";
export const x = 1;
`;
  const LATER = `// a comment first
import { schedule } from "aio/schedule";
export const x = 1;
`;
  await withProject(
    { "src/a.ts": FIRST, "src/b.ts": LATER, "src/app.ts": "" },
    {},
    async (dir) => {
      const issues = await surfaceIssues(dir);
      const a = issues.find((i) => i.file === "src/a.ts");
      const b = issues.find((i) => i.file === "src/b.ts");
      assert(a, "the first-line import is found at all");
      assert(b, "the second-line import is found at all");
      assertEquals(a.line, 1, "line 1 is line 1");
      assertEquals(b.line, 2, "and the general case is unchanged");
      // The message carries the same number the issue does — they are read
      // together, so they cannot disagree.
      assert(a.message.includes("src/a.ts:1"), a.message);
      assert(b.message.includes("src/b.ts:2"), b.message);
    },
  );
});

Deno.test("aiol alpha52: an aio/db VALUE import on line 1 is reported as line 1", async () => {
  const FIRST = `import { createDB } from "aio/db";
export const db = createDB;
`;
  await withProject(
    { "src/a.ts": FIRST, "src/app.ts": "" },
    {},
    async (dir) => {
      const issues = await surfaceIssues(dir);
      const a = issues.find((i) =>
        i.file === "src/a.ts" && i.message.includes("aio/db")
      );
      assert(a, "the aio/db value import is found");
      assertEquals(a.line, 1);
      assert(a.message.includes("src/a.ts:1"), a.message);
    },
  );
});
