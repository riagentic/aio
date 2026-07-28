/**
 * @module
 * `am cost` — what does aio move on your behalf, and where does it come from.
 *
 * aio tells every app its state might be too big — `aiol` flags a large typed
 * array, counts state keys across cells, and the pressure monitor recommends
 * `ui:` filters — and ships all three remedies. Until now it gave nobody a way to
 * find out whether they had the condition, so the hints got skipped every round.
 * This closes that loop: one command, one question, real numbers.
 *
 * It reports and does not advise. `aiol` owns the opinions; this makes them
 * checkable.
 */

import type { GlobalFlags } from "./am-types.ts";
import { out, outError } from "./am-output.ts";
import { amCtx } from "./am-utils.ts";
import { trojanGet } from "./am-http.ts";

type KeyCost = {
  key: string;
  bytes: number;
  bytesPerSec: number;
  pushes: number;
};

type CellCost = {
  cell: string;
  pushesPerSec: number;
  bytesPerSec: number;
  meanBytes: number;
  p95ReduceMs: number;
  meanReduceMs: number;
  fullResends: number;
  keys: KeyCost[];
};

type CostReport = {
  windowSec: number;
  truncated: boolean;
  cells: CellCost[];
  wire: {
    bytesPerSec: number;
    bytesPerSecPerClient: number;
    framesPerSec: number;
    fullResendShare: number;
    byKind: { patch: number; full: number; other: number };
    bytesByKind?: { patch: number; full: number; other: number };
    totalBytes: number;
    frames: number;
  };
  clients: number;
  idleCells: string[];
  stateBytes: Record<string, number>;
};

/** Bytes, at a glance: 412 B · 7.9 KB · 1.2 MB. */
export function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "—";
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const fmtRate = (n: number): string => n <= 0 ? "—" : `${fmtBytes(n)}/s`;
const fmtMs = (n: number): string => n <= 0 ? "—" : `${n.toFixed(1)} ms`;

