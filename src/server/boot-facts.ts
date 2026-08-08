// boot-facts.ts — what an app says about itself at startup.
//
// The question this answers is "what exactly am I running?", asked by someone
// looking at a terminal months after the thing was built. Every line here is
// READ from the running process rather than assumed from configuration:
// configuration gets copied between machines, and a report that repeats what
// was intended rather than what is true is worse than no report at all.
//
// Nothing here has side effects, so the whole report is testable as data.
import type { UpdateTarget } from "../build/ship.ts";
import { detectTarget } from "./updates-apply.ts";

/** Facts about the artifact and the machine, derived from the process. */
export type BuildFacts = {
  /** `source` = running through `deno`; `compiled` = a self-contained artifact. */
  build: "source" | "compiled";
  /** How this install would be updated — the same vocabulary `aio ship` uses. */
  target: UpdateTarget;
  /** The file on disk that IS this app (inside an AppImage, the .AppImage). */
  artifact: string;
  /** `linux/x86_64` */
  platform: string;
  /** `deno 2.9.1` */
  runtime: string;
};

export function buildFacts(): BuildFacts {
  const target = detectTarget();
  const appImage = Deno.env.get("APPIMAGE");
  return {
    build: target === "source" ? "source" : "compiled",
    target,
    artifact: appImage ?? Deno.execPath(),
    platform: `${Deno.build.os}/${Deno.build.arch}`,
    runtime: `deno ${Deno.version.deno}`,
  };
}

/** The optional extras the boot sequence knows and this module cannot derive. */
export type BootExtras = {
  /** Where everything this app owns lives — the one directory to back up. */
  dataDir?: string;
  /** Wire protocol version this build speaks. */
  protocol?: number;
  /** Cell ids, in registration order. */
  cells?: string[];
  /** Problem-report configuration, once resolved. */
  feedback?: {
    auto: boolean;
    keep: number;
    /** Where reports go beyond disk, when anywhere. */
    destination?: string;
  };
  /** Update configuration, once resolved. */
  updates?: {
    source: string;
    kind: "manifest" | "git";
    channel: string;
    intervalMs: number;
    auto: boolean;
  };
};

/** Label → value pairs for the boot report, in print order.
 *
 *  Returned as data rather than printed so the report can be asserted on. A
 *  value is omitted only when it does not exist — never when it is merely
 *  inconvenient, because "absent" and "unknown" read identically in a log and
 *  the whole point is to remove guessing. */
export function bootLines(
  facts: BuildFacts,
  extra: BootExtras = {},
): [string, string][] {
  const lines: [string, string][] = [
    // "source (source)" says one thing twice; the target only adds information
    // once there is an artifact whose kind could differ.
    [
      "build",
      facts.build === "source" ? "source" : `compiled (${facts.target})`,
    ],
    ["artifact", facts.artifact],
    ["platform", `${facts.platform} · ${facts.runtime}`],
  ];
  if (extra.protocol !== undefined) {
    lines.push(["protocol", `v${extra.protocol}`]);
  }
  if (extra.dataDir) lines.push(["data", extra.dataDir]);
  if (extra.cells?.length) {
    lines.push([
      "cells",
      `${extra.cells.length} (${extra.cells.join(", ")})`,
    ]);
  }
  if (extra.updates) {
    const u = extra.updates;
    // Say the cadence in the units a human thinks in, and say "manual" rather
    // than "0ms" — a number nobody can act on is not information.
    const cadence = u.intervalMs === 0
      ? "manual"
      : u.intervalMs % 3_600_000 === 0
      ? `every ${u.intervalMs / 3_600_000}h`
      : `every ${Math.round(u.intervalMs / 60_000)}m`;
    lines.push([
      "updates",
      `${u.channel} · ${u.kind} · ${cadence} · ${
        u.auto ? "auto-install" : "ask first"
      }`,
    ]);
    lines.push(["source", u.source]);
  } else {
    // An app with no update path should say so once, at the only moment
    // anybody is looking, rather than leaving its absence to be discovered
    // when an update is needed.
    lines.push(["updates", "not configured"]);
  }
  if (extra.feedback) {
    const f = extra.feedback;
    lines.push([
      "feedback",
      `${f.auto ? "auto + user" : "user only"} · keep ${f.keep} · ${
        f.destination ? `→ ${f.destination}` : "local only"
      }`,
    ]);
  }
  return lines;
}
