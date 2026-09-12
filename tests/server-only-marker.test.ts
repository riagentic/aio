// `import "aio/server-only"` / `import "aio/client-only"` — the same statement
// `*.server.ts` makes, made in the FILE instead of in its name.
//
// aio's convention is good and has one hole: it is a FILENAME (report 2 §9.1).
// You cannot always rename a file that twenty places already import, that is
// generated, or that is published under that name. The markers close it.
//
// THE TWO HALVES ARE NOT SYMMETRIC, and that is the design:
//   server-only in the browser  LEAKS  → refused at build, throws at runtime
//   client-only on the server   BREAKS → refused by aiol, no runtime guard
// A `window is not defined` during SSR is loud, immediate and escapes nothing.
// A database URL in dist/app.js is silent and permanent.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  isClientOnlyMarker,
  isServerOnlyFile,
  isServerOnlyMarker,
} from "../src/entries.ts";
import { auditClientGraph } from "../src/build/graph-audit.ts";
import { checkClientOnlyInCell } from "../aiol/checks.ts";

Deno.test("the marker is recognized however the import map spells it", () => {
  // An app that pins aio BY PATH is the common case in this repo's own tests,
  // so matching only the bare specifier would make the marker work for JSR
  // users and silently not for anyone developing against a checkout.
  for (
    const spec of [
      "aio/server-only",
      "/abs/src/server-only.ts",
      "../dep/aio/src/server-only.ts",
      "/x/src/server-only.ts?v=2",
    ]
  ) assert(isServerOnlyMarker(spec), `not recognized: ${spec}`);

  // …and does not over-match. A near-miss silently marking a file server-only
  // would delete it from the bundle with no finding to read.
  for (
    const spec of [
      "aio/server",
      "./server-only-helper.ts",
      "aio/client-only",
      "./my-server-only.ts",
    ]
  ) assertEquals(isServerOnlyMarker(spec), false, `over-matched: ${spec}`);

  assert(isClientOnlyMarker("aio/client-only"));
  assertEquals(isClientOnlyMarker("aio/server-only"), false);
});

Deno.test("the audit refuses a marker-declared module in the bundle", () => {
  // Driven through the ONE decider both `deno task build` and the dev boot
  // use, on a metafile shaped like esbuild's.
  const inputs = {
    "entry.ts": { imports: [{ path: "src/db.ts", kind: "import-statement" }] },
    "src/db.ts": {
      imports: [{ path: "aio/server-only", kind: "import-statement" }],
    },
  };
  const v = auditClientGraph({
    entry: "entry.ts",
    // deno-lint-ignore no-explicit-any
    inputs: inputs as any,
    source: () => undefined,
  });
  const leak = v.findings.find((f) => f.rule === "server-only-leak");
  assert(leak, `no leak reported: ${JSON.stringify(v.findings)}`);
  assertStringIncludes(leak!.message, "src/db.ts");
  // The message must say WHICH kind of declaration it is, or a reader goes
  // looking for a `.server.ts` filename that does not exist.
  assertStringIncludes(leak!.message, "aio/server-only");
  assertStringIncludes(leak!.fix, "aio/server-only");
});

Deno.test("a file with no marker is untouched", () => {
  const inputs = {
    "entry.ts": {
      imports: [{ path: "src/util.ts", kind: "import-statement" }],
    },
    "src/util.ts": { imports: [] },
  };
  const v = auditClientGraph({
    entry: "entry.ts",
    // deno-lint-ignore no-explicit-any
    inputs: inputs as any,
    source: () => undefined,
  });
  assertEquals(
    v.findings.filter((f) => f.rule === "server-only-leak"),
    [],
    "an ordinary module was refused — the marker must cost nothing to anyone " +
      "who does not use it",
  );
});

Deno.test("the filename convention still works on its own", () => {
  // The marker is additive. A repo that renamed nothing must behave exactly as
  // it did.
  assert(isServerOnlyFile("src/io.server.ts"));
  const inputs = {
    "entry.ts": {
      imports: [{ path: "io.server.ts", kind: "import-statement" }],
    },
    "io.server.ts": { imports: [] },
  };
  const v = auditClientGraph({
    entry: "entry.ts",
    // deno-lint-ignore no-explicit-any
    inputs: inputs as any,
    source: () => undefined,
  });
  const leak = v.findings.find((f) => f.rule === "server-only-leak");
  assert(leak);
  assertStringIncludes(leak!.message, "*.server.*");
});

Deno.test("aiol: a cell that imports aio/client-only is refused", () => {
  const found: { level: string; msg: string; fix?: string }[] = [];
  const file = {
    relative: "src/cell.ts",
    name: "cell.ts",
    content:
      `import "aio/client-only";\nimport { cell } from "aio";\nexport const c = cell("c", { state: {}, methods: {} });\n`,
  };
  // deno-lint-ignore no-explicit-any
  const ctx: any = {
    cells: [{ name: "c", file, line: 3 }],
    report: (level: string, _a: string, msg: string, o?: { fix?: string }) =>
      found.push({ level, msg, fix: o?.fix }),
    pass: () => {},
  };
  checkClientOnlyInCell(ctx);
  assertEquals(found.length, 1, "a self-contradicting cell went unreported");
  assertEquals(found[0]!.level, "error");
  assertStringIncludes(found[0]!.msg, "runs ON the server");
  assertStringIncludes(found[0]!.fix!, "aio/server-only");
});

Deno.test("aiol: a cell WITHOUT the marker is silent, and a mention in prose is not an import", () => {
  const run = (content: string) => {
    const found: unknown[] = [];
    const file = { relative: "src/cell.ts", name: "cell.ts", content };
    // deno-lint-ignore no-explicit-any
    const ctx: any = {
      cells: [{ name: "c", file, line: 1 }],
      report: (...a: unknown[]) => found.push(a),
      pass: () => {},
    };
    checkClientOnlyInCell(ctx);
    return found.length;
  };
  assertEquals(run(`import { cell } from "aio";\n`), 0);
  // A comment explaining why the cell does NOT use it is the common shape, and
  // firing on it is how a rule teaches people to stop reading the linter.
  assertEquals(
    run(`// deliberately not "aio/client-only" — this runs server-side\n`),
    0,
    "a mention in a comment is not an import",
  );
  // …and an acknowledgement is honoured, like every other rule.
  assertEquals(
    run(`// aio-ok: a type-only reference\nimport "aio/client-only";\n`),
    0,
  );
});

Deno.test("both markers are on the public export map", () => {
  const cfg = JSON.parse(Deno.readTextFileSync("deno.json")) as {
    exports: Record<string, string>;
  };
  assertEquals(cfg.exports["./server-only"], "./src/server-only.ts");
  assertEquals(cfg.exports["./client-only"], "./src/client-only.ts");
});
