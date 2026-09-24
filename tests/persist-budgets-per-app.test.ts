// Persistence judges a cell's size against ITS app's declared `cellState`.
//
// The manager used to read the ledger with `budgetsFor()` — "the app booting
// now" — at construction. But boot awaits between `setBudgets` (aio.ts) and
// that construction, and a second app booting in the same process sets ITS
// ledger in the gap: app A's 1.5 MB cell was then judged by app B's 64 KB
// budget (a warning A never earned, and a breach on A's `/health`), while A's
// own declaration was ignored. The ledger is now handed down explicitly
// (aio.ts → bootStorage → createPersistenceManager).
//
// A child process, booted the way a host really boots two apps: at once.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const ROOT = new URL("..", import.meta.url).pathname;

Deno.test({
  name:
    "persist budgets: two apps booted concurrently each judge their cells by their OWN cellState",
  fn: async () => {
    const root = await tempDir("aio-persist-budgets-");
    const [pa, pb] = [freePort(), freePort()];
    await Deno.writeTextFile(
      join(root, "two.ts"),
      `
import { aio, cell } from "${ROOT}mod.ts";
const mk = (name: string, size: number) => cell(name, {
  state: { blob: "" },
  methods: { grow(s: { blob: string }) { s.blob = "x".repeat(size); } },
});
const boot = (id: string, port: number, c: unknown, cellState: string) =>
  aio.run({
    appId: id,
    cells: [c],
    client: "server-only",
    port,
    budgets: { cellState },
  } as never);
// A declares 8MB and holds 1.5MB (quiet); B declares 64KB and holds 100KB (warns).
const [a, b] = await Promise.all([
  boot("budgeta", ${pa}, mk("alpha", 1_500_000), "8MB"),
  boot("budgetb", ${pb}, mk("beta", 100_000), "64KB"),
]);
await a.dispatch({ type: "alpha:grow" } as never);
await b.dispatch({ type: "beta:grow" } as never);
await a.close();
await b.close();
console.log("DONE");
Deno.exit(0);
`,
    );
    const out = await new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", "-c", `${ROOT}deno.json`, join(root, "two.ts")],
      cwd: root,
      env: { AIO_APPS_DIR: join(root, "apps"), NO_COLOR: "1" },
      stdout: "piped",
      stderr: "piped",
    }).output();
    const text = new TextDecoder().decode(out.stdout) +
      new TextDecoder().decode(out.stderr);
    try {
      assert(text.includes("DONE"), `the child did not finish:\n${text}`);
      const persistLines = text.split("\n").filter((l) =>
        l.includes("persist: cell")
      );
      assertEquals(
        persistLines.filter((l) => l.includes('"alpha"')),
        [],
        `app A's 1.5MB cell was judged by another app's budget:\n${
          persistLines.join("\n")
        }`,
      );
      assert(
        persistLines.some((l) =>
          l.includes('"beta"') && l.includes("your cellState budget")
        ),
        `app B's 100KB cell must warn against B's own 64KB budget:\n${text}`,
      );
    } finally {
      await dropTempDir(root);
    }
  },
});
