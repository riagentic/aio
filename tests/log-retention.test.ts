// log-retention.test.ts — logs are KEPT by default, and bounded by bytes.
//
// Wipe-on-start was the default, which meant the logs of the run you restarted
// BECAUSE of were destroyed by the restart — and in dev, where a cell-file save
// respawns the process, the crash you had just reproduced was erased by the
// reload that followed it. Retention is now the default, which is only a good
// default if it is BOUNDED: nothing rotates a log mid-run, so "keep the last 8
// runs" without a byte ceiling is "keep 8× unbounded" on exactly the file a
// chatty browser console fills fastest (`client.log`).
//
// Three rules, one per failure this could reintroduce:
//   1. the default keeps history (and `--no-backup-logs` still wipes),
//   2. the budget evicts the OLDEST RUN first, across kinds, never live files,
//   3. `stdout.log` — the one log the app cannot rotate — is under the policy.
import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { AioLogger } from "../src/diagnostics/logger.ts";
import {
  DEFAULT_LOG_BUDGET,
  enforceBudget,
} from "../src/diagnostics/logger-rotate.ts";
import { prepareStdoutLog } from "../src/am/am-cmd-process.ts";

const mk = (dir: string, opts: Record<string, unknown> = {}) =>
  new AioLogger({ dir, heartbeat: 0, console: false, ...opts });

const tmp = () => Deno.makeTempDir({ prefix: "aio-retain-" });
const write = (p: string, bytes: number) =>
  Deno.writeTextFile(p, "x".repeat(bytes));
const names = (dir: string) =>
  [...Deno.readDirSync(dir)].map((e) => e.name).sort();

// ── 1. the default ──────────────────────────────────────────────────────

