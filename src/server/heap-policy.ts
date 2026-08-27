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
 * reads `--v8-flags` / `DENO_V8_FLAGS` at launch, so a launcher (`am start`,
 * `run.sh`) computes the right number for THIS machine and the rule holds. A
 * COMPILED binary cannot — measured: it ignores `DENO_V8_FLAGS` entirely, and
 * only `deno compile --v8-flags=` reaches it. The ceiling in an artifact is
 * therefore fixed at BUILD time, on a machine that is not the user's.
 *
 * WHICH IS WHY A BUILD NEVER BAKES THE BUILD MACHINE'S SHARE. It used to: an
 * undeclared app got 25% of whatever built it. A binary cross-compiled on a
 * 187 GB host booted in an 8 GB Windows VM and reported `heap 46.7 GB max of
 * 8.0 GB RAM` — 25% of a machine the user has never seen, six times more heap
 * than the box has RAM, so V8 would have grown past physical memory without
 * ever deciding to collect and let the OS kill the process instead. A number
 * that is right only on the builder's desk is not a policy, it is a leak.
 * {@link compiledMaxHeapMB} is the build-side decider: an ABSOLUTE
 * `memory.maxHeap` travels (someone chose it, and it means the same thing
 * everywhere), a PERCENTAGE says loudly that it was resolved against the build
 * host, and an app that declared nothing ships with V8's own default — the
 * floor, identical on every machine. More than the floor on a big machine is
 * one config line away, and {@link reportHeapCeiling} names it at boot.
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
  // The FLOOR is not a decision anyone made. `resolveMaxHeapMB` never returns
  // less than HEAP_FLOOR_MB, and on any machine under ~16 GB that floor is
  // itself above the 25% share — so this branch told an 8 GB laptop it had
  // asked for more than the automatic share when nobody had asked for
  // anything, and no app setting could silence it (a field report: "nothing
  // can launch this app without a heap warning").
  // …and the same 10% band the share comparison below has, for the same
  // reason: V8 hands back a little MORE than the floor it was given (4096 →
  // 4192), and 4192 > 4096 was enough to call V8's own default "a share
  // someone asked for". On every machine of 8 GB or less that fired on every
  // boot of a bare `deno run` — the exact warning this branch was written to
  // stop, defeated by 96 MB of rounding.
  if (mb <= HEAP_FLOOR_MB * 1.1) return null;
  const share = (mb * 1024 * 1024) / totalBytes;
  // The same 10% band the under-policy branch has, for the same reason: V8
  // reports slightly more than it was asked for (46.6 GB granted → 46.7 GB
  // reported), and a warning about rounding is noise. It was asymmetric —
  // `am start` sized the ceiling to exactly the advised share and then warned
  // that the result exceeded it.
  return share > HEAP_FRACTION * 1.1 ? share : null;
}

/** The `--v8-flags=…` argument for a resolved ceiling, or `[]` when there is
 *  nothing to say. Shared by every launcher so the flag is spelled once. */
export function maxHeapFlagArgs(mb: number | null): string[] {
  return mb === null ? [] : [`--v8-flags=--max-old-space-size=${mb}`];
}

/** The heap ceiling to BAKE into a compiled artifact, and what to say about it.
 *
 *  `deno compile --v8-flags=` is the only channel into a binary's V8 (measured:
 *  a compiled binary ignores `DENO_V8_FLAGS`), so whatever this returns is the
 *  ceiling on every machine the artifact ever runs on. That rules out the
 *  automatic 25% share: it is a measurement of the BUILD host, and a build host
 *  is not evidence about the user's laptop. Shipping it produced a binary that
 *  told an 8 GB VM it had 46.7 GB of heap.
 *
 *  So:
 *   • nothing declared → `null`, no flag, V8's own default (~4 GB — the policy
 *     FLOOR). Identical on every machine, and never lower than today.
 *   • an ABSOLUTE `memory.maxHeap` ("12GB", 8192) → baked as-is (floored). The
 *     author chose a size; a size means the same thing on every machine.
 *   • a PERCENTAGE ("25%") → resolved against the build host, with a `note`
 *     saying exactly that. It cannot be re-resolved later, and a caller that
 *     prints the note turns a silent leak into a build-log line.
 *
 *  Pure: the build host's RAM is an argument, never a read. */
