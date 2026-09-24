// Every budget read in src/ judges by the OWNING app's ledger — never "the
// latest boot's".
//
// `budgetsFor()` with no owner answers "the ledger of the app that called
// `setBudgets` last". That is this app's only while no `await` separates the
// read from this app's `setBudgets`; a second app booting in the same process
// (library mode, `testApps`) sets ITS ledger in any such gap. Persistence read
// it after awaits and judged app A's cells by app B's `cellState`
// (tests/persist-budgets-per-app.test.ts). The vitals pressure monitor read it
// synchronously — correct, but one inserted `await` from the same bug — so it
// now takes the ledger from aio.ts like persistence and the server do: ONE
// mechanism, the owner's ledger handed down explicitly.
import { assert, assertEquals } from "@std/assert";
import { resetBudgets, setBudgets } from "../src/state/budgets.ts";
import { createVitalsSystem } from "../src/vitals/mod.ts";

const ROOT = new URL("..", import.meta.url).pathname;

Deno.test("budgets owner: the vitals pressure monitor records into the ledger it is handed, not the latest boot's", () => {
  // App A booted first (payload budget 1 KB); app B booted after it (10 MB),
  // so B's is "the latest".
  const a = setBudgets({ payload: 1024 });
  const b = setBudgets({ payload: 10 * 1024 * 1024 });
  const v = createVitalsSystem({}, a);
  try {
    // A 5 KB payload to one of A's clients: over A's budget, far under B's.
    v.pressureMonitor!.onBroadcast("client-a", 5_000);
    assertEquals(
      a.report()?.ok,
      false,
      "app A's own 1KB payload budget must record a 5KB breach",
    );
    assertEquals(
      b.report(),
      { ok: true, breaches: [] },
      "app B's ledger recorded a payload sent by app A",
    );
  } finally {
    v.destroy();
    resetBudgets();
  }
});

Deno.test("budgets owner: every budgetsFor( read in src/ is an audited owner-safe site", async () => {
  // A new ambient read is the bug class itself, so it is a red gate: hand the
  // owning app's ledger down (as aio.ts does to vitals, persistence and the
  // server), or — if the site truly cannot race — add it here with the reason
  // on a comment line at the site.
  const allowed = new Map<string, string>([
    // Fallbacks for a bare caller; every production caller passes the ledger.
    ["src/vitals/pressure-monitor.ts", "config.budgets ?? budgetsFor()"],
    ["src/vitals/mod.ts", "budgets: BudgetLedger = budgetsFor()"],
    ["src/server/persistence.ts", "cfg.budgets ?? budgetsFor()"],
    ["src/server/aio-server.ts", "deps.budgets ?? budgetsFor()"],
    // Keyed by the owner, bound synchronously to its app's ledger.
    ["src/server/server-broadcast.ts", "budgetsFor(owner)"],
  ]);
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for await (const e of Deno.readDir(ROOT + dir)) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory) await walk(rel);
      else if (rel.endsWith(".ts") && rel !== "src/state/budgets.ts") {
        const lines = (await Deno.readTextFile(ROOT + rel)).split("\n");
        lines.forEach((l, i) => {
          if (/budgetsFor\(/.test(l) && !/^\s*(\/\/|\*)/.test(l)) {
            found.push(`${rel}:${i + 1}: ${l.trim()}`);
          }
        });
      }
    }
  };
  await walk("src");
  const stray = found.filter((f) => {
    const file = f.slice(0, f.indexOf(":"));
    const want = allowed.get(file);
    return want === undefined || !f.includes(want);
  });
  assertEquals(
    stray,
    [],
    `an unaudited ambient budget read:\n${stray.join("\n")}`,
  );
  assertEquals(found.length, allowed.size, `sites:\n${found.join("\n")}`);
  // …and the one production caller of each fallback really passes the ledger.
  const aio = await Deno.readTextFile(ROOT + "src/server/aio.ts");
  const helpers = await Deno.readTextFile(
    ROOT + "src/server/aio-run-helpers.ts",
  );
  const boot = await Deno.readTextFile(ROOT + "src/server/aio-boot.ts");
  assert(
    /redact,\s*\/\/[^\n]*\n\s*_budgetLedger,\s*\)/.test(aio),
    "initDiagAndVitals",
  );
  assert(/budgets: _budgetLedger,\s*\n[^\n]*shouldPersist/.test(aio), "server");
  assert(
    /bootStorage\(\{[\s\S]{0,400}budgets: _budgetLedger/.test(aio),
    "bootStorage",
  );
  assert(
    helpers.includes("createVitalsSystem(vitalsConfig, budgets)"),
    "vitals",
  );
  assert(
    /createPersistenceManager\(\{[\s\S]*?budgets: cfg\.budgets/.test(boot),
    "persistence",
  );
});
