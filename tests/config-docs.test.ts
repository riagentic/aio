// Config help-table truthfulness gate.
//
// `validateConfig()` prints the "Valid configuration" table on a config error
// and then EXITS — that table is the one reference a user gets at the moment
// they need it. It had drifted three ways: 19 valid keys (auth, sessions,
// resolveUser, localFirst, wsLimits, …) were simply absent, `key` was printed
// twice, and two defaults were lies (`dbPath` "./data.db" vs the real
// `<appDir>/data/state.db`; `key` "omitted=persisted" vs the real
// omitted=OPEN, see app-key.ts). This gate makes the whole class unshippable:
// a key added to an allowlist without a docs row, a duplicate row, or a doc
// row for a key that no longer exists all fail here.
import { assert, assertEquals } from "@std/assert";
import {
  CONFIG_DOCS,
  CONFIG_GROUPS,
  formatValidConfig,
  IDENTITY_KEYS,
  UI_DOCS,
  VALID_AIO_CONFIG_KEYS,
  VALID_FEATURES_CONFIG_KEYS,
  VALID_UI_KEYS,
} from "../src/server/config.ts";

const isPublic = (k: string) => !k.startsWith("_");
/** "renderBudget.staleness" documents the sub-key of allowlisted "renderBudget". */
const base = (k: string) => k.split(".")[0]!;

const publicKeys = new Set([
  ...[...VALID_FEATURES_CONFIG_KEYS].filter(isPublic),
  ...[...VALID_AIO_CONFIG_KEYS].filter(isPublic),
]);

const printedKeys = [
  ...IDENTITY_KEYS,
  ...CONFIG_GROUPS.flatMap(([, keys]) => keys),
];

Deno.test("config docs: every public allowlisted key has a CONFIG_DOCS row", () => {
  const missing = [...publicKeys].filter((k) => !(k in CONFIG_DOCS));
  assertEquals(
    missing,
    [],
    "these keys are accepted by validateConfig but undocumented in the help " +
      "table — a new config key cannot ship undocumented; add a CONFIG_DOCS " +
      "row in src/server/config.ts",
  );
});

Deno.test("config docs: every public cells-API key is actually PRINTED", () => {
  const printed = new Set(printedKeys.map(base));
  const missing = [...VALID_FEATURES_CONFIG_KEYS].filter(isPublic).filter(
    (k) => !printed.has(k),
  );
  assertEquals(
    missing,
    [],
    "these valid keys never appear in formatValidConfig() output — a row in " +
      "CONFIG_DOCS that no group prints is invisible; add the key to a " +
      "CONFIG_GROUPS group (or IDENTITY_KEYS) in src/server/config.ts",
  );
});

Deno.test("config docs: no duplicate printed rows (key was listed twice)", () => {
  const dupes = printedKeys.filter((k, i) => printedKeys.indexOf(k) !== i);
  assertEquals(dupes, [], "a key printed twice reads as two different options");
});

Deno.test("config docs: no phantom rows — every documented/printed key is allowlisted", () => {
  const phantomDocs = Object.keys(CONFIG_DOCS).filter(
    (k) => !publicKeys.has(base(k)),
  );
  assertEquals(
    phantomDocs,
    [],
    "CONFIG_DOCS documents keys validateConfig would REJECT — remove the row " +
      "or allowlist the key",
  );
  const phantomPrinted = printedKeys.filter((k) => !publicKeys.has(base(k)));
  assertEquals(phantomPrinted, [], "printed rows must be real config keys");
  // And every printed row must have its docs entry — a bare "—" row documents
  // nothing.
  const undocumented = printedKeys.filter((k) => !(k in CONFIG_DOCS));
  assertEquals(undocumented, [], "every printed row needs a CONFIG_DOCS entry");
});

Deno.test("config docs: the ui table covers every VALID_UI_KEYS entry", () => {
  const missing = [...VALID_UI_KEYS].filter((k) => !(k in UI_DOCS));
  assertEquals(missing, [], "ui keys need UI_DOCS rows too");
  const phantom = Object.keys(UI_DOCS).filter((k) => !VALID_UI_KEYS.has(k));
  assertEquals(phantom, [], "UI_DOCS documents a key VALID_UI_KEYS rejects");
});

Deno.test("config docs: the two audited lies stay fixed", () => {
  const out = formatValidConfig();
  // dbPath: the real default is <appDir>/data/state.db (app-dirs.ts), and the
  // old "./data.db" claim must not resurface anywhere in the table.
  assert(
    out.includes("<appDir>/data/state.db"),
    "dbPath default must state the real location",
  );
  assert(!out.includes("./data.db"), 'the false "./data.db" default is back');
  // key (alpha52): omitted now DEFAULTS to a generated key when the app is
  // exposed without per-user auth; `false` is the explicit OPEN opt-out. The
  // doc must state the default truthfully in both directions — claiming
  // "omitted=OPEN" (pre-alpha52) would document an authenticated port as
  // open, and omitting the `false=OPEN` escape would hide the opt-out.
  assert(
    /omitted defaults to a generated key when exposed without per-user auth/
      .test(out),
    "key default must state the alpha52 exposed-default truthfully",
  );
  assert(
    /false=OPEN/.test(out),
    "key doc must name the explicit opt-out (false=OPEN)",
  );
  assert(
    !out.includes("omitted=OPEN"),
    'the pre-alpha52 "omitted=OPEN" claim is back — omitted defaults to a ' +
      "generated key under expose",
  );
});

// The `updates` row is the ONLY place an author is told what the object may
// hold — `deno task doctor` and the "Valid configuration" table both print it.
// It had drifted four keys behind `UpdatesConfig` (`kind`, `allowUnsigned`,
// `prerelease`, and the newer `keys`/`canApply`), so a feature could ship
// unreachable: nothing else names it, and the type is not readable at runtime.
// Read the keys out of the type declaration and require each to appear.
Deno.test("config docs: the updates row names every UpdatesConfig key", async () => {
  const src = await Deno.readTextFile(
    new URL("../src/server/updates-core.ts", import.meta.url),
  );
  const start = src.indexOf("export type UpdatesConfig = {");
  assert(start >= 0, "UpdatesConfig moved — this gate needs its new home");
  const body = src.slice(start, src.indexOf("\n};", start));
  const keys = [...body.matchAll(/^  ([a-zA-Z]+)\??:/gm)].map((m) => m[1]!);
  assert(keys.length >= 8, `parsed too few keys: ${keys.join(", ")}`);
  const row = CONFIG_DOCS.updates![1];
  const missing = keys.filter((k) => !row.includes(k));
  assertEquals(
    missing,
    [],
    `the updates help row omits ${missing.join(", ")} — an author has no ` +
      `other place to learn they exist. Row: ${row}`,
  );
});
