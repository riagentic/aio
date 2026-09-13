// `"aio"` means mod.ts to the type-checker and src/browser-air.ts inside the
// browser bundle — the names the two disagree on are a green `deno check`
// followed by a refused bundle.
//
// src/build/esbuild-shared.ts `bundleFrameworkEntries` maps `"aio"` to
// src/browser-air.ts, and a cell module is in the client graph because the UI
// imports it. So a VALUE mod.ts exports and browser-air.ts does not is an
// esbuild "No matching export in …/src/browser-air.ts" the moment a cell (or
// anything App.tsx reaches) imports it from "aio" — measured for every name in
// the ledger below (each one refuses the in-memory prod bundle). Report 9b §3
// was `self`: docs/state/scheduling.md's own example type-checked and then
// failed to bundle in every run that got that far.
//
// tests/browser-air-surface.test.ts compares browser-air.ts with the curated
// `aio/air` (src/air.ts); nothing compared it with mod.ts, the entry apps
// import most. This does, in both directions, the ledger shape that file uses:
// a new mod.ts value is either shipped on the browser entry or recorded here
// with its reason the day it lands.
//
// Type-only exports are out of scope on purpose: esbuild erases them, so a
// type absent on the browser entry never refuses a bundle.
import { assert, assertEquals } from "@std/assert";
import * as mod from "../mod.ts";
import * as browser from "../src/browser-air.ts";

/** mod.ts values the browser entry does not ship, each with the reason.
 *  Shrinking this is always allowed; growing it is a decision.
 *
 *  Every entry is server-side by nature. "Not bundle-safe" means measured: the
 *  module's own graph refuses the browser prod bundle (it statically reaches
 *  `node:*` or `@std/*`), so the name cannot simply be re-exported. The rest
 *  are configuration an app hands to `aio.run()` in its server entry (app.ts),
 *  which is not in the client graph. The browser-safe names this list used to
 *  carry now ship — tests/browser-bundle-self-export.test.ts bundles each. */
const ABSENT_ON_BROWSER: Record<string, string> = {
  // ── not bundle-safe: the module graph reaches server-only code ──
  serverUser: "server: ambient caller of a server call — auth-context.ts " +
    "imports node:async_hooks (AsyncLocalStorage); not bundle-safe. NOTE " +
    "docs/auth/auth.md:357 imports it into a cell module, which still " +
    "refuses the bundle — closing that needs a browser stub, not a re-export",
  serverRequest: "server: ambient request context — same module as " +
    "serverUser (node:async_hooks); not bundle-safe",
  serverAuth: "server: ambient auth context — same module as serverUser " +
    "(node:async_hooks); not bundle-safe",
  generateTotpSecret: "server: TOTP enrollment secret — auth-totp.ts " +
    "reaches @std/path/@std/jsonc via server-auth.ts; not bundle-safe",
  totpUri: "server: TOTP enrollment URI — same module as generateTotpSecret",
  verifyTotp: "server: TOTP verification — same module as generateTotpSecret",
  VERSION: "server: framework version stamp — lives on src/server/aio.ts, " +
    "whose graph is the whole server (node:sqlite, node:crypto, @std/path)",
  // ── bundle-safe, but its price lands on every page ──
  blocking: "server: Deno worker pool for CPU-bound method work. Bundles, " +
    "but blocking.ts computes its pool size in a module-scope IIFE esbuild " +
    "cannot tree-shake — measured +0.8 KB gzip on EVERY page, used or not. " +
    "docs/debugging/performance.md imports it beside cell; ship it only " +
    "once that initializer is lazy",
  // ── aio.run() configuration, written in the server entry ──
  definePlugin: "server: packages cells/routes/hooks for aio.run({ plugins })",
  route: "server: HTTP route handler for aio.run({ routes })",
  isCellWorker: "server: true only inside a Deno cell worker — an app.ts " +
    "boot guard",
  bindCell: "server: binds a cell to the running aio.run() app instance; a " +
    "browser cell is a protocol stub with no app to bind",
  composeCells: "server: composes cells into the server's reduce/execute " +
    "pipeline; the browser dispatches to that pipeline over the wire",
  table: "server: SQLite schema for aio.run({ db })",
  pk: "server: SQLite column builder for aio.run({ db })",
  integer: "server: SQLite column builder for aio.run({ db })",
  real: "server: SQLite column builder for aio.run({ db })",
  text: "server: SQLite column builder for aio.run({ db })",
  ref: "server: SQLite column builder for aio.run({ db })",
};

/** The names that ship on the browser entry BECAUSE a cell module or a
 *  component imports them from "aio" (report 9b §3 and its class). Each must
 *  be mod.ts's own implementation, never a browser twin. */
const SHIPPED_FOR_CELL_MODULES = [
  "self",
  "call",
  "until",
  "race",
  "sleep",
  "UntilTimeoutError",
  "errorCode",
  "createSelector",
  "authClient",
  "createAuthClient",
  "degraded",
  "degradedReport",
  "serverImport",
] as const;

const values = (m: Record<string, unknown>) =>
  Object.keys(m).filter((k) => !k.startsWith("_"));

Deno.test("browser aio: every mod.ts value absent from browser-air.ts is a listed decision", () => {
  // Non-empty, or the loop below checks nothing and reports a clean surface.
  assert(values(mod).length > 20, "mod.ts exported almost nothing?");
  const surprises = values(mod).filter((n) =>
    !(n in browser) && !(n in ABSENT_ON_BROWSER)
  );
  assertEquals(
    surprises,
    [],
    'these "aio" exports vanish in a browser bundle with no recorded reason ' +
      "— an app that imports one into a cell type-checks and then refuses " +
      "to bundle (report 9b §3). Export it from src/browser-air.ts, or list " +
      "it here with why:\n  " + surprises.join("\n  "),
  );
});

Deno.test("browser aio: the absent ledger has no dead entries", () => {
  const stale = Object.keys(ABSENT_ON_BROWSER).filter((n) =>
    !(n in mod) || n in browser
  );
  assertEquals(
    stale,
    [],
    "listed as absent but now shipped on the browser entry (or gone from " +
      "mod.ts) — the ledger has to shrink when the gap does",
  );
});

Deno.test("browser aio: every name shipped for cell modules is mod.ts's own implementation", () => {
  const b = browser as Record<string, unknown>;
  const m = mod as Record<string, unknown>;
  const wrong = SHIPPED_FOR_CELL_MODULES.filter((n) =>
    !(n in b) || !(n in m) || b[n] !== m[n]
  );
  assertEquals(
    wrong,
    [],
    "missing from src/browser-air.ts, or a second implementation of the name " +
      "— two copies drift the next time only one is edited",
  );
  assert(
    Object.values(ABSENT_ON_BROWSER).every((r) => r.startsWith("server: ")),
    "the ledger holds only server-side names — a browser-safe one ships",
  );
});
