// `self("m")` in a cell must survive the BROWSER bundle — report 9b §3.
//
// `"aio"` resolves to `mod.ts` for the type-checker and to `src/browser-air.ts`
// inside the browser bundle (src/build/esbuild-shared.ts
// `bundleFrameworkEntries`). `mod.ts` exported `self`; `browser-air.ts` did
// not. So docs/state/scheduling.md's own example —
//   import { cell, schedule, self } from "aio";
//   … s.$do(schedule.after("flush", 2000, self("flush")))
// — passed `deno check` and then refused to bundle:
//   No matching export in "…/src/browser-air.ts" for import "self"
// It hit every run in the report that got as far as running such an app.
//
// And the rest of the class: every name a cell module (or a component) imports
// from "aio" that mod.ts exported and browser-air.ts did not — `race`/`until`
// in docs/state/methods.md, `call` in quickstart, `errorCode` in
// docs/debugging/errors.md, `serverImport` "in the cell" — refused the bundle
// the same way. The names that stay server-only are ledgered, with the
// measured reason, in tests/browser-air-mod-parity.test.ts.
//
// This drives the SAME in-memory prod bundle the dev server and `am check`'s
// bundle half use (`createProdGraphCheck` → `bundleClient`), for the browser
// target, once per name, over a cell module that uses the name inside a method
// the way the docs do. The prod check also EVALUATES the bundle, so a name
// whose module throws at load in a browser fails here too.
import { assert, assertEquals } from "@std/assert";
import { createProdGraphCheck } from "../src/server/graph-validator.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { ESBUILD_SPEC } from "../src/build/esbuild-shared.ts";

const ROOT = new URL("..", import.meta.url).pathname;

/** name → a method body using it the way a cell module does. */
const CELL_MODULE_NAMES: Record<string, string> = {
  self: `s.$do(schedule.after("flush", 2000, self("flush")));`,
  call: `await call({ timeoutMs: 50 }, async () => 1);`,
  until: `await until(() => s.n > 0, { timeoutMs: 10 }).catch(() => {});`,
  race: `await race({ a: sleep(1) });`,
  sleep: `await sleep(1);`,
  UntilTimeoutError: `void new UntilTimeoutError("x");`,
  errorCode: `void errorCode(new Error("x"));`,
  createSelector: `void createSelector((x: number) => x, (x) => x + 1);`,
  authClient: `void authClient;`,
  createAuthClient: `void createAuthClient;`,
  degraded: `void degraded("x");`,
  degradedReport: `void degradedReport;`,
  serverImport: `void serverImport;`,
  // A `db:` table is declared next to the cell whose rows it stores (the row
  // type is the cell's), and the UI imports that module — so the schema
  // builders ride into the browser graph (docs/persistence/sqlite.md).
  table:
    `void table({ id: pk(), a: text(), b: integer(), c: real(), d: ref("t") });`,
};

async function bundleRefusals(name: string, body: string): Promise<string[]> {
  const dir = await tempDir(`aio-bundle-${name}-`);
  try {
    await Deno.writeTextFile(
      `${dir}/deno.json`,
      JSON.stringify({
        title: "Cell Module Probe",
        nodeModulesDir: "auto",
        compilerOptions: { jsx: "react-jsx", jsxImportSource: "aio" },
        imports: {
          "aio": `${ROOT}mod.ts`,
          "aio/jsx-runtime": `${ROOT}src/jsx-runtime.ts`,
          "immer": "npm:immer@10.2.0",
        },
      }),
    );
    await Deno.symlink(`${ROOT}node_modules`, `${dir}/node_modules`);
    const extra = name === "race"
      ? ", sleep"
      : name === "self"
      ? ", schedule"
      : name === "table"
      ? ", pk, text, integer, real, ref"
      : "";
    await Deno.writeTextFile(
      `${dir}/cell.ts`,
      `import { cell, ${name}${extra} } from "aio";
export const probe = cell("probe", {
  state: { n: 0 },
  methods: {
    async use(s) {
      ${body}
      s.n += 1;
    },
    flush(s) { s.n = 0; },
  },
});
`,
    );
    await Deno.writeTextFile(
      `${dir}/App.tsx`,
      `import { probe } from "./cell.ts";
export default function App() {
  return <div class="button" onClick={() => probe.use()}>{probe.state.n}</div>;
}
`,
    );
    const judge = createProdGraphCheck({ absBaseDir: dir, uiEntry: "App.tsx" });
    const { errors } = await judge(`probe-${name}`);
    return errors.filter((e) => e.category === "bundle-refused").map((e) =>
      e.message
    );
  } finally {
    await dropTempDir(dir);
  }
}

Deno.test('browser bundle: every name a cell module imports from "aio" bundles', async () => {
  const names = Object.entries(CELL_MODULE_NAMES);
  assert(
    names.length > 10,
    "the table is the whole claim — it cannot be empty",
  );
  const refused: string[] = [];
  try {
    for (const [name, body] of names) {
      for (const m of await bundleRefusals(name, body)) {
        refused.push(`${name}: ${m.replace(/\s+/g, " ").slice(0, 240)}`);
      }
    }
  } finally {
    // esbuild's service is a child process; stopping it here keeps the
    // sanitizers ON for this file instead of opting out of them.
    await (await import(ESBUILD_SPEC)).stop();
    // stop() signals the child; its exit is observed a tick later.
    await new Promise((r) => setTimeout(r, 50));
  }
  assertEquals(
    refused,
    [],
    'the browser bundle refused a cell module importing these from "aio"',
  );
});
