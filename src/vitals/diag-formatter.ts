import type { DiagEvent } from "./types.ts";

/** Count non-undefined values in detail (excluding hint) */
function dataPointCount(detail: DiagEvent["detail"]): number {
  let count = 0;
  const { hint: _, ...rest } = detail;
  for (const v of Object.values(rest)) {
    if (v !== undefined) count++;
  }
  return count;
}

/**
 * Pure formatter: DiagEvent → console-ready lines.
 * Structured block when severity is likely/possible AND 2+ data points.
 * One-liner otherwise.
 */
export function formatDiagEvent(event: DiagEvent): string[] {
  const { kind, summary, detail } = event;
  const isBlock =
    (event.severity === "likely" || event.severity === "possible") &&
    dataPointCount(detail) >= 2;

  const header = `[aio:vitals] ${summary}`;

  if (!isBlock) return [header];

  const lines: string[] = [header];

  if (detail.trigger !== undefined) {
    const extra = detail.reduceMs !== undefined
      ? ` reduce took ${detail.reduceMs}ms${
        detail.p95Ms !== undefined ? ` (p95: ${detail.p95Ms}ms)` : ""
      }`
      : "";
    lines.push(`  trigger:    ${detail.trigger}${extra}`);
  }

  if (detail.queueDepth !== undefined) {
    const dr = detail.drainRate !== undefined
      ? `, drain rate ${detail.drainRate}/s`
      : "";
    lines.push(`  queue:      ${detail.queueDepth} actions pending${dr}`);
  }

  if (detail.rtt !== undefined) {
    const status = detail.rtt > 500
      ? "degraded"
      : detail.rtt > 100
      ? "warning"
      : "healthy";
    lines.push(`  transport:  ${status} (RTT ${detail.rtt}ms)`);
  }

  if (detail.skipCount !== undefined) {
    lines.push(`  skipped:    ${detail.skipCount} broadcasts`);
  }

  if (
    detail.frozenFor !== undefined && kind !== "freeze" && kind !== "pressure"
  ) {
    lines.push(`  frozen for: ${(detail.frozenFor / 1000).toFixed(1)}s`);
  }

  if (detail.payloadBytes !== undefined) {
    const kb = (detail.payloadBytes / 1024).toFixed(1);
    lines.push(`  payload:    ${kb}KB`);
  }

  if (detail.bytesPerSec !== undefined) {
    const mbps = (detail.bytesPerSec / 1_048_576).toFixed(2);
    lines.push(`  bandwidth:  ${mbps} MB/s (avg)`);
  }

  if (detail.hint !== undefined) {
    lines.push(`  hint:       ${detail.hint}`);
  }

  return lines;
}
