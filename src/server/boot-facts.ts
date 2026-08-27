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

/** Where a resolved value came from. The value alone answers "what is it";
 *  this answers "why is it that", which is the question someone actually has
 *  when the value surprises them — and the one a log has never answered, so
 *  they go read three config files to find out which one won. */
export type Provenance =
  | "flag" // a --flag on the command line
  | "config" // aio.run({ … })
  | "deno.json" // the project file
  | "env" // an environment variable
  | "default"; // nobody said — this is the framework's answer

/** A resolved value and the reason it holds. */
export type Sourced<T> = { value: T; from: Provenance };

/** `value (from)` — with `(default)` spelled out rather than implied, because
 *  "the default" is precisely the case people misremember. */
export function sourced(s: Sourced<unknown> | undefined): string | undefined {
  if (!s || s.value === undefined || s.value === null) return undefined;
  return `${s.value} (${s.from})`;
}

/** The optional extras the boot sequence knows and this module cannot derive. */
export type BootExtras = {
  /** Which client shell this app runs — and who decided. The question that
   *  started this: "default target… where is it defined?" */
  client?: Sourced<string>;
  /** The entry module actually running. */
  entry?: Sourced<string>;
  /** TCP port, and whether it was asked for or picked. */
  port?: Sourced<number>;
  /** The interface the server bound, in words — `127.0.0.1` and `0.0.0.0` are
   *  a different security posture, and the banner used to leave that to be
   *  inferred from `expose`. */
  bind?: string;
  /** TLS state in words: `off`, `self-signed`, `provided cert`. */
  tls?: string;
  /** OS process id — for `kill`, for attaching a debugger, for finding it in
   *  `ps` when two builds are running. */
  pid?: number;
  /** Where the logs are, and at what level. */
  logs?: { dir: string; level: string };
  /** JS heap ceiling for this process, already resolved. */
  heap?: string;
  /** Durable action journal, when on. */
  journal?: string;
  /** Cells that run in their own worker thread. */
  workers?: string[];
  /** Cells with CRDT sync enabled. */
  syncCells?: string[];
  /** Custom HTTP routes registered by the app. */
  routes?: number;
  /** serverFn namespaces registered by the app. */
  serverFns?: string[];
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
  if (extra.pid !== undefined) lines.push(["pid", String(extra.pid)]);
  // WHO DECIDED, not just what. `client` is the line that prompted all of
  // this — a target can come from a flag, deno.json, aio.run() or nothing at
  // all, and the running app was the one thing that could not say which.
  const client = sourced(extra.client);
  if (client) lines.push(["client", client]);
  // Inside a compiled binary `Deno.mainModule` is a path in the EMBEDDED
  // filesystem, whose root mirrors the BUILD machine's directory layout
  // (`/tmp/deno-compile-<name>/home/alice/proj/src/app.ts`). It answers "which
  // entry is running", which a repo with several apps needs — but it is not a
  // file on the machine reading the report, and printing it with a bare
  // `(default)` invited people to go looking for it.
  if (extra.entry?.value !== undefined && extra.entry.value !== null) {
    lines.push([
      "entry",
      facts.build === "compiled"
        ? `${extra.entry.value} (embedded in the binary — a build-machine ` +
          `path, not a file here)`
        : sourced(extra.entry)!,
    ]);
  }
  if (extra.bind) lines.push(["bind", extra.bind]);
  const portLine = sourced(extra.port);
  if (portLine) lines.push(["port", portLine]);
  if (extra.tls) lines.push(["tls", extra.tls]);
  if (extra.protocol !== undefined) {
    lines.push(["protocol", `v${extra.protocol}`]);
  }
  if (extra.heap) lines.push(["heap", extra.heap]);
  if (extra.dataDir) lines.push(["data", extra.dataDir]);
  if (extra.logs) {
    lines.push(["logs", `${extra.logs.dir} · ${extra.logs.level}`]);
  }
  if (extra.journal) lines.push(["journal", extra.journal]);
  if (extra.cells?.length) {
    lines.push([
      "cells",
      `${extra.cells.length} (${extra.cells.join(", ")})`,
    ]);
  }
  // Which cells are NOT ordinary: a worker cell runs on its own thread and a
  // synced cell has a second writer. Both change how a symptom is read, and
  // neither was visible without opening the source.
  if (extra.workers?.length) {
    lines.push(["workers", extra.workers.join(", ")]);
  }
  if (extra.syncCells?.length) {
    lines.push(["sync", extra.syncCells.join(", ")]);
  }
  if (extra.routes !== undefined && extra.routes > 0) {
    lines.push(["routes", String(extra.routes)]);
  }
  if (extra.serverFns?.length) {
    lines.push(["serverfns", extra.serverFns.join(", ")]);
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
