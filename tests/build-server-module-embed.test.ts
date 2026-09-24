// A binary embeds only the `*.server.ts` its own entry can load (remote-desktop report §4).
//
// Every compiled binary used to embed EVERY `*.server.ts` in the repo: a
// public relay shipped the agent's input-injection code, each desktop app the
// relay's. The rule is `serverModulePlan`; `assetIncludes(root, entry)` is the
// I/O around it (a real `deno info` of the entry's graph). The artifact half —
// a binary still boots with what it embeds — is `test:build`'s.

import { assert, assertEquals } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { assetIncludes, serverModulePlan } from "../src/build/build-compile.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const serverFiles = (args: string[]) =>
  args.filter((a) => a !== "--include" && /\.server\.tsx?$/.test(a)).sort();

Deno.test("serverModulePlan: graph, app dir, and a reached module's dir ship — a sibling target's do not", () => {
  const plan = serverModulePlan({
    entry: "apps/relay/app.ts",
    candidates: [
      "apps/relay/io.server.ts", // under the entry's dir
      "apps/relay/deep/x.server.ts", // under it, any depth
      "shared/db.server.ts", // in the graph (static import)
      "shared/plug/opaque.server.ts", // beside a reached loader
      "apps/agent/inject.server.ts", // the OTHER target's
      "apps/agent/capture/cap.server.ts",
    ],
    graph: [
      "apps/relay/app.ts",
      "shared/db.server.ts",
      "shared/plug/loader.ts",
    ],
  });
  assertEquals(plan.embed, [
    "apps/relay/io.server.ts",
    "apps/relay/deep/x.server.ts",
    "shared/db.server.ts",
    "shared/plug/opaque.server.ts",
  ]);
  assertEquals(plan.skipped, [
    "apps/agent/inject.server.ts",
    "apps/agent/capture/cap.server.ts",
  ]);
});

Deno.test("serverModulePlan: an unreadable graph embeds everything (bigger, never broken)", () => {
  const candidates = ["a/x.server.ts", "b/y.server.ts"];
  assertEquals(
    serverModulePlan({ entry: "a/app.ts", candidates, graph: null }),
    { embed: candidates, skipped: [] },
  );
});

Deno.test("serverModulePlan: an entry at the project root keeps the whole tree", () => {
  const plan = serverModulePlan({
    entry: "app.ts",
    candidates: ["src/x.server.ts", "tools/y.server.ts"],
    graph: ["app.ts"],
  });
  assertEquals(plan.skipped, []);
});

Deno.test("assetIncludes(root, entry): two sibling targets each embed only their own reachable *.server.ts", async () => {
  const root = await tempDir("aio-srvembed-");
  try {
    const w = async (rel: string, src: string) => {
      await Deno.mkdir(join(root, rel, ".."), { recursive: true });
      await Deno.writeTextFile(join(root, rel), src);
    };
    await w("deno.json", "{}");
    // relay: a static import, an analysable dynamic one, and a shared lib.
    await w(
      "src/relay/app.ts",
      `import "./socket.server.ts";\nimport "../shared/proto.ts";\n` +
        `export const go = () => import("./tables.server.ts");\n`,
    );
    await w("src/relay/socket.server.ts", "export const s = 1;\n");
    await w("src/relay/tables.server.ts", "export const t = 1;\n");
    // shared: a loader whose sibling is reached only through an OPAQUE
    // specifier (invisible to the graph) — the case the old walk existed for.
    await w(
      "src/shared/proto.ts",
      `const u = new URL("./codec.server.ts", import.meta.url).href;\n` +
        `export const load = () => import(u);\n`,
    );
    await w("src/shared/codec.server.ts", "export const c = 1;\n");
    // agent: its own server code, reached only from its own entry.
    await w(
      "src/agent/app.ts",
      `import "./input/inject.server.ts";\nimport "../shared/proto.ts";\n`,
    );
    await w("src/agent/input/inject.server.ts", "export const i = 1;\n");
    await w("src/agent/capture.server.ts", "export const cap = 1;\n");

    const relay = serverFiles(await assetIncludes(root, "src/relay/app.ts"));
    const agent = serverFiles(await assetIncludes(root, "src/agent/app.ts"));
    assertEquals(relay, [
      "src/relay/socket.server.ts",
      "src/relay/tables.server.ts",
      "src/shared/codec.server.ts",
    ]);
    assertEquals(agent, [
      "src/agent/capture.server.ts",
      "src/agent/input/inject.server.ts",
      "src/shared/codec.server.ts",
    ]);
    // No entry → the old whole-tree walk (the public signature's contract).
    const all = serverFiles(await assetIncludes(root));
    assertEquals(all.length, 5);
    assert(all.includes("src/agent/input/inject.server.ts"));
  } finally {
    await dropTempDir(root);
  }
});

Deno.test("assetIncludes: every compile path in src/ passes its entry — no target embeds the whole tree", () => {
  // The walk is scoped only when a caller hands it the entry; the CLI target
  // once called `assetIncludes(root)` and kept shipping every sibling target's
  // server code after the app compile stopped (remote-desktop report §4). A property over all
  // call sites, not a pin on today's two.
  const src = new URL("../src/", import.meta.url);
  const bare: string[] = [];
  const files = (dir: string): string[] =>
    [...Deno.readDirSync(dir)].flatMap((e) =>
      e.isDirectory
        ? files(join(dir, e.name))
        : e.name.endsWith(".ts")
        ? [join(dir, e.name)]
        : []
    );
  for (const path of files(fromFileUrl(src))) {
    const text = Deno.readTextFileSync(path);
    for (const m of text.matchAll(/await assetIncludes\((.*)$/gm)) {
      if (!(m[1] ?? "").includes(",")) bare.push(`${path}: ${m[0]}`);
    }
  }
  assertEquals(bare, [], "a compile path that forgets its entry embeds all");
});
