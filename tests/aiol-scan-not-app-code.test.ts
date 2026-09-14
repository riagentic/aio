// report 9 §4: aiol's `scan` hint — "examples/ hold .ts/.tsx that aiol does not
// read … Move shipped code under src/" — was the last hint left in an app whose
// `examples/` is a read-only copy of two other projects, kept deliberately. The
// advice was the one thing that must not happen, and there was no way to say
// "not mine". The app already said it: deno.json `exclude` / `fmt.exclude`, or
// `.gitignore`. A directory the app excludes is ANSWERED (a pass line naming
// the declaration), not hinted — through the same decider `am pin` uses.
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { buildContext } from "../aiol/context.ts";
import { checkScanCoverage } from "../aiol/checks.ts";

async function project(files: Record<string, string>) {
  const dir = await tempDir("aiol-not-mine-");
  for (const [rel, content] of Object.entries(files)) {
    const path = join(dir, rel);
    await Deno.mkdir(join(path, ".."), { recursive: true });
    await Deno.writeTextFile(path, content);
  }
  return dir;
}

const APP = {
  "src/cell.ts": `export const x = 1;\n`,
  "examples/opencode/index.ts": `export const vendored = 1;\n`,
};

async function scan(files: Record<string, string>) {
  const dir = await project(files);
  try {
    const { ctx, report } = await buildContext(dir);
    await checkScanCoverage(ctx);
    return {
      hints: report.issues.filter((i) => i.area === "scan"),
      passed: report.passed,
    };
  } finally {
    await dropTempDir(dir);
  }
}

Deno.test("aiol scan: an undeclared code directory is still hinted (the check still works)", async () => {
  const { hints } = await scan({ "deno.json": "{}", ...APP });
  assertEquals(hints.length, 1, JSON.stringify(hints));
  assertStringIncludes(hints[0]!.message, "examples/");
});

for (
  const [how, extra] of [
    ["deno.json fmt.exclude", {
      "deno.json": JSON.stringify({ fmt: { exclude: ["examples/"] } }),
    }],
    ["deno.json exclude", {
      "deno.json": JSON.stringify({ exclude: ["./examples"] }),
    }],
    [".gitignore", { "deno.json": "{}", ".gitignore": "/examples/\n" }],
  ] as const
) {
  Deno.test(`aiol scan: a directory excluded by ${how} is answered, not hinted`, async () => {
    const { hints, passed } = await scan({ ...extra, ...APP });
    assertEquals(hints, [], JSON.stringify(hints));
    const line = passed.find((p) => p.includes("examples/"));
    assert(
      line,
      `expected a pass line naming examples/: ${passed.join(" | ")}`,
    );
    assertStringIncludes(line, how);
  });
}

Deno.test("aiol scan: only the excluded directory is answered — a second, undeclared one is still hinted", async () => {
  const { hints } = await scan({
    "deno.json": JSON.stringify({ fmt: { exclude: ["examples"] } }),
    ...APP,
    "app/main.ts": `export const shipped = 1;\n`,
  });
  assertEquals(hints.length, 1, JSON.stringify(hints));
  assertStringIncludes(hints[0]!.message, "app/");
  assert(!hints[0]!.message.includes("examples/"), hints[0]!.message);
});

// llama.master (v1.0.0-beta pin): `client/` is a second, standalone aio app in
// the same repo with its own deno.json and its own `deno task aiol` — the
// arrangement the docs describe for a companion app. The hint was right about
// the scan and wrong about the remedy ("move shipped code under src/" would
// merge two apps). A directory with its own deno.json is its own project.
for (const config of ["deno.json", "deno.jsonc"]) {
  Deno.test(`aiol scan: a directory with its own ${config} is its own project — answered, not hinted`, async () => {
    const { hints, passed } = await scan({
      "deno.json": "{}",
      "src/cell.ts": `export const x = 1;\n`,
      [`client/${config}`]: "{}",
      "client/src/app.ts": `export const client = 1;\n`,
    });
    assertEquals(hints, [], JSON.stringify(hints));
    const line = passed.find((p) => p.includes("client/"));
    assert(line, `expected a pass line naming client/: ${passed.join(" | ")}`);
    assertStringIncludes(line, `its own project (client/${config})`);
    assertStringIncludes(line, "run aiol there");
  });
}

Deno.test("aiol scan: beside an own-project directory, one with no deno.json is still hinted", async () => {
  const { hints } = await scan({
    "deno.json": "{}",
    "src/cell.ts": `export const x = 1;\n`,
    "client/deno.json": "{}",
    "client/src/app.ts": `export const client = 1;\n`,
    "app/main.ts": `export const shipped = 1;\n`,
  });
  assertEquals(hints.length, 1, JSON.stringify(hints));
  assertStringIncludes(hints[0]!.message, "app/");
  assert(!hints[0]!.message.includes("client/"), hints[0]!.message);
});