/** `60s`, `5m`, `90` (seconds) → seconds. Null when unparseable. */
export function parseWindow(v: string): number | null {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(v.trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  switch (m[2]) {
    case "ms":
      return n / 1000;
    case "m":
      return n * 60;
    case "h":
      return n * 3600;
    default:
      return n;
  }
}

const pad = (s: string, w: number) => s.padEnd(w);
const padL = (s: string, w: number) => s.padStart(w);

/** The table. Pure so it can be tested without a running app. */
export function renderCost(
  r: CostReport,
  opts: { keys?: boolean } = {},
): string {
  const lines: string[] = [];
  const rows = r.cells.map((c) => {
    const idle = r.idleCells.includes(c.cell);
    const top = opts.keys ? c.keys : c.keys.slice(0, 3);
    const keyText = idle && c.keys.length === 0
      ? "(idle)"
      : top.map((k) => k.bytes > 0 ? `${k.key} ${fmtBytes(k.bytes)}` : k.key)
        .join(" · ") || "—";
    return {
      cell: c.cell,
      pushes: c.pushesPerSec > 0 ? c.pushesPerSec.toFixed(1) : "0.0",
      bytes: fmtRate(c.bytesPerSec),
      mean: fmtBytes(c.meanBytes),
      p95: fmtMs(c.p95ReduceMs),
      state: fmtBytes(r.stateBytes[c.cell] ?? 0),
      keys: keyText,
      full: c.fullResends,
    };
  });

  const w = {
    cell: Math.max(4, ...rows.map((x) => x.cell.length)),
    pushes: Math.max(8, ...rows.map((x) => x.pushes.length)),
    bytes: Math.max(9, ...rows.map((x) => x.bytes.length)),
    mean: Math.max(7, ...rows.map((x) => x.mean.length)),
    p95: Math.max(10, ...rows.map((x) => x.p95.length)),
    state: Math.max(5, ...rows.map((x) => x.state.length)),
  };

  lines.push(
    `${pad("cell", w.cell)}  ${padL("pushes/s", w.pushes)}  ${
      padL("bytes/s", w.bytes)
    }  ${padL("mean", w.mean)}  ${padL("p95 reduce", w.p95)}  ${
      padL("state", w.state)
    }  top keys by bytes`,
  );
  for (const x of rows) {
    lines.push(
      `${pad(x.cell, w.cell)}  ${padL(x.pushes, w.pushes)}  ${
        padL(x.bytes, w.bytes)
      }  ${padL(x.mean, w.mean)}  ${padL(x.p95, w.p95)}  ${
        padL(x.state, w.state)
      }  ${x.keys}`,
    );
  }

  const width = Math.max(
    72,
    ...lines.map((l) => Math.min(l.length, 110)),
  );
  lines.push("─".repeat(width));
  lines.push(
    `${pad("per client", w.cell)}  ${padL("", w.pushes)}  ${
      padL(fmtRate(r.wire.bytesPerSecPerClient), w.bytes)
    }`,
  );
  lines.push(
    `${pad("clients connected", w.cell)}  ${
      padL(String(r.clients), w.pushes)
    }  ${padL(fmtRate(r.wire.bytesPerSec), w.bytes)}   (all surfaces)`,
  );
  lines.push(
    `${pad("frames", w.cell)}  ${
      padL(r.wire.framesPerSec.toFixed(1), w.pushes)
    }/s  ${padL(fmtBytes(r.wire.totalBytes), w.bytes)} total`,
  );
  // Reconcile the footer with the rows. The cells above account for state
  // pushes only; anything else on the socket — acks, diagnostics, time-travel
  // — belongs to no cell, and if it is large the table alone is misleading.
  const bk = r.wire.bytesByKind;
  if (bk && bk.other > 0) {
    const attributed = r.cells.reduce((n, c) => n + c.bytesPerSec, 0);
    const otherRate = bk.other / r.windowSec;
    lines.push(
      `${pad("unattributed", w.cell)}  ${padL("", w.pushes)}  ${
        padL(fmtRate(otherRate), w.bytes)
      }   acks/diagnostics/time-travel — belongs to no cell`,
    );
    if (otherRate > attributed) {
      lines.push(
        `${pad("", w.cell)}  ${padL("", w.pushes)}  ${padL("", w.bytes)}` +
          `   ← more than every cell combined (${fmtRate(attributed)})`,
      );
    }
  }
  const k = r.wire.byKind ?? { patch: 0, full: 0, other: 0 };
  const pushFrames = k.patch + k.full;
  if (pushFrames > 0) {
    const pct = Math.round(r.wire.fullResendShare * 100);
    lines.push(
      `${pad("full resends", w.cell)}  ${padL(`${pct}%`, w.pushes)}  ` +
        `${k.full} of ${pushFrames} state pushes` +
        (k.other > 0 ? ` (+${k.other} acks/diagnostics)` : "") +
        (pct > 50
          ? `\n${pad("", w.cell)}  ${
            padL("", w.pushes)
          }  ← the whole state is ` +
            `going out, not a diff: a "full"-strategy cell, or patches over ` +
            `fullStateThreshold (default 50% of full)`
          : ""),
    );
  } else if (k.other > 0) {
    lines.push(
      `${pad("frames", w.cell)}  ${
        padL(String(k.other), w.pushes)
      }  acks/diagnostics only — no state was pushed`,
    );
  }
  lines.push("");
  lines.push(
    `window  last ${r.windowSec}s${
      r.truncated ? "  (ring wrapped — older samples dropped)" : ""
    }` + (r.wire.frames === 0
      ? "   · nothing was pushed: no clients, or nothing changed"
      : ""),
  );
  if (!opts.keys && r.cells.some((c) => c.keys.length > 3)) {
    lines.push(`        --keys for every key · --cell=<name> · --window=5m`);
  }
  return lines.join("\n");
}

export async function cmdCost(
  args: string[],
  flags: GlobalFlags,
): Promise<void> {
  const { mode, appId, port } = amCtx(flags);
  const windowArg = args.find((a) => a.startsWith("--window="))?.slice(9);
  const cell = args.find((a) => a.startsWith("--cell="))?.slice(7) ??
    args.find((a) => !a.startsWith("--"));
  const keys = args.includes("--keys");

  let windowSec = 60;
  if (windowArg !== undefined) {
    const parsed = parseWindow(windowArg);
    if (parsed === null) {
      outError(
        `bad --window="${windowArg}" — use 60s, 5m, 1h, or a number of seconds`,
        mode,
      );
      Deno.exit(1);
    }
    windowSec = parsed;
  }

  const q = `cost?window=${windowSec}${
    cell ? `&cell=${encodeURIComponent(cell)}` : ""
  }`;
  const result = await trojanGet(port, q, appId, 10_000);
  if (!result.ok) {
    outError(result.error, mode);
    Deno.exit(1);
  }
  const report = result.data as CostReport;
  if (cell && report.cells.length === 0) {
    outError(
      `no cell "${cell}" — cells: ${
        Object.keys(report.stateBytes ?? {}).join(", ") || "(none)"
      }`,
      mode,
    );
    Deno.exit(1);
  }
  out(mode === "pretty" ? renderCost(report, { keys }) : report, mode);
}
