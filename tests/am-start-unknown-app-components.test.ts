// `am start --app=<unknown id>` in a project of COMPONENTS: `processPlan`
// matched `--app` against the components, found none, and `am start` then ran
// the project's DEFAULT entry under the unknown id (a second lock, a `--fresh`
// home named after the typo) — the single-entry refusal skipped component
// projects entirely. Now judged by the same rule, naming the components.
import "./store-sandbox.ts";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { appFlagRefusal } from "../src/am/am-cmd-start.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

Deno.test("am start --app=<unknown> in a component project is refused", async () => {
  const dir = await tempDir("am-start-comp-app-");
  const cwd = Deno.cwd();
  try {
    await Deno.mkdir(join(dir, "src"), { recursive: true });
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({
        appId: "realid",
        build: {
          targets: {
            server: {},
            agent: { kind: "server", entry: "src/agent.ts" },
          },
        },
      }),
    );
    await Deno.writeTextFile(join(dir, "src", "app.ts"), "Deno.exit(0);\n");
    await Deno.writeTextFile(
      join(dir, "src", "agent.ts"),
      `aio.run({ appId: "agentid" });\n`,
    );
    Deno.chdir(dir);
    const bad = appFlagRefusal({ app: "nope" }, dir);
    assert(bad, "an unknown --app ran the default entry under its id");
    assertStringIncludes(bad, "--app=nope names no app of this project");
    assertStringIncludes(bad, "realid");
    assertStringIncludes(bad, "agent");
    // A component (label or id) and the default entry's own id still pass.
    for (const app of ["agent", "agentid", "realid", "server"]) {
      assertEquals(appFlagRefusal({ app }, dir), null, app);
    }
  } finally {
    Deno.chdir(cwd);
    await dropTempDir(dir);
  }
});