Deno.test("logs: history is kept by default — the previous run becomes .1", async () => {
  const dir = await tmp();
  try {
    await Deno.writeTextFile(join(dir, "app.log"), "the crash you restarted\n");
    await Deno.writeTextFile(join(dir, "client.log"), "the page's console\n");

    await mk(dir).init(); // no backupLogs — the DEFAULT is what is under test

    assertEquals(
      (await Deno.readTextFile(join(dir, "app.log.1"))).trim(),
      "the crash you restarted",
      "the default must PRESERVE the previous run, not wipe it",
    );
    assertEquals(
      (await Deno.readTextFile(join(dir, "client.log.1"))).trim(),
      "the page's console",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// `.katana/_aio.md`: a default whose effect is only observable by watching the
// filesystem must never change SILENTLY. The flip is therefore announced by the
// run that benefits from it — with the flag that restores the old behaviour.
Deno.test("logs: the kept-history default announces itself, once, when it acted", async () => {
  const dir = await tmp();
  try {
    await Deno.writeTextFile(join(dir, "app.log"), "run 1\n");
    const l = mk(dir);
    await l.init();
    await l.flush();

    const said = await Deno.readTextFile(join(dir, "app.log"));
    assertEquals(
      said.includes("kept the previous run's logs") &&
        said.includes("--no-backup-logs"),
      true,
      `the boot line must name what happened AND the opt-out, got: ${said}`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("logs: a first boot says nothing — there is no previous run to keep", async () => {
  const dir = await tmp();
  try {
    const l = mk(dir);
    await l.init();
    await l.flush();
    assertEquals(
      names(dir),
      [],
      "an empty log dir must stay empty — a retention notice with nothing " +
        "retained is noise, and noise is what teaches people to skip logs",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("logs: backupLogs:false still wipes — the opt-out is real", async () => {
  const dir = await tmp();
  try {
    await Deno.writeTextFile(join(dir, "app.log"), "old\n");
    await Deno.writeTextFile(join(dir, "app.log.1"), "older\n");

    await mk(dir, { backupLogs: false }).init();

    assertEquals(
      names(dir).filter((n) => n.startsWith("app.log")),
      [],
      "opting out must clear the live file AND the archives",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ── 2. the byte ceiling ─────────────────────────────────────────────────

Deno.test("logs: the budget evicts the oldest RUN first, across kinds", async () => {
  const dir = await tmp();
  try {
    // Three runs' worth of archives, 1 KB each: run 1 is `.1` (newest).
    for (const n of [1, 2, 3]) {
      await write(join(dir, `app.log.${n}`), 1024);
      await write(join(dir, `client.log.${n}`), 1024);
    }
    await write(join(dir, "app.log"), 1024); // live — never evictable

    // Room for the live file + one run (2 archives) and nothing more.
    const r = await enforceBudget(dir, 3 * 1024);

    assertEquals(r?.removed.sort(), [
      "app.log.2",
      "app.log.3",
      "client.log.2",
      "client.log.3",
    ], "whole runs go, oldest first — never half of one");
    assertEquals(r?.over, false);
    assertEquals(
      names(dir).sort(),
      ["app.log", "app.log.1", "client.log.1"],
      "the newest run and the live file survive",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("logs: an over-budget live file is reported, never deleted", async () => {
  const dir = await tmp();
  try {
    await write(join(dir, "app.log"), 4096); // this run's evidence
    await write(join(dir, "actions.jsonl"), 1024); // shares the dir, not an archive

    const r = await enforceBudget(dir, 1024);

    assertEquals(r?.over, true, "must admit it could not fit the budget");
    assertEquals(r?.removed, []);
    assertEquals(
      names(dir),
      ["actions.jsonl", "app.log"],
      "a budget must never delete the log of the run that is happening",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("logs: budget 0 means unlimited, and the default is 200MB", async () => {
  const dir = await tmp();
  try {
    await write(join(dir, "app.log.1"), 2048);
    assertEquals(await enforceBudget(dir, 0), null);
    assertEquals(names(dir), ["app.log.1"]);
    assertEquals(DEFAULT_LOG_BUDGET, 200 * 1024 * 1024);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("logs: the budget runs at boot, so a fresh run starts inside it", async () => {
  const dir = await tmp();
  try {
    await write(join(dir, "app.log"), 2048);
    await write(join(dir, "app.log.1"), 2048);
    await write(join(dir, "app.log.2"), 2048);

    // 4 KB fits the rotation result (the just-rotated .1 and .2) and nothing
    // older — .3 (was .2) has to go.
    await mk(dir, { logBudget: 4096 }).init();

    assertEquals(
      names(dir).filter((n) => n.startsWith("app.log")).sort(),
      ["app.log.1", "app.log.2"],
      "rotate first, then bound — the oldest archive is the one dropped",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ── 3. stdout.log — rotated by am, because the app cannot ───────────────

Deno.test("logs: am rotates stdout.log before the spawn, under the same policy", async () => {
  const dir = await tmp();
  try {
    const stdout = join(dir, "stdout.log");
    await Deno.writeTextFile(stdout, "run 1 output\n");

    await prepareStdoutLog(stdout, []);

    assertEquals(
      (await Deno.readTextFile(`${stdout}.1`)).trim(),
      "run 1 output",
      "the previous run's raw output must survive an `am start`",
    );
    await assertRejects(
      () => Deno.stat(stdout),
      Deno.errors.NotFound,
      undefined,
      "the live file must be gone so the shell redirect creates a fresh one — " +
        "rotating from INSIDE the app would drag the open fd into the archive",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("logs: --no-backup-logs wipes stdout.log too — one policy, all files", async () => {
  const dir = await tmp();
  try {
    const stdout = join(dir, "stdout.log");
    await Deno.writeTextFile(stdout, "run 1\n");
    await Deno.writeTextFile(`${stdout}.1`, "run 0\n");
    await Deno.writeTextFile(`${stdout}.err`, "windows stderr\n");

    await prepareStdoutLog(stdout, ["--port=0", "--no-backup-logs"]);

    assertEquals(
      names(dir),
      [],
      "the opt-out must reach stdout.log, its archives and the Windows .err " +
        "split — a directory where one file quietly keeps history is the bug",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
