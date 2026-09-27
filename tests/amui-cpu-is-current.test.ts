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
  ignore: Deno.build.os === "windows",
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
  ignore: Deno.build.os === "windows",
  async fn() {
    const child = new Deno.Command(Deno.execPath(), {
      args: [
        "eval",
        `setTimeout(() => { for (;;) {} }, ${IDLE_MS});`,
      ],
      stdout: "null",
      stderr: "null",
    }).spawn();
    try {
      await wait(IDLE_MS + 500);
      await cpuOf(child.pid);
      await wait(1000);
      const busy = await cpuOf(child.pid);
      assert(
        busy > 60,
        `a spinning process read ${busy}% — the lifetime average, not the last second`,
      );
    } finally {
      child.kill("SIGKILL");
      await child.status;
    }
  },
});