export function compiledMaxHeapMB(
  declared: string | number | null | undefined,
  buildHostBytes: number | null,
): { mb: number | null; note: string | null } {
  if (declared === undefined || declared === null || declared === "") {
    return { mb: null, note: null };
  }
  const gb = (bytes: number) => `${(bytes / (1024 ** 3)).toFixed(1)} GB`;
  if (typeof declared === "string") {
    const s = declared.trim().toLowerCase();
    if (s === "default") return { mb: null, note: null };
    if (/^\d+(?:\.\d+)?\s*%$/.test(s)) {
      if (buildHostBytes === null) {
        return {
          mb: null,
          note: `memory.maxHeap is "${declared}" and this build machine will ` +
            `not report its RAM, so there is no number to bake — the binary ` +
            `ships with V8's default (~${
              (HEAP_FLOOR_MB / 1024).toFixed(0)
            } GB). Declare an absolute size ("8GB") to ship a ceiling.`,
        };
      }
      const mb = Math.max(
        HEAP_FLOOR_MB,
        parseMaxHeap(s, buildHostBytes) ?? HEAP_FLOOR_MB,
      );
      return {
        mb,
        note: `memory.maxHeap is "${declared}" — a share of THIS BUILD ` +
          `MACHINE (${gb(buildHostBytes)} → ${
            (mb / 1024).toFixed(1)
          } GB), baked in. V8 fixes its ceiling at startup and a compiled ` +
          `binary ignores DENO_V8_FLAGS, so the binary carries that number ` +
          `onto every machine it runs on, however small. Declare an absolute ` +
          `size ("8GB") when the target is not this machine.`,
      };
    }
  }
  const mb = parseMaxHeap(declared, buildHostBytes);
  return { mb: mb === null ? null : Math.max(HEAP_FLOOR_MB, mb), note: null };
}

/** Human summary for a boot line or a build log.
 *
 *  `mb` is the ceiling this process ACTUALLY has, `totalBytes` the RAM of the
 *  machine reading the line — and the line has to be true on that machine. The
 *  old one read `${gb} max of ${gb} RAM`, which states a ceiling and a machine
 *  and implies the second granted the first. In a compiled binary it does not:
 *  the ceiling was fixed by whoever ran the build. A 187 GB build host shipped
 *  a binary that greeted an 8 GB Windows VM with `heap 46.7 GB max of 8.0 GB
 *  RAM` — two true numbers arranged into a false sentence, and the one thing a
 *  reader needed (this machine cannot reach that) was the part left out.
 *
 *  `fixedAtBuild` (pass `isCompiled()`) marks the ceiling as an artifact of the
 *  build rather than of this machine — a compiled binary cannot re-resolve it,
 *  and the reader should not go looking for the local setting that "caused" it.
 */
