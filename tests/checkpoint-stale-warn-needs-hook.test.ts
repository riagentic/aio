// An OLD dev checkpoint is worth a WARN only when something is about to apply
// it. Field report (a desktop agent app, §1): an app with NO `onCheckpointRestore` got
// "diagnostic snapshot is Nm old — applied only via onCheckpointRestore;
// consider starting fresh" as a WARN on every boot — a line that asked for no
// action, about a file nothing would read. Now:
//   no hook  → one INFO line (a fact), no WARN
//   hook set → the WARN, from the restore step, before the old state lands
// Driven as a real app in a subprocess, because the WARN lives in the boot
// path (aio-boot.ts step 6), not in `initDiagnostics`.
import { assert, assertEquals } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import { tempDir } from "../src/testing/temp-dir.ts";
import {
  CHECKPOINT_STALE_MS,
  staleCheckpointWarning,
} from "../src/diagnostics/mod.ts";

const REPO = join(import.meta.dirname!, "..");
const url = (rel: string) => toFileUrl(join(REPO, rel)).href;

const PROBE = `// deno-lint-ignore-file no-explicit-any
const { cell } = await import(${
  JSON.stringify(url("src/state/cell-create.ts"))
});
const { aio } = await import(${JSON.stringify(url("mod.ts"))});
const { freePort } = await import(${
  JSON.stringify(url("src/testing/server-test.ts"))
});
const box = cell("box", { state: { v: 0 }, methods: { bump(s: any) { s.v++; } } });
const app: any = await aio.run({
  cells: [box], appId: "cp-stale", appDir: Deno.env.get("DIR"),
  client: "server-only", libraryMode: true, port: freePort(),
  diagnostics: { dev: { actionLog: false, checkpoint: { debounce: 0 } } },
  ...(Deno.env.get("HOOK") === "1"
    ? { onCheckpointRestore: (cp: any) => cp.state }
    : {}),
} as any);
console.log("STATE " + JSON.stringify(app.getState()));
Deno.exit(0);
`;

async function boot(dir: string, hook: boolean): Promise<string> {
  const probe = join(dir, "probe.ts");
  await Deno.writeTextFile(probe, PROBE);
  const out = await new Deno.Command("deno", {
    args: ["run", "-A", "--config", join(REPO, "deno.json"), probe],
    env: {
      DIR: dir,
      AIO_APPS_DIR: dir,
      AIO_NO_OPEN: "1",
      HOOK: hook ? "1" : "0",
    },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const text = new TextDecoder().decode(out.stdout) +
    new TextDecoder().decode(out.stderr);
  assert(text.includes("STATE "), `no state line (exit ${out.code})\n${text}`);
  return text;
}

async function staleCheckpoint(dir: string): Promise<void> {
  await Deno.writeTextFile(
    join(dir, "logs", "checkpoint.json"),
    JSON.stringify({
      ts: Date.now() - 3 * CHECKPOINT_STALE_MS,
      state: { box: { v: 41 } },
      recentActions: [],
      cells: {},
    }),
    { mode: 0o600 },
  );
}

const warnLines = (text: string) =>
  text.split("\n").filter((l) => /\bWARN\b/i.test(l) && /checkpoint/i.test(l));

Deno.test("checkpoint age: a stale snapshot with NO onCheckpointRestore logs INFO, never WARN", async () => {
  const dir = await tempDir("cp-stale-nohook-");
  await boot(dir, false); // creates the data layout
  await staleCheckpoint(dir);
  const text = await boot(dir, false);
  assertEquals(
    warnLines(text),
    [],
    `a WARN about a snapshot nothing will apply:\n${text}`,
  );
  assert(
    /diagnostic snapshot from \d+m ago \(applied only if onCheckpointRestore is set\)/
      .test(text),
    `the INFO fact is missing:\n${text}`,
  );
});

Deno.test("checkpoint age: a stale snapshot WITH onCheckpointRestore warns before it is applied", async () => {
  const dir = await tempDir("cp-stale-hook-");
  await boot(dir, true);
  await staleCheckpoint(dir);
  const text = await boot(dir, true);
  const warns = warnLines(text);
  assert(
    warns.some((l) =>
      l.includes("-old diagnostic snapshot to onCheckpointRestore")
    ),
    `no WARN though the hook is about to get 3h-old state:\n${text}`,
  );
  assert(text.includes('"v":41'), `control: the hook applied it:\n${text}`);
});

Deno.test("checkpoint age: staleCheckpointWarning is null while fresh, a message once old", () => {
  const now = 10 * CHECKPOINT_STALE_MS;
  assertEquals(staleCheckpointWarning(now - 1000, now), null);
  assertEquals(staleCheckpointWarning(now - CHECKPOINT_STALE_MS, now), null);
  const w = staleCheckpointWarning(now - 2 * CHECKPOINT_STALE_MS, now);
  assert(w?.includes("120m-old"), String(w));
});
