// Each binary ships only its OWN server code — also in the `am create` shape
// (v1.0.11 hunt, O1). Web entry `src/app.ts`, agent target
// `src/agent/app.ts`: rule 2 ("anything under the entry's own directory")
// handed the web binary `src/agent/helper.server.ts`, because `src/agent/` is
// under `src/`. docs/build/targets.md promises otherwise. A candidate whose
// nearest target directory is a SIBLING's ships only when this entry's graph
// reaches it.

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { assetIncludes, serverModulePlan } from "../src/build/build-compile.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const included = (args: string[]) =>
  args.filter((_, i) => args[i - 1] === "--include").sort();

Deno.test("assetIncludes (am create shape): the web binary does not embed the agent target's *.server.ts, and vice versa", async () => {
  const root = await tempDir("aio-sibling-targets-");
  const { warn } = console;
  try {
    await Deno.mkdir(join(root, "src", "agent"), { recursive: true });
    await Deno.writeTextFile(
      join(root, "deno.json"),
      JSON.stringify({
        build: {
          targets: {
            web: { kind: "browser", entry: "src/app.ts" },
            agent: {
              kind: "server",
              entry: "src/agent/app.ts",
              name: "multi-agent",
            },
          },
        },
      }),
    );
    await Deno.writeTextFile(
      join(root, "src", "app.ts"),
      'import "./cell.ts";\nexport const w = () => import("./web.server.ts");\n',
    );
    await Deno.writeTextFile(join(root, "src", "cell.ts"), "export {};\n");
    await Deno.writeTextFile(
      join(root, "src", "web.server.ts"),
      "export {};\n",
    );
    // The agent reaches the SHARED cell in web's dir, and loads its helper
    // opaquely (rule 2 — its own dir — must still ship it).
    await Deno.writeTextFile(
      join(root, "src", "agent", "app.ts"),
      'import "../cell.ts";\nconst n = "helper";\n' +
        "export const h = () => import(new URL(`./${n}.server.ts`, import.meta.url).href);\n",
    );
    await Deno.writeTextFile(
      join(root, "src", "agent", "helper.server.ts"),
      "export {};\n",
    );
    console.warn = () => {};
    const web = included(await assetIncludes(root, "src/app.ts"));
    const agent = included(await assetIncludes(root, "src/agent/app.ts"));
    console.warn = warn;
    assertEquals(web, ["deno.json", "src/web.server.ts"]);
    assertEquals(agent, ["deno.json", "src/agent/helper.server.ts"]);
  } finally {
    console.warn = warn;
    await dropTempDir(root);
  }
});

Deno.test("serverModulePlan: a sibling target's module ships when the graph REACHES it; a root-level sibling owns nothing", () => {
  const candidates = ["src/agent/helper.server.ts", "src/web.server.ts"];
  // Reached through the graph — shipped even though a sibling owns the dir.
  assertEquals(
    serverModulePlan({
      candidates,
      graph: ["src/app.ts", "src/agent/helper.server.ts"],
      entry: "src/app.ts",
      siblingEntries: ["src/agent/app.ts"],
    }),
    { embed: candidates, skipped: [] },
  );
  // A sibling whose entry sits at the project root owns nothing: the agent
  // keeps rule 3 for a shared dir it reaches.
  assertEquals(
    serverModulePlan({
      candidates: ["lib/plugin.server.ts"],
      graph: ["src/agent/app.ts", "lib/loader.ts"],
      entry: "src/agent/app.ts",
      siblingEntries: ["main.ts"],
    }),
    { embed: ["lib/plugin.server.ts"], skipped: [] },
  );
  // No siblings: exactly the old plan.
  assertEquals(
    serverModulePlan({
      candidates,
      graph: ["src/app.ts"],
      entry: "src/app.ts",
    }),
    { embed: candidates, skipped: [] },
  );
});
