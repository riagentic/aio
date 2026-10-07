// What `/proc/<pid>` and `ps` answer on Unix, asked of Windows: a process's
// cpu time, working set and executable. kernel32 directly (as aio's own named
// pipes do — src/server/win-pipe.ts) rather than a PowerShell `Get-Process`:
// the sample is polled once a second, and a PowerShell start costs most of a
// cpu-second each time. Nothing to install; a few syscalls per sample.
const K32 = {
  OpenProcess: { parameters: ["u32", "i32", "u32"], result: "pointer" },
  CloseHandle: { parameters: ["pointer"], result: "i32" },
  GetProcessTimes: {
    parameters: ["pointer", "buffer", "buffer", "buffer", "buffer"],
    result: "i32",
  },
  K32GetProcessMemoryInfo: {
    parameters: ["pointer", "buffer", "u32"],
    result: "i32",
  },
  QueryFullProcessImageNameW: {
    parameters: ["pointer", "u32", "buffer", "buffer"],
    result: "i32",
  },
} as const;

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const PMC_SIZE = 72; // sizeof(PROCESS_MEMORY_COUNTERS) on 64-bit Windows
/** 1601-01-01 → 1970-01-01, in ms: a FILETIME's epoch is not Unix's. */
const FILETIME_EPOCH_MS = 11_644_473_600_000;

/** A FILETIME (u64 LE, 100 ns units) in seconds. */
export const filetimeSeconds = (ft: Uint8Array): number =>
  Number(new DataView(ft.buffer, ft.byteOffset, 8).getBigUint64(0, true)) / 1e7;

/** One sample out of what kernel32 filled in — pure, so it is checked on every
 *  OS. `cpuPct` is the LIFETIME average (cpu time / time since creation): what
 *  `ps -o %cpu` reports, and what a pid's first sample shows. */
export function decodeWinSample(
  t: { creation: Uint8Array; kernel: Uint8Array; user: Uint8Array },
  /** PROCESS_MEMORY_COUNTERS — `WorkingSetSize` is the size_t at offset 16. */
  pmc: Uint8Array,
  nowMs: number,
): { cpuPct: number; rssKb: number; cpuSec: number } {
  const cpuSec = filetimeSeconds(t.kernel) + filetimeSeconds(t.user);
  const aliveSec = (nowMs + FILETIME_EPOCH_MS) / 1000 -
    filetimeSeconds(t.creation);
  return {
    cpuSec,
    cpuPct: aliveSec > 0 ? Math.round(cpuSec / aliveSec * 1000) / 10 : 0,
    rssKb: Number(
      new DataView(pmc.buffer, pmc.byteOffset, PMC_SIZE).getBigUint64(16, true),
    ) / 1024,
  };
}

/** Run `fn` on a query handle of `pid`; null when the pid names no process
 *  this user may query. The library and the handle are closed before return. */
function withProcess<T>(
  pid: number,
  fn: (
    k: Deno.DynamicLibrary<typeof K32>["symbols"],
    h: Deno.PointerValue,
  ) => T | null,
): T | null {
  const lib = Deno.dlopen("kernel32.dll", K32);
  try {
    const h = lib.symbols.OpenProcess(
      PROCESS_QUERY_LIMITED_INFORMATION,
      0,
      pid,
    );
    if (h === null) return null;
    try {
      return fn(lib.symbols, h);
    } finally {
      lib.symbols.CloseHandle(h);
    }
  } finally {
    lib.close();
  }
}

/** cpu and memory of `pid`, or null when it cannot be read. */
export function winProcSample(
  pid: number,
): { cpuPct: number; rssKb: number; cpuSec: number } | null {
  return withProcess(pid, (k, h) => {
    const [creation, exit, kernel, user] = [0, 1, 2, 3].map(() =>
      new Uint8Array(8)
    );
    const pmc = new Uint8Array(PMC_SIZE);
    new DataView(pmc.buffer).setUint32(0, PMC_SIZE, true); // cb
    if (
      !k.GetProcessTimes(h, creation!, exit!, kernel!, user!) ||
      !k.K32GetProcessMemoryInfo(h, pmc, PMC_SIZE)
    ) return null;
    return decodeWinSample(
      { creation: creation!, kernel: kernel!, user: user! },
      pmc,
      Date.now(),
    );
  });
}

/** The executable `pid` runs (`/proc/<pid>/exe`), or null. */
export function winProcExe(pid: number): string | null {
  return withProcess(pid, (k, h) => {
    const buf = new Uint16Array(32768); // the longest path Windows has
    const len = new Uint32Array([buf.length]);
    if (!k.QueryFullProcessImageNameW(h, 0, buf, len)) return null;
    return String.fromCharCode(...buf.subarray(0, len[0]));
  });
}
