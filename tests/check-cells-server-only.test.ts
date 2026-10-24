// `checkCells(cells)` checked every app as a browser app: a server-only app
// (no App.tsx, as it should be) got `fail: App.tsx not found`. Without an
// explicit `headless` it now asks the client decider `aio.run` uses — the
// app's deno.json `client` (what `am create --target=server` writes) — so it
// reports what the boot of that app would.
import { assert, assertEquals } from "@std/assert";
import { fromFileUrl, join, toFileUrl } from "@std/path";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const REPO = fromFileUrl(new URL("..", import.meta.url));

async function checkIn(
  client: string | undefined,
): Promise<{ ok: string[]; fail: string[]; hint: string[] }> {
  const dir = await tempDir("aio-checkcells-headless-");
  try {
    const repoJson = JSON.parse(
      await Deno.readTextFile(join(REPO, "deno.json")),
    );
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({
        ...(client ? { client } : {}),
        imports: repoJson.imports,
      }),
    );
    const mod = toFileUrl(join(REPO, "mod.ts")).href;
    const extras = toFileUrl(join(REPO, "src/extras/mod.ts")).href;
    await Deno.writeTextFile(
      join(dir, "check.ts"),
      `import { cell } from "${mod}";\nimport { checkCells } from "${extras}";\n` +
        `const c = cell("cs", { state: { n: 0 }, methods: { inc(s) { s.n++; } } });\n` +
        `console.log(JSON.stringify(await checkCells([c], {}, ${
          JSON.stringify(dir)
        })));\n`,
    );
    const o = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        "--config",
        join(dir, "deno.json"),
        join(dir, "check.ts"),
      ],
      cwd: dir,
      stdout: "piped",
      stderr: "piped",
    }).output();
    const out = new TextDecoder().decode(o.stdout).trim().split("\n").pop()!;
    assertEquals(o.code, 0, new TextDecoder().decode(o.stderr));
    return JSON.parse(out);
  } finally {
    await dropTempDir(dir);
  }
}

Deno.test("checkCells(cells): a deno.json `client: server`/`cli` app is checked headless; the default still names the missing App.tsx and the way out", async () => {
  for (const client of ["server", "cli"]) {
    const r = await checkIn(client);
    assertEquals(r.fail, [], `${client}: ${r.fail.join(" | ")}`);
    assert(r.ok.some((l) => l.startsWith("headless")), r.ok.join(" | "));
  }
  const browser = await checkIn(undefined);
  assert(browser.fail.some((f) => f.includes("App.tsx not found")));
  assert(browser.hint.some((h) => h.includes('"client": "server"')));
});
