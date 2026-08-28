// A field report against alpha70 (a desktop wallet, 35 cells): three findings
// and one ask, each pinned here so it cannot come back.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { buildContext } from "../aiol/context.ts";
import { checkUI } from "../aiol/checks.ts";
import { moveImports } from "../aiol/fixes.ts";
import {
  _checkStateIntegrity,
  _resetInitialShapeKeys,
} from "../src/protocol/protocol-diagnostics.ts";
import { cellSetDrift } from "../src/browser/browser-protocol.ts";

// 1. aiol's .tsx server-only rule reported 51 false ERRORs — every one a test
//    file importing @std/assert. Test files are never in the browser bundle.
Deno.test("aiol: a .test.tsx importing @std/assert is not a browser-bundle leak", async () => {
  const dir = await Deno.makeTempDir({ prefix: "aiol-round3-" });
  try {
    await Deno.mkdir(join(dir, "src", "test", "ui"), { recursive: true });
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({ imports: { aio: "jsr:@riagentic/aio@1.0.0" } }),
    );
    await Deno.writeTextFile(
      join(dir, "src", "App.tsx"),
      `export default function App() { return <div>ok</div>; }\n`,
    );
    await Deno.writeTextFile(
      join(dir, "src", "test", "ui", "premium.test.tsx"),
      `import { assertEquals } from "@std/assert";\nDeno.test("x", () => assertEquals(1, 1));\n`,
    );
    const { ctx, report } = await buildContext(dir);
    checkUI(ctx);
    const leaks = report.issues.filter((i) =>
      String(i.message).includes("server-only and this file is compiled")
    );
    assertEquals(leaks, [], "a test file is not compiled into the bundle");
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

// 2. cell-set-drift told a correct app to boot its client-scoped cell on the
//    server — a `scope: "client"` cell is DEFINED as never booted there.
Deno.test("cell-set-drift: a scope:'client' cell is not drift", () => {
  const reg = new Map<string, { __aio: { scope: string } }>([
    ["gallery", { __aio: { scope: "client" } }],
    ["wallet", { __aio: { scope: "server" } }],
  ]);
  assertEquals(cellSetDrift(reg, new Set(["wallet"])), []);
  assertEquals(cellSetDrift(reg, new Set([])), ["wallet"]);
});

// 3. state-shape-drift fired on every load for a slice the server had
//    legitimately omitted from a later FULL frame (subscriptions narrow it).
//    A full frame defines the shape; only a patch can drop a key by mistake.
Deno.test("state-shape-drift: a full frame re-baselines, a patch that drops a key reports", () => {
  _resetInitialShapeKeys();
  try {
    assertEquals(
      _checkStateIntegrity({ a: 1, arweave: {} }, { full: true }),
      [],
    );
    assertEquals(
      _checkStateIntegrity({ a: 1 }, { full: true }),
      [],
      "a narrower full state is not drift",
    );
    assertEquals(
      _checkStateIntegrity({}, { full: false }),
      ["a"],
      "a patch that drops a key is",
    );
  } finally {
    _resetInitialShapeKeys();
  }
});

// 4. `aiol --safe-fix` rewrote 20 static sites and missed the one dynamic one.
Deno.test("moveImports: the dynamic form moves when every destructured name moves", () => {
  const mv = { from: "aio", to: "aio/testing", names: new Set(["testCell"]) };
  assertEquals(
    moveImports('const { testCell } = await import("aio");', mv),
    'const { testCell } = await import("aio/testing");',
  );
  // A mixed destructuring would need two awaits — the reader's decision.
  assertEquals(
    moveImports('const { testCell, cell } = await import("aio");', mv),
    null,
  );
});
