/**
 * @module
 * How much JavaScript heap an aio app may use — one rule, every surface.
 *
 * V8 fixes its heap ceiling when an isolate is created and never revisits it.
 * Deno's default here is ~4 GB regardless of the machine, so an app on a 32 GB
 * box died of "out of memory" with 28 GB free — the failure this exists to
 * prevent. An app is not limited by aio: it is limited by a default nobody
 * chose.
 *
 * THE RULE: **25% of physical RAM, never below 4 GB.**
 *
 *  • 25% — an app may grow into the machine it is on, while three more things
 *    can still run. A native app has no ceiling at all; this is the closest
 *    safe equivalent, and it scales with the box instead of pretending every
 *    machine is the same.
 *  • never below 4 GB — the floor equals today's default, so this can only
 *    raise a ceiling, never lower one. On an 8 GB laptop 25% would be 2 GB;
 *    the floor wins, and nothing regresses.
 *  • the ceiling is not an allocation. V8 does not reserve it; it only stops
 *    growing there. What a high ceiling DOES change is garbage-collection
 *    pressure — V8 collects less eagerly when it believes it has room — which
 *    is why the rule is a fraction of the machine and not simply "lots".
 *
 * WHERE IT IS APPLIED, and why it has to be more than one place: a `deno run`
 * reads `--v8-flags` / `DENO_V8_FLAGS` at launch, so a launcher can compute the
 * right number for THIS machine. A COMPILED binary cannot — measured: it
 * ignores `DENO_V8_FLAGS` entirely, and only `deno compile --v8-flags=` reaches
 * it. So a shipped artifact carries a number chosen on the BUILD machine, and
 * the runtime monitor is what keeps it honest on a smaller one.
 *
 * WORKERS ARE COVERED. Measured on Deno 2.9: a Worker isolate inherits the
 * flag, in `deno run` and in a compiled binary alike (4192 MB default, 16480 MB
 * with the flag). The docs used to claim workers were stuck at ~1.7 GB and that
 * the env var did not propagate; both were false, and cost this project a
 * documented "limitation" that never existed.
 *
 * WHAT IT DOES NOT COVER: memory outside the JS heap. SQLite's page cache
 * (`PRAGMA cache_size`, 64 MB per connection by default) is native, and so are
 * blob buffers in flight. No V8 flag governs those, and the memory monitor
 * cannot see them either.
 */

/** Never go below this: it is V8's own default here, so the policy can only
 *  ever raise a ceiling. A regression would be worse than doing nothing. */
export const HEAP_FLOOR_MB = 4096;

/** The fraction of physical RAM one app may claim. */
export const HEAP_FRACTION = 0.25;

/** Physical RAM in bytes, or null when the platform will not say.
 *
 *  `Deno.systemMemoryInfo()` reports bytes; `/proc/meminfo` is the fallback for
 *  a build of Deno without it. Null means "unknown", and every caller treats
 *  unknown as "leave V8 alone" — guessing a ceiling from no information is how
 *  you turn a working app into a swapping one. */
export function physicalMemoryBytes(): number | null {
  try {
    const info = (Deno as unknown as {
      systemMemoryInfo?: () => { total: number };
    }).systemMemoryInfo?.();
    if (info && Number.isFinite(info.total) && info.total > 0) {
      return info.total;
    }
  } catch { /* permission or unsupported — fall through */ }
  try {
    const m = Deno.readTextFileSync("/proc/meminfo").match(
      /MemTotal:\s+(\d+) kB/,
    );
    if (m) return Number(m[1]) * 1024;
  } catch { /* not Linux, or unreadable */ }
  return null;
}

/** Parse a declared ceiling: `"25%"`, `"12GB"`, `"512MB"`, or a plain number of
 *  megabytes. Returns null for "not declared" and throws on nonsense, because a
 *  typo'd memory setting that silently means "default" is the kind of thing
 *  found only under load. */
export function parseMaxHeap(
  declared: string | number | undefined | null,
  totalBytes: number | null,
): number | null {
  if (declared === undefined || declared === null || declared === "") {
    return null;
  }
  if (typeof declared === "number") {
    if (!Number.isFinite(declared) || declared <= 0) {
      throw new Error(
        `[aio] memory.maxHeap must be a positive number of MB — got ${declared}`,
      );
    }
    return Math.floor(declared);
  }
  const s = declared.trim().toLowerCase();
  if (s === "default") return null;
  const pct = s.match(/^(\d+(?:\.\d+)?)\s*%$/);
  if (pct) {
    if (totalBytes === null) return null; // unknown machine — leave V8 alone
    return Math.floor((totalBytes * Number(pct[1]) / 100) / (1024 * 1024));
  }
  const abs = s.match(/^(\d+(?:\.\d+)?)\s*(gb|g|mb|m)$/);
  if (abs) {
    const n = Number(abs[1]);
    return Math.floor(abs[2]!.startsWith("g") ? n * 1024 : n);
  }
  throw new Error(
    `[aio] memory.maxHeap is ${
      JSON.stringify(declared)
    } — expected "25%", "12GB", "512MB", a number of MB, or "default".`,
  );
}

/** THE ceiling, in megabytes, for a machine with `totalBytes` of RAM.
 *
 *  `declared` is the app's `memory.maxHeap` (deno.json / aio.run) when it has
 *  one, and an explicit value is HONOURED — even above 25%.
 *
 *  That is deliberate, and it is the difference between the two failures this
 *  balances. The automatic 25% protects a machine from an app whose appetite
 *  nobody has thought about. But an app that legitimately needs 12 GB on a
 *  32 GB box is not misbehaving, and clamping it to 8 GB reproduces exactly the
 *  crash this module exists to prevent — with the framework's fingerprints on
 *  it this time. The author who writes `maxHeap: "12GB"` has thought about it;
 *  refusing them is not safety, it is the framework overruling the only person
 *  who knows the workload. It is loud instead: {@link overAdvisedShare} lets
 *  the caller say so at boot.
 *
 *  Returns null when the machine is unknown and nothing absolute was declared —
 *  the caller then passes no flag at all and V8 keeps its default. */
