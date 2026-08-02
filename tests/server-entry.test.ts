// `aio/server`: the explicit server-only import surface. Re-exports
// server-only symbols (SQLite, CLI transport, ship signing); aiol flags a static
// `aio/server` import in a cell-shared file (the boundary violation).
import { assert, assertEquals } from "@std/assert";
import { connectCli, createDB } from "../src/server-entry.ts";
// Ship signing moved to its natural home, aio/build (surface de-dup) — pinned
// here so the server entry can't quietly re-grow the duplicate.
import {
  buildShipManifest,
  generateSigningKey,
  verifyShipManifest,
} from "../src/build.ts";
import { buildContext } from "../aiol/context.ts";
import { checkUI } from "../aiol/checks.ts";
import { join } from "@std/path";

Deno.test("aio/server: re-exports the server-only symbols", async () => {
  for (const fn of [createDB, connectCli]) {
    assertEquals(typeof fn, "function");
  }
  // Ship signing lives on aio/build ONLY (one home per symbol).
  for (
    const fn of [buildShipManifest, verifyShipManifest, generateSigningKey]
  ) {
    assertEquals(typeof fn, "function");
  }
  // deno-lint-ignore no-explicit-any
  const m: any = await import("../src/server-entry.ts");
  assertEquals(m.shipApp, undefined, "ship family must not re-grow here");
});

Deno.test("aiol: a static aio/server import in a cell file is a boundary error", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(dir, "src"), { recursive: true });
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({ imports: { "aio": "jsr:@riagentic/aio@1.0.0" } }),
    );
    // A browser UI exists (App.tsx) → the cell is shared with the browser bundle,
    // so a server-only import in it is a real boundary break.
    await Deno.writeTextFile(
      join(dir, "src", "App.tsx"),
      `export default () => <div>hi</div>;`,
    );
    await Deno.writeTextFile(
      join(dir, "src", "data.ts"),
      `import { createDB } from "aio/server";\n` +
        `import { cell } from "aio";\n` +
        `export const data = cell("data", { state: { n: 0 } });\n` +
        `export const _db = createDB;`,
    );
    const { ctx, report } = await buildContext(dir);
    await checkUI(ctx);
    const boundary = report.issues.filter((i) =>
      i.severity === "error" && i.message.includes("aio/server")
    );
    assert(
      boundary.length >= 1,
      `expected an aio/server boundary error; got ${
        report.issues.map((i) => i.message)
      }`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
