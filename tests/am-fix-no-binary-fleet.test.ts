// A field report: a static site (its own prerender `build`, its own `publish`) got
// `compile` and `ship` from every `am fix` — tasks that make a server binary
// and its release manifest, nothing it ships — and they came back after each
// removal. An EXPLICIT `"build": { "targets": [] }` now says "no binary": the
// binary/release tasks (build, compile, publish, ship) are not added. With no
// `build.targets` at all the browser fallback stays exactly as it was — apps
// that rely on it keep their `compile`.
import "./store-sandbox.ts";
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { cmdFix } from "../src/am/am-cmd-fix.ts";
import { parseDenoJson } from "../src/server/deno-json.ts";
import { VERSION } from "../src/server/aio-cli.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

type Doc = { results: { name: string; outcome: string; note: string }[] };

async function fixIn(
  dir: string,
  cfg: Record<string, unknown>,
): Promise<{ doc: Doc; tasks: Record<string, string> }> {
  await Deno.writeTextFile(join(dir, "deno.json"), JSON.stringify(cfg));
  await Deno.mkdir(join(dir, "src"), { recursive: true });
  await Deno.writeTextFile(
    join(dir, "src", "app.ts"),
    `import { aio } from "aio";\nawait aio.run({ appId: "x" });\n`,
  );
  const orig = Deno.cwd();
  const lines: string[] = [];
  const realLog = console.log;
  const realExit = Deno.exit;
  console.log = (...a: unknown[]) => lines.push(a.map(String).join(" "));
  Object.defineProperty(Deno, "exit", {
    value: () => {
      throw new Error("am fix exited");
    },
    configurable: true,
    writable: true,
  });
  try {
    Deno.chdir(dir);
    await cmdFix(["--no-download"], { json: true }).catch(() => {});
  } finally {
    Deno.chdir(orig);
    console.log = realLog;
    Object.defineProperty(Deno, "exit", {
      value: realExit,
      configurable: true,
      writable: true,
    });
  }
  const written = parseDenoJson(
    await Deno.readTextFile(join(dir, "deno.json")),
    "deno.json",
  );
  return {
    doc: JSON.parse(lines.at(-1)!) as Doc,
    tasks: (written.tasks ?? {}) as Record<string, string>,
  };
}

const base = {
  imports: { aio: `jsr:@riagentic/aio@${VERSION}` },
  tasks: {
    dev: "deno run -A src/app.ts",
    build: "deno run -A src/build.ts",
  },
};

Deno.test("am fix: `build.targets: []` adds no binary or release task", async () => {
  const dir = await tempDir("am-fix-no-binary-");
  try {
    const { doc, tasks } = await fixIn(dir, {
      ...base,
      build: { targets: [] },
    });
    for (const k of ["compile", "ship", "publish"]) {
      assertEquals(tasks[k], undefined, `${k} is not added`);
    }
    assertEquals(tasks.build, base.tasks.build, "the app's own build stays");
    assert(tasks.doctor && tasks.am, "the universal tasks still come");
    const r = doc.results.find((x) => x.name === "declared build targets");
    assert(r?.note.includes("no binary"), r?.note);
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("am fix: no `build.targets` at all keeps the browser fallback", async () => {
  const dir = await tempDir("am-fix-no-fleet-");
  try {
    const { tasks } = await fixIn(dir, base);
    assert(tasks.compile, "compile still added");
    assert(tasks.ship, "ship still added");
  } finally {
    await dropTempDir(dir);
  }
});
