/**
 * @module
 * Freeze guard — the SYSTEM-stability rule for aio-owned heavy steps.
 *
 * A Linux desktop freezes on **memory pressure**, not CPU. When MemAvailable
 * runs out, the kernel thrashes swap and every window stalls — the machine is
 * unusable long before the OOM killer fires. So the rule is not "the app
 * survives under load"; it is "the whole box stays responsive."
 *
 * Two system-level guarantees:
 *
 *  1. **Never every core.** Enforced in `scripts/test-shards.ts` (`cpuFence`):
 *     however many cores a run asks for, at least one stays free for the OS,
 *     the desktop and the freeze watcher. "Most, never all."
 *  2. **Never add a memory-heavy step to a machine that is already tight.**
 *     This module. The one heavy burst aio owns is packing an ~800 MB AppDir
 *     into the Windows zstd payload; it asks for headroom first and declines
 *     while RAM or swap is nearly spent. Declining is free —
 *     `buildWindowsSfxExe` already falls back to the zip payload — so a build
 *     still finishes, and the machine is never pushed over the edge.
 *
 * "Maximum performance with total stability": on a healthy machine the guard
 * is a single `/proc` read and changes nothing; near the edge it steps aside
 * rather than join the pile-up.
 */

/** A machine's memory picture, in bytes. */
export type Memory = {
  totalBytes: number;
  availableBytes: number;
  swapUsedBytes: number;
  swapTotalBytes: number;
};

/** Below this share of RAM available, a heavy step declines. This is roughly
 *  where a desktop has already begun to feel the pressure. */
const MEM_AVAILABLE_FLOOR_PCT = 5;
/** Swap this full means the machine is already thrashing; do not add to it. */
const SWAP_FULL_PCT = 80;

/** The verdict for one memory snapshot. Pure, so it is unit-testable without
 *  a real machine and without timing. */
export function headroom(
  m: Memory,
): { ok: true } | { ok: false; reason: string } {
  const availPct = (100 * m.availableBytes) / Math.max(1, m.totalBytes);
  if (availPct < MEM_AVAILABLE_FLOOR_PCT) {
    return { ok: false, reason: `only ${availPct.toFixed(1)}% RAM available` };
  }
  if (m.swapTotalBytes > 0) {
    const swapPct = (100 * m.swapUsedBytes) / m.swapTotalBytes;
    if (swapPct > SWAP_FULL_PCT) {
      return { ok: false, reason: `swap ${swapPct.toFixed(0)}% full` };
    }
  }
  return { ok: true };
}

/** Linux `/proc/meminfo`, or `null` where there is no such file (macOS and
 *  Windows build hosts). A guard that cannot read the machine never blocks a
 *  build — it simply has nothing to say. */
export async function readMemory(): Promise<Memory | null> {
  try {
    const text = await Deno.readTextFile("/proc/meminfo");
    const kb = (key: string): number => {
      const found = new RegExp(`^${key}:\\s+(\\d+) kB`, "m").exec(text);
      return found ? Number(found[1]) * 1024 : 0;
    };
    return {
      totalBytes: kb("MemTotal"),
      availableBytes: kb("MemAvailable"),
      swapUsedBytes: kb("SwapTotal") - kb("SwapFree"),
      swapTotalBytes: kb("SwapTotal"),
    };
  } catch {
    return null; // aio-ok: no /proc/meminfo — the guard degrades to a no-op
  }
}

/** Throws when the machine is too tight to start `step`. The message names
 *  what was refused and why, so a log is actionable. */
export async function ensureHeadroom(step: string): Promise<void> {
  const m = await readMemory();
  if (!m || m.totalBytes === 0) return;
  const verdict = headroom(m);
  if (!verdict.ok) {
    throw new Error(
      `${step}: declined — ${verdict.reason}. aio will not start a memory-heavy ` +
        `step on a machine that is already out of headroom; free memory (or ` +
        `wait for the swap to drain) and rebuild.`,
    );
  }
}
