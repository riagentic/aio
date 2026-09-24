// A component's app id is the id its process RUNS under — nothing else.
//
// `projectComponents` named a component whose entry declares no appId after
// its build TARGET name (`"name": "multi-agent"`). The runtime never reads
// that: `name` renames the binary, not the app (docs/build/targets.md), so
// the process booted as the PROJECT's app. `am start` then waited on an id
// nothing ran under ("still starting after 20s … a cold start may need
// --wait=60"), never started the remaining components, and
// `componentConflict` could not see that two entries were one app.
//
// Pinned against the runtime's own answer: each fixture entry calls the
// server's `resolveAppId()` exactly as `aio.run()` does, launched the way
// `am start` launches it (cwd = the project root).
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  componentAppId,
  componentConflict,
  processPlan,
  projectComponents,
} from "../src/am/am-components.ts";
import { componentProgressLine } from "../src/am/am-cmd-process.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const LOCK = new URL("../src/server/single-instance-lock.ts", import.meta.url)
  .href;
const CONFIG = new URL("../deno.json", import.meta.url).pathname;
const PROBE = `import { resolveAppId } from ${JSON.stringify(LOCK)};\n` +
  `console.log(resolveAppId());\n`;

async function runtimeId(root: string, entry: string): Promise<string> {
  const o = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "--config", CONFIG, entry],
    cwd: root,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  const d = new TextDecoder();
  assert(o.success, d.decode(o.stderr));
  return d.decode(o.stdout).trim();
}

async function project(
  cfg: Record<string, unknown>,
  entries: string[],
): Promise<string> {
  const root = join(await tempDir("aio-comp-id-"), "Proj Dir");
  await Deno.mkdir(root);
  await Deno.writeTextFile(join(root, "deno.json"), JSON.stringify(cfg));
  for (const e of entries) {
    await Deno.mkdir(join(root, e, ".."), { recursive: true });
    await Deno.writeTextFile(join(root, e), PROBE);
  }
  return root;
}

const TARGETS = {
  web: { kind: "browser", entry: "src/app.ts" },
  agent: { kind: "server", entry: "src/agent/app.ts", name: "multi-agent" },
  tool: { kind: "server", entry: "tools/cli/main.ts", name: "the-tool" },
};
const ENTRIES = ["src/app.ts", "src/agent/app.ts", "tools/cli/main.ts"];

for (
  const [what, cfg] of [
    ["a titled project", { title: "Multi", build: { targets: TARGETS } }],
    ["a named project", { name: "@x/multi-name", build: { targets: TARGETS } }],
    ["a project with no identity field", { build: { targets: TARGETS } }],
  ] as const
) {
  Deno.test(`componentAppId: ${what} — am's id is the runtime's, per entry`, async () => {
    const root = await project(cfg, ENTRIES);
    try {
      for (const e of ENTRIES) {
        assertEquals(
          componentAppId(root, join(root, e)),
          await runtimeId(root, join(root, e)),
          e,
        );
      }
    } finally {
      await dropTempDir(join(root, ".."));
    }
  });
}

Deno.test("componentAppId: an entry's own appId is its id; a target name never is", () => {
  assertEquals(
    componentAppId("/nope", "/nope/src/a/app.ts", "My Relay"),
    "my-relay",
  );
});

Deno.test("components: two entries without an appId in a titled project are ONE app — refused up front", async () => {
  const root = await project(
    { title: "multi", build: { targets: TARGETS } },
    ENTRIES,
  );
  try {
    const cs = projectComponents(root);
    assertEquals(cs.map((c) => c.appId), ["multi", "multi", "multi"]);
    const conflict = componentConflict(cs)!;
    assertStringIncludes(conflict, '"multi" ← web, agent, tool');
    assertStringIncludes(conflict, "renames the binary, not the app");
    assert(!conflict.includes('distinct "name"'), conflict);
    // …and why an entry that DOES pick its own id through a helper is seen
    // as having none (field report, a two-edition app).
    assertStringIncludes(conflict, "computed at run time");
    assertEquals(processPlan([], {}, root).kind, "error");
  } finally {
    await dropTempDir(join(root, ".."));
  }
});

Deno.test("componentProgressLine: a project half up names what is up, what failed, what was never tried", () => {
  assertEquals(componentProgressLine("start", ["web"], 0), null);
  assertEquals(componentProgressLine("start", ["web", "agent"], 2), null);
  const l = componentProgressLine("start", ["web", "agent", "tool"], 1)!;
  assertStringIncludes(l, 'failed at "agent"');
  assertStringIncludes(l, "started: web");
  assertStringIncludes(l, "not attempted: tool");
  const r = componentProgressLine("restart", ["web", "agent"], 0)!;
  assertStringIncludes(r, 'restart failed at "web"');
  assertStringIncludes(r, "not attempted: agent");
  assert(!r.includes("restarted:"), r);
});
