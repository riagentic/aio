// amui's CPU chart plots one psStats sample per second. `ps -o %cpu` is the
// LIFETIME average (cpu time / elapsed), so the chart could never show what the
// app is doing NOW: an app that went idle after a busy boot read ~66% while it
// did nothing, and one pegged at 100% after an idle stretch read a fraction.
// Consecutive samples of one process report the cpu used BETWEEN them.
import { assert } from "@std/assert";
import { psStats } from "../amui/src/server/proc.server.ts";

const IDLE_MS = 4000;

const cpuOf = async (pid: number) => (await psStats(pid))?.cpuPct ?? NaN;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.test({
  name:
    "amui psStats: a later sample is the cpu used since the previous one, not the lifetime average",
  async fn() {
    // Busy for the first IDLE_MS, then idle for good.
    const child = new Deno.Command(Deno.execPath(), {
      args: [
        "eval",
        `const end = Date.now() + ${IDLE_MS}; while (Date.now() < end) {} setTimeout(() => {}, 60000);`,
      ],
      stdout: "null",
      stderr: "null",
    }).spawn();
    try {
      await wait(IDLE_MS + 1000);
      await cpuOf(child.pid); // the first sample of this pid: no interval yet
      await wait(1000);
      const idle = await cpuOf(child.pid);
      assert(
        idle < 20,
        `an idle process read ${idle}% — the lifetime average, not the last second`,
      );
    } finally {
      child.kill("SIGKILL");
      await child.status;
    }
  },
});

Deno.test({
  name: "amui psStats: a process that turns busy after idling reads busy",
  async fn() {
    const spawn = (code: string) =>
      new Deno.Command(Deno.execPath(), {
        args: ["eval", code],
        stdout: "null",
        stderr: "null",
      }).spawn();
    const child = spawn(`setTimeout(() => { for (;;) {} }, ${IDLE_MS});`);
    // What a spinning process gets on THIS machine right now: a whole core
    // when it is idle, a share of one under load (52% in a parallel suite on
    // Windows) — so "busy" is measured against a process that only spins,
    // sampled over the same second, not against a fixed 60%.
    const spinner = spawn("for (;;) {}");
    try {
      await wait(IDLE_MS + 500);
      await Promise.all([cpuOf(child.pid), cpuOf(spinner.pid)]);
      await wait(1000);
      const [busy, full] = await Promise.all([
        cpuOf(child.pid),
        cpuOf(spinner.pid),
      ]);
      assert(full > 5, `the reference spinner read ${full}%`);
      // The lifetime average would be about a quarter of it: 1.5 s of
      // spinning in the 5.5 s the process has lived.
      assert(
        busy > full * 0.6,
        `a spinning process read ${busy}% where one that only spins read ${full}% — the lifetime average, not the last second`,
      );
    } finally {
      child.kill("SIGKILL");
      spinner.kill("SIGKILL");
      await Promise.all([child.status, spinner.status]);
    }
  },
});
