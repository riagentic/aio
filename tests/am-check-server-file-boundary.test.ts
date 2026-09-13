// A dynamically imported `*.server.ts` module is where the client graph ends.
//
// Measured with `am check` on a scaffolded app: a button handler did
// `await import("../lib/host.server.ts")`, and the check warned
// "Deno.hostname is server-only" INSIDE host.server.ts — plus `@std/path`
// "may be server-only" / "not in the import map" there, and `Deno.env` in a
// helper only that file imports. The suffix is documented as THE way to say
// "server only", and the builder agrees (a dynamic `.server.ts` import is
// external); the validator walked into it and judged it by browser rules.
import { assertEquals } from "@std/assert";
import { validateGraph } from "../src/server/graph-validator.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const passthrough = (source: string) => Promise.resolve(source);

async function app(files: Record<string, string>): Promise<string> {
  const dir = await tempDir("am-check-server-file-");
  for (const [name, body] of Object.entries(files)) {
    await Deno.writeTextFile(`${dir}/${name}`, body);
  }
  return dir;
}

const HOST = `import { join } from "@std/path";
import { helper } from "./helper.ts";
export function host(): string {
  return join(Deno.hostname(), helper());
}
`;
const HELPER = `export const helper = () => Deno.env.get("X") ?? "x";\n`;

Deno.test("graph: nothing inside (or only behind) a dynamic *.server.ts import is judged as client code", async () => {
  const dir = await app({
    "App.tsx": `export default function App() {
  return { onClick: async () => (await import("./host.server.ts")).host() };
}
`,
    "host.server.ts": HOST,
    "helper.ts": HELPER,
  });
  try {
    const r = await validateGraph(`${dir}/App.tsx`, {}, passthrough);
    assertEquals(r.valid, true);
    assertEquals(
      r.errors.map((e) => `${e.file.slice(dir.length + 1)}: ${e.message}`),
      [],
      "a *.server.ts module reached by import() is server code by its name",
    );
    assertEquals(r.modules.has(`${dir}/host.server.ts`), false);
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("graph: the same helper imported by CLIENT code still warns", async () => {
  // The boundary is the server file, not the helper: reached from the UI
  // without one in between, `Deno.env` is a browser call again.
  const dir = await app({
    "App.tsx": `import { helper } from "./helper.ts";
export default function App() {
  return { onClick: async () => (await import("./host.server.ts")).host(), helper };
}
`,
    "host.server.ts": HOST,
    "helper.ts": HELPER,
  });
  try {
    const r = await validateGraph(`${dir}/App.tsx`, {}, passthrough);
    assertEquals(
      r.errors.map((e) => `${e.file.slice(dir.length + 1)}: ${e.message}`),
      ["helper.ts: Deno.env is server-only"],
    );
  } finally {
    await dropTempDir(dir);
  }
});
