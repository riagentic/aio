// `import "aio/server-only"` is documented as "the same statement" a
// `*.server.ts` name makes (docs/build/imports.md) — and a `*.server.ts` file
// is a 404 over HTTP in dev and prod alike. The marked file was not: the dev
// server transpiled and served it to any caller of `GET /db.ts`, connection
// strings and all (and on an `auth: true` app dev admits `.ts` to ANONYMOUS
// callers as shell). The build refused the module in the bundle; the static
// layer, which reads the file by name, never asked.
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { cell } from "../src/state/cell-create.ts";
import { testServer } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const marker = cell("static-server-only-marker", { state: { n: 0 } });

Deno.test({
  name: "static: a module marked aio/server-only is a 404, like *.server.ts",
  // esbuild's service child (the dev transpile) is not awaitable from here.
  sanitizeOps: false, // aio-ok: esbuild's service child — exit not awaitable
  sanitizeResources: false, // aio-ok: same esbuild child
}, async () => {
  const dir = await tempDir("aio-server-only-marker-");
  try {
    await Deno.writeTextFile(
      join(dir, "db.ts"),
      'import "aio/server-only";\nexport const URL_ = "postgres://u:hunter2@db";\n',
    );
    await Deno.writeTextFile(
      join(dir, "named.ts"),
      'import {} from "aio/server-only";\nexport const K = "hunter3";\n',
    );
    await Deno.writeTextFile(
      join(dir, "plain.js"),
      "import 'aio/server-only';\nexport const K = 'hunter4';\n",
    );
    // A module that only MENTIONS the marker in a comment is still served.
    await Deno.writeTextFile(
      join(dir, "ok.ts"),
      '// never import "aio/server-only" here\nexport const OK = 1;\n',
    );
    await Deno.writeTextFile(join(dir, "k.server.ts"), "export const K = 1;\n");
    await using srv = await testServer({ cells: [marker], baseDir: dir });
    const denied = ["/k.server.ts", "/db.ts", "/named.ts", "/plain.js"];
    assertEquals(denied.length, 4);
    for (const p of denied) {
      const res = await srv.fetch(p);
      const body = await res.text();
      assertEquals(res.status, 404, `${p} served: ${body}`);
      assertEquals(body.includes("hunter"), false, p);
    }
    const ok = await srv.fetch("/ok.ts");
    assertEquals(ok.status, 200);
    await ok.text();
  } finally {
    await dropTempDir(dir);
  }
});
