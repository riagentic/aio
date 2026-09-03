// The [fixable] / [manual] distinction — a safe fix that deliberately
// DECLINES a site (the effect rewrite skips any method whose draft param is
// not literally `s`, e.g. `startPoll(_s)`) must not keep rendering [fixable]:
// after repeated --safe-fix runs the surviving marker read as "tool failed".
// Declined-by-design sites carry Issue.manual (with the reason), set by the
// RULE via the same predicate the fix declines on — never guessed at render
// time.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { lintProject, printReport } from "../aiol/mod.ts";

const PROJECT: Record<string, string> = {
  "deno.json": JSON.stringify(
    {
      title: "manualmark",
      version: "0.1.0",
      nodeModulesDir: "auto",
      imports: { aio: "jsr:@riagentic/aio@1.0.0" },
      tasks: { dev: "deno run -A src/app.ts", test: "deno test -A tests/" },
    },
    null,
    2,
  ),
  "src/app.ts":
    `import { aio } from "aio";\nimport { poller } from "./cell.ts";\nawait aio.run({ appId: "manualmark", cells: { poller } });\n`,
  // TWO return-effect sites: `startPoll(_s)` is the fix's documented decline
  // (the rewrite targets s.$do and must not rename params); `go(s)` is
  // genuinely fixable.
  "src/cell.ts": `import { cell, schedule } from "aio";

export const poller = cell("poller", {
  state: { n: 0 },
  methods: {
    startPoll(_s) {
      return schedule.after(1000, "tick");
    },
    go(s) {
      s.n = s.n + 1;
      return schedule.after(10, "tick");
    },
    tick(s) {
      s.n = s.n + 1;
    },
  },
});
`,
};

async function write(dir: string, files: Record<string, string>) {
  for (const [rel, body] of Object.entries(files)) {
    const p = join(dir, rel);
    await Deno.mkdir(join(p, ".."), { recursive: true });
    await Deno.writeTextFile(p, body);
  }
}

const effectIssues = (r: Awaited<ReturnType<typeof lintProject>>) =>
  r.issues.filter((i) => i.message.includes("return effect(s) from a method"));

Deno.test("aiol: a declined-by-design site is [manual] with the reason; a fixable one converges to zero", async () => {
  const dir = await Deno.makeTempDir({ prefix: "aiol-manual-" });
  try {
    await write(dir, PROJECT);
    const report = await lintProject(dir);
    const sites = effectIssues(report);
    assertEquals(sites.length, 2, "both return-effect sites are reported");

    // The startPoll(_s) site: declined by design — manual + reason, NO
    // safeFix (so --safe-fix never counts it as pending).
    const declined = sites.find((i) => i.manual);
    assert(declined, "the _s site must carry Issue.manual");
    assertStringIncludes(declined.manual!, "'_s'");
    assertEquals(
      declined.safeFix,
      undefined,
      "declined-by-design must not also claim to be fixable",
    );
    assertStringIncludes(
      declined.fix ?? "",
      "rename the draft param '_s'",
      "the reason says what to do by hand",
    );

    // The go(s) site: genuinely fixable — safeFix, no manual.
    const fixable = sites.find((i) => i.safeFix);
    assert(fixable, "the s site stays auto-fixable");
    assertEquals(fixable.manual, undefined);

    // The human report renders the two markers distinctly.
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => lines.push(a.map(String).join(" "));
    try {
      printReport(report, false, true);
    } finally {
      console.log = orig;
    }
    const text = lines.join("\n");
    assertStringIncludes(text, "[manual]");
    assertStringIncludes(text, "[fixable]");

    // Convergence: apply every offered fix, re-lint — the fixable site is
    // GONE, the declined one remains [manual], and NOTHING still claims
    // [fixable] (the exact loop the field report ran).
    for (const i of report.issues.filter((i) => i.safeFix)) {
      await i.safeFix!(dir);
    }
    const after = await lintProject(dir);
    const sitesAfter = effectIssues(after);
    assertEquals(
      sitesAfter.length,
      1,
      "the fixable site converged; the declined one remains",
    );
    assert(sitesAfter[0]!.manual, "the survivor is marked declined-by-design");
    assertEquals(
      sitesAfter.filter((i) => i.safeFix).length,
      0,
      "after --safe-fix, no return-effect site may still render [fixable]",
    );
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
