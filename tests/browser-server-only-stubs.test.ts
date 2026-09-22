// Server-only names a cell module imports from "aio" must BUNDLE, and must
// fail loud if a browser ever CALLS them.
//
// docs/auth/auth.md's `serverUser` example and docs/debugging/performance.md's
// `blocking` example both import the name into a cell module — which the UI
// imports, so the module is in the browser graph, where "aio" is
// src/browser-air.ts. Neither name was exported there, so both examples
// type-checked and then refused the bundle:
//   No matching export in "…/src/browser-air.ts" for import "serverUser"
//
// `serverUser`/`serverRequest`/`serverAuth` cannot be re-exported (their module
// needs node:async_hooks), so the browser entry carries STUBS that throw when
// called — a sync method replayed in the browser (sync/localFirst) that calls
// one must fail loud, never read `undefined` as "anonymous". `blocking` is a
// facade too: re-exporting blocking.ts would pin its worker pool on every page
// (its `blocking.cancel = …` statements are not tree-shakeable), and in a
// browser the real one only ever rejects — with the same sentence.
//
// The bundle half drives the same in-memory prod bundle `am check` uses
// (`createProdGraphCheck` → `bundleClient`), over the DOCS' OWN snippets.
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { createProdGraphCheck } from "../src/server/graph-validator.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { ESBUILD_SPEC } from "../src/build/esbuild-shared.ts";
import * as browser from "../src/browser-air.ts";
import * as mod from "../mod.ts";
import { blockingUnavailableReason } from "../src/state/blocking.ts";
import { blockingServerOnly } from "../src/state/blocking-reason.ts";

const ROOT = new URL("..", import.meta.url).pathname;

/** The first ```ts block after `heading` in a doc — the example itself. */
async function docSnippet(doc: string, heading: string): Promise<string> {
  const text = await Deno.readTextFile(`${ROOT}${doc}`);
  const at = text.indexOf(heading);
  assert(at >= 0, `${doc} lost the "${heading}" section`);
  const m = text.slice(at).match(/```ts\n([\s\S]*?)```/);
  assert(m, `${doc}: no ts block under "${heading}"`);
  return m[1]!;
}

async function bundleRefusals(tag: string, cellSrc: string, exp: string) {
  const dir = await tempDir(`aio-stub-${tag}-`);
  try {
    await Deno.writeTextFile(
      `${dir}/deno.json`,
      JSON.stringify({
        title: "Stub Probe",
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
    // The auth example declares its cell without exporting it, so the UI
    // imports the module as a namespace — enough to put it in the graph.
    await Deno.writeTextFile(`${dir}/cell.ts`, cellSrc);
    await Deno.writeTextFile(
      `${dir}/App.tsx`,
      `import * as m from "./cell.ts";
export default function App() {
  return <div class="probe">{String(Object.keys(m).length)} ${exp}</div>;
}
`,
    );
    const judge = createProdGraphCheck({ absBaseDir: dir, uiEntry: "App.tsx" });
    const { errors } = await judge(`stub-${tag}`);
    return errors.filter((e) => e.category === "bundle-refused").map((e) =>
      e.message.replace(/\s+/g, " ").slice(0, 240)
    );
  } finally {
    await dropTempDir(dir);
  }
}

Deno.test("browser stubs: the docs' serverUser and blocking cell modules bundle", async () => {
  const auth = await docSnippet(
    "docs/auth/auth.md",
    "### Who is calling? (`serverUser`)",
  );
  assert(auth.includes("serverUser"), "auth snippet no longer uses serverUser");
  const perf = await docSnippet(
    "docs/debugging/performance.md",
    "## Move it off-thread",
  );
  assert(perf.includes("blocking("), "perf snippet no longer uses blocking");
  const other = `import { cell, serverAuth, serverRequest } from "aio";
export const probe = cell("probe", {
  state: { n: 0 },
  methods: {
    async who(s) { s.n = serverRequest() ? 1 : serverAuth() ? 2 : 0; },
  },
});
`;
  const refused: string[] = [];
  try {
    for (
      const [tag, src] of [["auth", auth], ["perf", perf], ["req", other]]
    ) {
      for (const m of await bundleRefusals(tag!, src!, tag!)) {
        refused.push(`${tag}: ${m}`);
      }
    }
  } finally {
    await (await import(ESBUILD_SPEC)).stop();
    await new Promise((r) => setTimeout(r, 50));
  }
  assertEquals(refused, [], "the browser bundle refused a docs example");
});

Deno.test("browser stubs: calling a server-only name in the browser throws a teachable error", () => {
  // A mere `stub !== real` reference check is vacuous here: the REAL
  // `serverUser`/`serverRequest` return `undefined` outside a request — the
  // exact silent reading ("anonymous") the stubs exist to forbid. A stub that
  // did the same would pass `!==` and teach nothing. Prove the CONTRAST: the
  // Deno export stays callable (or throws its OWN sentence for serverAuth);
  // the browser export throws the teachable "ran in the browser" line.
  for (const name of ["serverUser", "serverRequest", "serverAuth"] as const) {
    const stub = (browser as Record<string, unknown>)[name];
    const real = (mod as Record<string, unknown>)[name];
    assertEquals(
      typeof stub,
      "function",
      `${name}: browser must export a stub`,
    );
    assertEquals(
      typeof real,
      "function",
      `${name}: mod must export the real one`,
    );
    if (name === "serverAuth") {
      // Off-request the real one names the missing user store — a DIFFERENT
      // sentence from the stub. Same-throw would mean the stub was replaced
      // by the server export.
      assertThrows(
        () => (real as () => unknown)(),
        Error,
        "no user store",
      );
    } else {
      const got = (real as () => unknown)();
      assertEquals(
        got,
        undefined,
        `${name}: server export must stay callable on Deno (got ${got}) — ` +
          `a silent undefined is what the browser stub exists to forbid`,
      );
    }
    assertThrows(
      () => (stub as () => unknown)(),
      Error,
      `${name}() is server-only — it ran in the browser`,
    );
  }
});

Deno.test("browser stubs: blocking refuses in the browser with the sentence the real one uses off Deno", async () => {
  // The real implementation, on a runtime with no Deno: this sentence.
  assertEquals(blockingUnavailableReason("x"), null, "on Deno it runs");
  const why = blockingUnavailableReason("x", null);
  assertEquals(why, blockingServerOnly("x"));
  // The browser facade: the same sentence, and inert pool controls.
  await assertRejects(
    () => browser.blocking("x", () => 1),
    Error,
    "blocking('x') is server-only",
  );
  assertEquals(browser.blocking.cancel("x"), false);
  assertEquals(browser.blocking.disposeIdle(), true);
  await browser.blocking.dispose();
});
