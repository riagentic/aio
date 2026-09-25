// Round 3 (am): `am fix` read the config with the JSONC reader but its
// REWRITES (target→client, standard tasks, task migration) re-read it with
// `JSON.parse`. A `deno.json` using the comments Deno allows in it made each
// repair throw a raw "Expected property name or '}' in JSON at position 4",
// reported as a MANUAL blocker naming neither the file nor the cause (and
// `am fix` exited 1). A commented deno.json is now treated like deno.jsonc —
// advised, never rewritten (a JSON rewrite would destroy the comments) — and
// a plain file with a trailing comma (JSONC, no comments) is repaired.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { cmdFix } from "../src/am/am-cmd-fix.ts";
import { parseDenoJson } from "../src/server/deno-json.ts";
import { VERSION } from "../src/server/aio-cli.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

type Doc = { results: { name: string; outcome: string; note: string }[] };

async function fixIn(dir: string, text: string): Promise<Doc> {
  await Deno.writeTextFile(join(dir, "deno.json"), text);
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
  // A blocker exits 1 — observe it instead of ending the test process.
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
  return JSON.parse(lines.at(-1)!) as Doc;
}

Deno.test("am fix: a COMMENTED deno.json is advised, not a raw SyntaxError blocker", async () => {
  const dir = await tempDir("am-fix-commented-");
  try {
    const text = `{
  // why the entry is where it is
  "target": "browser",
  "imports": { "aio": "jsr:@riagentic/aio@${VERSION}" },
  "tasks": { "dev": "deno run -A src/app.ts" }
}
`;
    const doc = await fixIn(dir, text);
    const manual = doc.results.filter((r) => r.outcome === "manual");
    assertEquals(manual, [], "no blocker for a legal (commented) deno.json");
    for (
      const name of ['deno.json "target" → "client"', "standard deno tasks"]
    ) {
      const r = doc.results.find((x) => x.name === name);
      assert(r, `${name} is reported`);
      assertEquals(r.outcome, "advise", name);
      assert(r.note.includes("deno.json has comments"), r.note);
    }
    assertEquals(
      await Deno.readTextFile(join(dir, "deno.json")),
      text,
      "the comments are never silently stripped",
    );
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("am fix: a deno.json with a trailing comma (JSONC, no comments) is repaired", async () => {
  const dir = await tempDir("am-fix-trailing-comma-");
  try {
    const doc = await fixIn(
      dir,
      `{
  "target": "browser",
  "imports": { "aio": "jsr:@riagentic/aio@${VERSION}" },
  "tasks": { "dev": "deno run -A src/app.ts" },
}
`,
    );
    const r = doc.results.find((x) =>
      x.name === 'deno.json "target" → "client"'
    );
    assertEquals(r?.outcome, "fixed", r?.note);
    const cfg = parseDenoJson(
      await Deno.readTextFile(join(dir, "deno.json")),
      "deno.json",
    );
    assertEquals(cfg.client, "browser");
    assertEquals(cfg.target, undefined);
  } finally {
    await dropTempDir(dir);
  }
});
