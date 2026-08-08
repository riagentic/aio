// aiol scans a project's TOOLING (scripts/, tools/) — and knows it is tooling.
//
// Before this, the scan started and stopped at src/ + cells/ + root files, so
// the code that decides what ships (build scripts, release gates, benchmarks)
// was the one part the linter never read. Extending the scan naively made
// things WORSE, though: rules whose premise is "a user is waiting on this"
// fired 11 times in scripts/ on a first run — "sync I/O blocks the event loop,
// every client's next action waits behind it" in a one-shot CLI, "use
// structured logging" at a gate whose stdout IS its interface. A linter that is
// loudest where the stakes are lowest stops being read.
//
// So: scan tooling, and skip exactly the rules whose premise is false there.
import { assert } from "@std/assert";
import { join } from "@std/path";
import { buildContext, isToolingPath, looksLikeApp } from "../aiol/context.ts";
import { checkPerformance, checkTesting } from "../aiol/checks.ts";

/** The same offending source, once as app code and once as tooling. */
const CELL_WITH_SYNC_IO_AND_LOGS = `
import { cell } from "aio";
export const probe = cell("probe", {
  state: { n: 0 },
  methods: {
    scan(s) {
      const files = Deno.readDirSync(".");
      console.log("scanning", files);
      setTimeout(() => s.n++, 50);
    },
  },
});
`;

async function project(dir: string): Promise<void> {
  await Deno.mkdir(join(dir, "src"), { recursive: true });
  await Deno.mkdir(join(dir, "scripts"), { recursive: true });
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify({ imports: { aio: "jsr:@riagentic/aio@1.0.0" } }),
  );
  await Deno.writeTextFile(
    join(dir, "src", "probe.ts"),
    CELL_WITH_SYNC_IO_AND_LOGS,
  );
  await Deno.writeTextFile(
    join(dir, "scripts", "gate.ts"),
    CELL_WITH_SYNC_IO_AND_LOGS.replace('cell("probe"', 'cell("gate"'),
  );
}

async function withProject(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "aiol-tooling-" });
  try {
    await project(dir);
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("isToolingPath: the rule, and what it deliberately excludes", () => {
  assert(isToolingPath("scripts/bench.ts"));
  assert(isToolingPath("tools/codegen.ts"));
  assert(isToolingPath("scripts\\bench.ts"), "windows separators");
  assert(!isToolingPath("src/app.ts"));
  assert(!isToolingPath("cells/counter.ts"));
  // Not a prefix match on the bare word: an APP directory that merely starts
  // with the same letters is app code.
  assert(!isToolingPath("src/scripts/loader.ts"));
  assert(!isToolingPath("scriptsy/thing.ts"));
});

Deno.test("aiol: scripts/ is SCANNED", async () => {
  await withProject(async (dir) => {
    const { ctx } = await buildContext(dir);
    assert(
      ctx.sourceFiles.some((f) =>
        f.relative.replaceAll("\\", "/") === "scripts/gate.ts"
      ),
      `scripts/ must be scanned — saw ${
        ctx.sourceFiles.map((f) => f.relative)
      }`,
    );
  });
});

Deno.test("aiol: premise-bound rules fire in src/ and NOT in tooling", async () => {
  await withProject(async (dir) => {
    const { ctx, report } = await buildContext(dir);
    checkPerformance(ctx);
    const inSrc = report.issues.filter((i) => i.file?.includes("src/"));
    const inScripts = report.issues.filter((i) => i.file?.includes("scripts/"));

    for (
      const premise of ["sync I/O", "console.log", "setTimeout/setInterval"]
    ) {
      assert(
        inSrc.some((i) => i.message.includes(premise)),
        `"${premise}" must still fire on app code — otherwise this test proves nothing`,
      );
      assert(
        !inScripts.some((i) => i.message.includes(premise)),
        `"${premise}" must not fire on tooling: ${
          inScripts.map((i) => i.message).join(" | ")
        }`,
      );
    }
  });
});

Deno.test("aiol: a cell defined in tooling is a fixture, not an untested cell", async () => {
  await withProject(async (dir) => {
    const { ctx, report } = await buildContext(dir);
    checkTesting(ctx);
    const untested = report.issues.filter((i) =>
      i.message.includes("has no test file")
    );
    assert(
      untested.some((i) => i.message.includes('"probe"')),
      "an untested app cell is still a hint",
    );
    assert(
      !untested.some((i) => i.message.includes('"gate"')),
      "a benchmark's cell is a fixture — demanding gate.test.ts is noise",
    );
  });
});

// ── App-shaped rules only fire at APPS ───────────────────────────────────────
// Three rules presuppose a dispatch loop with clients on it: "no entry point
// found (src/app.ts)", "move appId into aio.run()", and "sync I/O blocks every
// client's next action". Against aio's OWN repo the first two describe a call
// that does not exist there, and the third fired on boot-once pre-flight,
// shutdown checkpoints and the journal — whose synchrony is the point (each
// append fsyncs so it survives SIGKILL). That was 84 of 85 warnings, which is
// how a true warning gets trained away.

Deno.test("looksLikeApp: aio's own repo is not an app; a consumer is", () => {
  assert(!looksLikeApp({ name: "@riagentic/aio" }), "by package name");
  assert(!looksLikeApp({ imports: { aio: "./mod.ts" } }), "by self-import");
  assert(looksLikeApp({ imports: { aio: "jsr:@riagentic/aio@1.0.0" } }));
  assert(
    looksLikeApp({ imports: { aio: "./dep/aio/mod.ts" } }),
    "a source-linked app vendors the framework — still an app",
  );
  assert(
    looksLikeApp(null),
    "unknown must stay an app: silencing is the worse error",
  );
});

Deno.test("aiol: an APP still gets the app-shaped warnings", async () => {
  await withProject(async (dir) => {
    const { ctx, report } = await buildContext(dir);
    assert(ctx.isApp, "the fixture imports aio from jsr — it is an app");
    checkPerformance(ctx);
    assert(
      report.issues.some((i) => i.message.includes("sync I/O")),
      "narrowing the rule must not silence the case it exists for",
    );
  });
});

Deno.test("aiol: the framework repo gets none of them", async () => {
  await withProject(async (dir) => {
    // Same sources, one line of deno.json different.
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({ name: "@riagentic/aio", imports: { aio: "./mod.ts" } }),
    );
    const { ctx, report } = await buildContext(dir);
    assert(!ctx.isApp, "this deno.json is the framework's own");
    checkPerformance(ctx);
    assert(
      !report.issues.some((i) => i.message.includes("sync I/O")),
      `a repo with no dispatch loop has nothing blocking it: ${
        report.issues.map((i) => i.message).join(" | ")
      }`,
    );
  });
});
