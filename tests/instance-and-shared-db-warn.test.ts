// Two ways one state.db is shared without a word (hunt 2026-10-25, R2):
//
// 1. `--instance=<name>` is a private copy because AIO_APPS_DIR moves the
//    DERIVED home. An app that pins appDir or dbPath outside the instance's
//    root kept opening the everyday data while its lock lived in the
//    instance's scope — two live processes on one database. Now warned.
// 2. Two appIds given one dbPath share the `persistKey` row: the second boot
//    loaded the first app's cells, whichever saved last won. Now warned (and
//    only when both write the SAME persistKey).
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { spec } from "./module-spec-helper.ts";

const REPO = fromFileUrl(new URL("..", import.meta.url)).replace(/[\\/]$/, "");

const PROBE = `import { aio, cell } from "${spec(REPO)}/mod.ts";
const c = cell("c", { state: { n: 0 }, methods: { inc(s: { n: number }) { s.n++; } } });
const cfg = JSON.parse(Deno.env.get("PROBE_CFG") ?? "{}");
await aio.run({ cells: [c], ...cfg, client: "server-only", port: 0 });
await c.inc();
// Ends the process itself, after the final snapshot.
await aio.stop();
`;

/** The cache this run already has — a moved HOME must not re-download. */
const DENO_DIR = JSON.parse(
  new TextDecoder().decode(
    (await new Deno.Command(Deno.execPath(), {
      args: ["info", "--json"],
      stdout: "piped",
      stderr: "null",
    }).output()).stdout,
  ),
).denoDir as string;

async function boot(
  root: string,
  cfg: Record<string, unknown>,
  args: string[] = [],
): Promise<{ code: number; out: string }> {
  const home = join(root, "home");
  const r = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      `--config=${join(REPO, "deno.json")}`,
      join(root, "app.ts"),
      ...args,
    ],
    cwd: root,
    env: {
      DENO_DIR,
      HOME: home,
      USERPROFILE: home,
      AIO_APPS_DIR: "",
      AIO_PROFILE: "",
      PROBE_CFG: JSON.stringify(cfg),
    },
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: r.code,
    out: new TextDecoder().decode(r.stdout) +
      new TextDecoder().decode(r.stderr),
  };
}

async function project(): Promise<string> {
  const root = await tempDir("aio-shared-db-");
  await Deno.mkdir(join(root, "home"));
  await Deno.writeTextFile(join(root, "app.ts"), PROBE);
  return root;
}

Deno.test("--instance with a pinned appDir or dbPath says it is not isolated", async () => {
  const root = await project();
  try {
    const main = join(root, "home", ".ip");
    const byDir = await boot(root, { appId: "ip", appDir: main }, [
      "--instance=x",
    ]);
    assertEquals(byDir.code, 0, byDir.out);
    assertStringIncludes(byDir.out, "--instance=x is NOT isolated");
    assertStringIncludes(byDir.out, `appDir ${main}`);
    const db = join(main, "data", "state.db");
    const byDb = await boot(root, { appId: "ip", dbPath: db }, [
      "--instance=x",
    ]);
    assertEquals(byDb.code, 0, byDb.out);
    assertStringIncludes(byDb.out, `pins its dbPath ${db}`);
    // Derived paths ARE private: no word.
    const plain = await boot(root, { appId: "ip" }, ["--instance=x"]);
    assertEquals(plain.code, 0, plain.out);
    assert(!plain.out.includes("NOT isolated"), plain.out);
  } finally {
    await dropTempDir(root);
  }
});

Deno.test("two appIds on one dbPath: the second boot names the first", async () => {
  const root = await project();
  try {
    const db = join(root, "shared", "state.db");
    const a = await boot(root, { appId: "app-a", dbPath: db });
    assertEquals(a.code, 0, a.out);
    assert(!a.out.includes("also holds the stored state"), a.out);
    const b = await boot(root, { appId: "app-b", dbPath: db });
    assertEquals(b.code, 0, b.out);
    assertStringIncludes(
      b.out,
      `also holds the stored state of app "app-a" under the same persistKey ` +
        `"state"`,
    );
    // Its own key: a different document, nothing shared, no word.
    const c = await boot(root, {
      appId: "app-c",
      dbPath: db,
      persistKey: "c-state",
    });
    assertEquals(c.code, 0, c.out);
    assert(!c.out.includes("also holds the stored state"), c.out);
    // The offline reader (`am state --offline`) reads the document app-c
    // stamped — it used to guess "state" (app-a/app-b's) from the rows.
    const { readStoredState } = await import("../src/server/stored-state.ts");
    assertEquals(await readStoredState(db, "app-c"), { c: { n: 1 } });
    // …and app-a, rebooted, is told about app-b (not about app-c).
    const again = await boot(root, { appId: "app-a", dbPath: db });
    assertStringIncludes(again.out, `of app "app-b" under`);
    assert(!again.out.includes(`"app-c"`), again.out);
  } finally {
    await dropTempDir(root);
  }
});

Deno.test("shape-drift refusal offers --instance only when it would move the data", async () => {
  const { shapeDriftRefusal } = await import("../src/server/boot-restore.ts");
  const drift = [{
    cell: "c",
    path: "x",
    issue: "unknown-field" as const,
    storedType: "number",
  }];
  const store = { dataDir: "/srv/a/data", dbPath: "/srv/a/data/state.db" };
  const at = (extra: Record<string, unknown>) =>
    shapeDriftRefusal(drift, "s", { ...store, ...extra });
  assertStringIncludes(at({}), "--instance=<name>");
  assert(!at({ pinned: true }).includes("--instance"), at({ pinned: true }));
});
