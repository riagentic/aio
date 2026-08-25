// A static import of a `*.server.ts` module from a client-loaded file
// blank-screens the app (the dev server 404s it) while every static gate
// stayed green: the validator had no category for the serving convention
// (field report §5.1). Now: static + eager ⇒ BLOCKING; dynamic ⇒ the escape hatch.
import { assert, assertEquals } from "@std/assert";
import {
  BLOCKING_CATEGORIES,
  validateGraph,
} from "../src/server/graph-validator.ts";

const passthrough = (source: string) => Promise.resolve(source);

async function fixture(files: Record<string, string>): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "aio-graph-server-file-" });
  for (const [name, body] of Object.entries(files)) {
    await Deno.writeTextFile(`${dir}/${name}`, body);
  }
  return dir;
}

Deno.test("graph: static *.server.ts import from a client-loaded file BLOCKS", async () => {
  const dir = await fixture({
    "App.tsx":
      `import { helper } from "./lib.ts";\nexport default function App() { return helper(); }`,
    "lib.ts":
      `import { secret } from "./vault.server.ts";\nexport const helper = () => secret;`,
    "vault.server.ts": `export const secret = 1;`,
  });
  try {
    const r = await validateGraph(`${dir}/App.tsx`, {}, passthrough);
    const hit = r.errors.find((e) =>
      e.category === "server-only-import" &&
      e.message.includes("vault.server.ts")
    );
    assert(hit, `expected a server-only-import: ${JSON.stringify(r.errors)}`);
    assertEquals(hit.file, `${dir}/lib.ts`, "attributed to the IMPORTER");
    assertEquals(hit.line, 1);
    assert(hit.fix.includes("await import("), "names the escape hatch");
    assert(BLOCKING_CATEGORIES.has(hit.category), "and it is blocking");
    assertEquals(
      r.valid,
      false,
      "the dev server goes red, not just the bundle",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('graph: a bare `import "./x.server.ts"` is caught the same way', async () => {
  const dir = await fixture({
    "App.tsx":
      `import "./boot.server.ts";\nexport default function App() { return null; }`,
    "boot.server.ts": `console.log("server");`,
  });
  try {
    const r = await validateGraph(`${dir}/App.tsx`, {}, passthrough);
    assertEquals(r.valid, false);
    assert(
      r.errors.some((e) =>
        e.category === "server-only-import" &&
        e.message.includes("boot.server.ts")
      ),
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("graph: a DYNAMIC *.server.ts import stays the escape hatch", async () => {
  const dir = await fixture({
    "App.tsx":
      `import { run } from "./cell.ts";\nexport default function App() { return run(); }`,
    "cell.ts":
      `export const run = async () => (await import("./vault.server.ts")).secret;`,
    "vault.server.ts": `export const secret = 1;`,
  });
  try {
    const r = await validateGraph(`${dir}/App.tsx`, {}, passthrough);
    assertEquals(
      r.errors.filter((e) => e.category === "server-only-import"),
      [],
      "reached only via import() — never eagerly linked",
    );
    assertEquals(r.valid, true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("graph: a *.server.ts static import inside a dynamic-only chunk is deferred", async () => {
  const dir = await fixture({
    "App.tsx": `export default function App() { return import("./chunk.ts"); }`,
    "chunk.ts":
      `import { secret } from "./vault.server.ts";\nexport const x = secret;`,
    "vault.server.ts": `export const secret = 1;`,
  });
  try {
    const r = await validateGraph(`${dir}/App.tsx`, {}, passthrough);
    assertEquals(r.valid, true, "chunk.ts is not in the eager set");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