export function resolveMaxHeapMB(
  totalBytes: number | null,
  declared?: string | number | null,
): number | null {
  if (totalBytes === null) {
    // A machine we cannot measure: only an ABSOLUTE declaration is actionable.
    const abs = parseMaxHeap(declared, null);
    return abs === null ? null : Math.max(HEAP_FLOOR_MB, abs);
  }
  const capMB = Math.floor((totalBytes * HEAP_FRACTION) / (1024 * 1024));
  const declaredMB = parseMaxHeap(declared, totalBytes);
  // Declared: the author's number, floored. Automatic: the 25% share.
  return declaredMB === null
    ? Math.max(HEAP_FLOOR_MB, capMB)
    : Math.max(HEAP_FLOOR_MB, declaredMB);
}

/** The share of the machine a resolved ceiling represents, when it exceeds the
 *  automatic one — else null. A number to SAY, not to enforce: an app allowed
 *  60% of RAM is a decision someone made, and the next person to read a boot
 *  log should not have to reverse-engineer it from two config files. */
export function overAdvisedShare(
  mb: number | null,
  totalBytes: number | null,
): number | null {
  if (mb === null || totalBytes === null) return null;
  const share = (mb * 1024 * 1024) / totalBytes;
  return share > HEAP_FRACTION ? share : null;
}

/** The `--v8-flags=…` argument for a resolved ceiling, or `[]` when there is
 *  nothing to say. Shared by every launcher so the flag is spelled once. */
export function maxHeapFlagArgs(mb: number | null): string[] {
  return mb === null ? [] : [`--v8-flags=--max-old-space-size=${mb}`];
}

/** Human summary for a boot line or a build log. */
export function describeHeapPolicy(
  mb: number | null,
  totalBytes: number | null,
): string {
  if (mb === null) return "V8 default (machine memory unknown)";
  const gb = (n: number) => `${(n / 1024).toFixed(1)} GB`;
  const of = totalBytes === null
    ? ""
    : ` of ${gb(totalBytes / (1024 * 1024))} RAM`;
  return `${gb(mb)} max${of}`;
}

/** This isolate's heap ceiling in bytes, or null when `node:v8` is absent. */
export async function currentHeapLimitBytes(): Promise<number | null> {
  try {
    const v8 = await import("node:v8");
    const stats = v8.getHeapStatistics() as { heap_size_limit?: number };
    return typeof stats.heap_size_limit === "number"
      ? stats.heap_size_limit
      : null;
  } catch {
    return null; // not available — callers stay silent rather than guess
  }
}

/** Say so when this process is running below the policy.
 *
 *  Observe-only, and identical in dev and prod: V8's ceiling is fixed long
 *  before any of our code runs, so nothing here can change it. What it CAN do
 *  is make the gap visible before the app dies of "out of memory" on a machine
 *  with most of its RAM free — the failure that started this. Every aio
 *  launcher (`am start`, `run.sh`, a compiled build) sizes it correctly; a bare
 *  `deno run src/app.ts` is the case this catches.
 *
 *  Silent when the ceiling already meets policy, when the machine cannot be
 *  measured, or when `node:v8` is unavailable — a warning nobody can act on is
 *  noise, and noise is how real warnings get ignored. */
export async function reportHeapCeiling(
  log: { warn: (msg: string) => void } = console,
  deps: {
    limitBytes?: () => Promise<number | null>;
    totalBytes?: () => number | null;
  } = {},
): Promise<void> {
  const limit = await (deps.limitBytes ?? currentHeapLimitBytes)();
  const total = (deps.totalBytes ?? physicalMemoryBytes)();
  const want = resolveMaxHeapMB(total);
  if (limit === null || want === null) return;
  const haveMB = Math.floor(limit / (1024 * 1024));
  // Granted more than the automatic share: not an error — someone asked — but
  // it is the fact that explains a frozen desktop three months from now.
  const over = overAdvisedShare(haveMB, total);
  if (over !== null) {
    log.warn(
      `heap ceiling is ${(haveMB / 1024).toFixed(1)} GB — ${
        (over * 100).toFixed(0)
      }% of this machine's RAM, above the ${
        (HEAP_FRACTION * 100).toFixed(0)
      }% an app gets automatically. Deliberate (memory.maxHeap), and worth ` +
        `knowing: this app can now squeeze the rest of the machine. A hard total ` +
        `belongs to the OS — systemd MemoryMax=, or a container limit.`,
    );
    return;
  }
  // A 10% band: V8 reports slightly more than it was asked for (4096 → 4192),
  // and reporting that as a shortfall would be a warning about rounding.
  if (haveMB >= want * 0.9) return;
  log.warn(
    `heap ceiling is ${
      (haveMB / 1024).toFixed(1)
    } GB but this machine allows ` +
      `${
        (want / 1024).toFixed(1)
      } GB (25% of RAM). V8 fixes this at startup, so ` +
      `it cannot be raised from here — an app that needs more will fail with ` +
      `"out of memory" while the machine still has room. Launch with ` +
      `\`am start\`, or add --v8-flags=--max-old-space-size=${want} to the ` +
      `deno run. Compiled builds bake it in.`,
  );
}