export function describeHeapPolicy(
  mb: number | null,
  totalBytes: number | null,
  fixedAtBuild = false,
): string {
  if (mb === null) return "V8 default (machine memory unknown)";
  const gb = (n: number) => `${(n / 1024).toFixed(1)} GB`;
  const where = fixedAtBuild ? " (fixed when this binary was built)" : "";
  if (totalBytes === null) return `${gb(mb)} max${where}`;
  const totalMB = totalBytes / (1024 * 1024);
  // Above the machine's own RAM the ceiling is not a limit, it is a fiction:
  // V8 will not collect before the OS runs out, so say what the reader can act
  // on instead of a share that does not exist.
  if (mb > totalMB) {
    return `${gb(mb)} max — MORE than this machine's ${
      gb(totalMB)
    } of RAM, so unreachable here${where}`;
  }
  return `${gb(mb)} max of ${gb(totalMB)} RAM${where}`;
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
    /** Where to remember that this warning was already given. Omit for the old
     *  every-boot behaviour (tests, and any caller with nowhere to write). */
    stampPath?: string;
    /** `--verbose` — say it every time, regardless of the stamp. */
    always?: boolean;
  } = {},
): Promise<void> {
  const limit = await (deps.limitBytes ?? currentHeapLimitBytes)();
  const total = (deps.totalBytes ?? physicalMemoryBytes)();
  const want = resolveMaxHeapMB(total);
  if (limit === null || want === null) return;
  const haveMB = Math.floor(limit / (1024 * 1024));
  const totalMB = total === null ? null : Math.floor(total / (1024 * 1024));
  // A ceiling ABOVE the machine's own RAM is its own failure, and worse than
  // the over-share below it: V8 decides how eagerly to collect from the ceiling
  // it was given, so it will grow past physical memory believing it has room
  // and the OS kills the process — an "out of memory" with no warning from the
  // runtime that caused it. It reached a user exactly this way: a binary
  // cross-compiled on a 187 GB host, booted in an 8 GB Windows VM, reporting
  // 46.7 GB of heap. The floor is excluded (a 4 GB default on a 4 GB machine is
  // nobody's decision, and warning about it is the "nothing can launch this app
  // without a heap warning" field report all over again).
  if (
    totalMB !== null && haveMB > totalMB && haveMB > HEAP_FLOOR_MB * 1.1
  ) {
    log.warn(
      `heap ceiling is ${(haveMB / 1024).toFixed(1)} GB — MORE than this ` +
        `machine's ${
          (totalMB / 1024).toFixed(1)
        } GB of RAM. V8 fixes the ceiling when the isolate starts (a compiled ` +
        `binary bakes it at BUILD time, on a machine that may be far larger), ` +
        `so it cannot be lowered from here — and until it is, V8 grows the ` +
        `heap past this machine's memory before it collects, and the OS kills ` +
        `the process. Fix: set "memory": { "maxHeap": "${
          Math.max(HEAP_FLOOR_MB, resolveMaxHeapMB(total) ?? HEAP_FLOOR_MB) /
          1024
        }GB" } in the app's deno.json and rebuild, or launch with \`am start\`, ` +
        `which sizes the ceiling on the machine it starts.`,
    );
    return;
  }
  // Granted more than the automatic share: not an error — someone asked — but
  // it is the fact that explains a frozen desktop three months from now.
  const over = overAdvisedShare(haveMB, total);
  if (over !== null) {
    log.warn(
      `heap ceiling is ${(haveMB / 1024).toFixed(1)} GB — ${
        (over * 100).toFixed(0)
      }% of this machine's RAM, above the ${
        (HEAP_FRACTION * 100).toFixed(0)
      }% an app gets automatically. Chosen (memory.maxHeap, or baked when ` +
        `this binary was built), and worth ` +
        `knowing: this app can now squeeze the rest of the machine. A hard total ` +
        `belongs to the OS — systemd MemoryMax=, or a container limit.`,
    );
    return;
  }
  // A 10% band: V8 reports slightly more than it was asked for (4096 → 4192),
  // and reporting that as a shortfall would be a warning about rounding.
  if (haveMB >= want * 0.9) return;
  // ONCE per (machine, ceiling, policy) — not once per boot.
  //
  // The warning is correct and it is five lines the reader cannot act on from
  // application code: V8 fixed the ceiling before any of this ran. Printed at
  // every start of an app using a few MB, it becomes the paragraph you scroll
  // past — and one field report watched it sit directly above the ONE warning
  // they had deliberately emitted and needed to read. A framework whose rule
  // is "fail loud, never silent" has the most to lose from noise, because
  // noise is how loud stops working.
  //
  // The stamp records the numbers, not just "shown": change machine, change
  // launcher, change the policy, and it speaks again — which is exactly when
  // it is news. `--verbose` always says it.
  const fingerprint = `${haveMB}/${want}`;
  if (!deps.always && deps.stampPath) {
    try {
      if ((await Deno.readTextFile(deps.stampPath)).trim() === fingerprint) {
        return;
      }
    } catch { /* never warned here before */ }
    try {
      await Deno.writeTextFile(deps.stampPath, fingerprint);
    } catch {
      /* unwritable data dir — warn every boot rather than not at all */
    }
  }
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
      `deno run. A COMPILED binary cannot be raised at all from here — it ` +
      `carries what the build baked, so set "memory": { "maxHeap": "${
        (want / 1024).toFixed(0)
      }GB" } in deno.json and rebuild.` +
      (deps.stampPath && !deps.always
        ? ` (said once per machine — --verbose repeats it)`
        : ``),
  );
}
