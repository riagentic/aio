// `feedback: true` captures a report automatically "when the app hits an
// error" (docs/debugging/feedback.md) — and did so only in DEV. The capture
// listens on the diagnostic bus, and in prod the bus is a no-op
// (`diagEmit` returns first thing) while the error reporter is not even wired
// to it (`setDiagEmit` was gated on `!prod`). So a shipped app — the one with
// nobody watching, which is what automatic capture is for — never wrote one:
// the same throwing method left a report in dev and nothing in prod.
//
// Run as a real app in a child process, in both modes, so the whole boot path
// (the mode, the wiring, the subscriber) is the one that ships.
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const MOD = new URL("../mod.ts", import.meta.url).href;
const CONFIG = new URL("../deno.json", import.meta.url).pathname;

async function reportsAfterAThrow(mode: "dev" | "prod"): Promise<number> {
  const home = await tempDir("aio-fb-auto-prod-");
  try {
    const app = join(home, "app.ts");
    await Deno.writeTextFile(
      app,
      `import { aio, cell } from ${JSON.stringify(MOD)};
const c = cell("boomer", {
  state: { n: 0 },
  methods: { boom(s: { n: number }) { s.n++; throw new Error("kaboom"); } },
});
await aio.run({ cells: [c], appId: "fbautoprobe", client: "server-only",
  port: ${freePort()}, feedback: true });
await (c as unknown as { boom: () => Promise<void> }).boom().catch(() => {});
const dir = Deno.env.get("AIO_APPS_DIR") + "/fbautoprobe/data/reports";
for (let i = 0; i < 50; i++) {
  try { if ([...Deno.readDirSync(dir)].length) break; } catch { /* aio-ok: not yet */ }
  await new Promise((r) => setTimeout(r, 100));
}
let n = 0;
try { n = [...Deno.readDirSync(dir)].length; } catch { /* aio-ok: none */ }
console.log("REPORTS=" + n);
Deno.exit(0);
`,
    );
    const env: Record<string, string> = {
      HOME: home,
      AIO_HOME: join(home, "aio"),
      // Its own lock dir: two runs of this probe (a mutation job beside the
      // suite) share one appId, and the lock lives outside $HOME.
      AIO_APPS_DIR: join(home, "apps"),
      AIO_VERSIONS_DIR: join(home, "versions"),
      AIO_FEEDBACK_DIR: join(home, "fb"),
      AIO_INSTALL_ROOT: join(home, "install"),
      PATH: Deno.env.get("PATH") ?? "",
      DENO_DIR: Deno.env.get("DENO_DIR") ??
        join(Deno.env.get("HOME") ?? "", ".cache", "deno"),
    };
    const out = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        "--config",
        CONFIG,
        app,
        ...(mode === "prod" ? ["--prod"] : []),
      ],
      env,
      clearEnv: true,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output();
    const text = new TextDecoder().decode(out.stdout);
    const m = text.match(/REPORTS=(\d+)/);
    if (!m) {
      throw new Error(
        `the probe app did not finish (${mode}):\n${text}\n${
          new TextDecoder().decode(out.stderr)
        }`,
      );
    }
    return Number(m[1]);
  } finally {
    await dropTempDir(home);
  }
}

Deno.test("feedback: an error is captured automatically in prod, exactly as in dev", async () => {
  assertEquals(await reportsAfterAThrow("dev"), 1, "control: dev captures");
  assertEquals(await reportsAfterAThrow("prod"), 1, "prod must capture too");
});
