// `cell({ diagnostics: false })` — the key that means what `persist` does not.
//
// A field report read `persist: "none"` as also keeping the cell out of
// `logs/actions.jsonl` (report 2 §7). It does not, and the refusal in
// `feedback/refused.md` says why: `persist` is about the STATE STORE, the
// journal is a dev diagnostic that is off in production and lives in the app's
// own data directory, and making one key silently mean two things is worse
// than the surprise. What was owed was a separate, explicitly named option.
//
// THE BOUNDARY IS THE WHOLE DESIGN, so it is what these tests pin:
//   in   — the action journal, the state-diff debug log, the checkpoint's
//          recentActions, `am timeline`
//   out  — the DURABILITY journal (`journal: true`), which is how committed
//          actions are replayed; dropping a cell from it would be data loss
//          dressed as a privacy feature
//   out  — persistence, which is `persist`'s job and stays that way
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { aio, cell } from "../mod.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { freePort } from "../src/testing/server-test.ts";
import {
  isDiagnosticsOptOut,
  resetDiagnosticsOptOut,
  setDiagnosticsOptOut,
} from "../src/diagnostics/diagnostics-optout.ts";

Deno.test("the registry answers about a CELL, never about the framework", () => {
  try {
    setDiagnosticsOptOut(["vault"]);
    assertEquals(isDiagnosticsOptOut("vault:unlock"), true);
    assertEquals(isDiagnosticsOptOut("vault:__set"), true);
    assertEquals(isDiagnosticsOptOut("other:unlock"), false);
    // No colon = no cell. Framework-level actions are the entries that explain
    // what happened AROUND the excluded ones; widening the opt-out to them
    // would hide exactly the context that makes the rest readable.
    assertEquals(isDiagnosticsOptOut("boot"), false);
    assertEquals(isDiagnosticsOptOut(":weird"), false);
    // A prefix is not a cell name.
    assertEquals(isDiagnosticsOptOut("vaults:unlock"), false);
  } finally {
    resetDiagnosticsOptOut();
  }
});

Deno.test("it REPLACES, so a second app in one process starts clean", () => {
  try {
    setDiagnosticsOptOut(["a"]);
    setDiagnosticsOptOut(["b"]);
    assertEquals(isDiagnosticsOptOut("a:m"), false);
    assertEquals(isDiagnosticsOptOut("b:m"), true);
  } finally {
    resetDiagnosticsOptOut();
  }
});

Deno.test("an empty registry costs nothing and excludes nothing", () => {
  resetDiagnosticsOptOut();
  assertEquals(isDiagnosticsOptOut("anything:at-all"), false);
});

Deno.test("cell() accepts the key and carries it to the cell record", () => {
  const quiet = cell("quietcell", {
    state: { n: 0 },
    diagnostics: false,
    methods: {
      bump(s: { n: number }) {
        s.n++;
      },
    },
    // deno-lint-ignore no-explicit-any
  } as any);
  const loud = cell("loudcell", {
    state: { n: 0 },
    methods: {
      bump(s: { n: number }) {
        s.n++;
      },
    },
    // deno-lint-ignore no-explicit-any
  } as any);
  // deno-lint-ignore no-explicit-any
  assertEquals((quiet as any).__aio.diagnostics, false);
  // Absent, not `true` — the key has exactly one meaningful value, and a cell
  // that never mentions it must be indistinguishable from before it existed.
  // deno-lint-ignore no-explicit-any
  assertEquals((loud as any).__aio.diagnostics, undefined);
});

Deno.test("an unknown cell key is still refused — this one is not a hole", () => {
  let threw = "";
  try {
    cell("bogus", {
      state: { n: 0 },
      diagnostix: false, // a typo of the new key
      methods: {},
      // deno-lint-ignore no-explicit-any
    } as any);
  } catch (e) {
    threw = e instanceof Error ? e.message : String(e);
  }
  assert(
    threw.length > 0,
    "adding a valid key must not turn the config validator permissive",
  );
  assertStringIncludes(threw, "diagnostix");
});

Deno.test("an opted-out cell's actions stay out of actions.jsonl", async () => {
  const dir = await tempDir("diag-optout-");
  const port = freePort();
  const quiet = cell("vaultq", {
    state: { unlocked: false },
    diagnostics: false,
    methods: {
      unlock(s: { unlocked: boolean }, _passphrase: string) {
        s.unlocked = true;
      },
    },
    // deno-lint-ignore no-explicit-any
  } as any);
  const loud = cell("ledgerq", {
    state: { n: 0 },
    methods: {
      add(s: { n: number }) {
        s.n++;
      },
    },
    // deno-lint-ignore no-explicit-any
  } as any);
  const app = await aio.run({
    cells: [quiet, loud],
    appId: `diagoptout-${Deno.pid}`,
    client: "server-only",
    persist: false,
    libraryMode: true,
    singleton: false,
    port,
    baseDir: dir,
    diagnostics: { dev: { actionLog: true } },
    // deno-lint-ignore no-explicit-any
  } as any);
  try {
    // deno-lint-ignore no-explicit-any
    await (quiet as any).unlock("hunter2");
    // deno-lint-ignore no-explicit-any
    await (loud as any).add();
    await new Promise((r) => setTimeout(r, 200));
  } finally {
    await app.close();
  }
  // Find the log wherever this app put it.
  let text = "";
  const walk = async (d: string) => {
    for await (const e of Deno.readDir(d)) {
      const full = `${d}/${e.name}`;
      if (e.isDirectory) await walk(full);
      else if (e.name === "actions.jsonl") {
        text += await Deno.readTextFile(full);
      }
    }
  };
  try {
    await walk(dir);
  } catch {
    /* aio-ok: no log directory means no log, which the asserts cover */
  }
  try {
    assert(
      text.includes("ledgerq:"),
      `the ordinary cell must still be recorded, or this test proves only ` +
        `that the log is empty: ${text.slice(0, 300)}`,
    );
    assertEquals(
      text.includes("vaultq:"),
      false,
      `the opted-out cell reached the on-disk journal: ${text.slice(0, 300)}`,
    );
    assertEquals(
      text.includes("hunter2"),
      false,
      "the payload reached disk — which is the entire point of the key",
    );
  } finally {
    await dropTempDir(dir);
  }
});
