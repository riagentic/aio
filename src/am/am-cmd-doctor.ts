// `am doctor` — diagnoses the RUNNING app against the tree on disk.
//
// `deno task doctor` (src/server/doctor.ts) checks an app's CONFIG. This is
// the other half of the question, and the one nobody asks until they have
// lost an afternoon to it: is the process that is answering `am state` running
// the framework that is on disk right now?
//
// A source-layout app imports the framework through `dep/aio`. Pull a newer
// aio into that checkout (or `am fix`, which relinks it) while the app is up,
// and the process keeps serving the OLD code — every module was loaded at
// boot — while every reader of the tree (editor, `am pin`, the next test) sees
// the NEW one. Nothing warns. The app's behaviour and its source disagree
// until somebody restarts it, and the report that follows describes a bug that
// no longer exists, or misses one that now does.
//
// The check is two timestamps: the newest mtime under `dep/aio/src` (+ mod.ts)
// against the instance's `startedAt` from its lock. Newer on disk than the
// process is a finding, and the finding names its fix: `am restart`.
import { join, resolve } from "@std/path";
import type { GlobalFlags } from "./am-types.ts";
import {
  block,
  count,
  detectMode,
  heading,
  indent,
  out,
  outError,
  stack,
  statusList,
  tally,
} from "./am-output.ts";
import { instancesInProject, projectRoot } from "./am-cmd-process.ts";
import type { InstanceInfo } from "../server/single-instance-lock.ts";

/** The newest file under a tree, by mtime. `null` for an empty/missing tree.
 *  Skips `node_modules` and `.git` — vendored and history, not the code the
 *  process loaded. */
export async function newestMtimeUnder(
  dir: string,
): Promise<{ path: string; mtime: number } | null> {
  let best: { path: string; mtime: number } | null = null;
  const visit = async (d: string) => {
    let entries: Deno.DirEntry[];
    try {
      entries = await Array.fromAsync(Deno.readDir(d));
    } catch {
      return; // missing tree: the caller reports "no dep/aio"
    }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory) {
        if (e.name === "node_modules" || e.name === ".git") continue;
        await visit(p);
      } else if (/\.tsx?$/.test(e.name)) {
        const st = await Deno.stat(p).catch(() => null);
        const mtime = st?.mtime?.getTime();
        if (mtime !== undefined && (best === null || mtime > best.mtime)) {
          best = { path: p, mtime };
        }
      }
    }
  };
  await visit(dir);
  return best;
}

export type DriftVerdict =
  | { stale: false }
  | { stale: true; newest: string; newestMtime: number; startedAt: number };

/** THE decider, pure: a process that started BEFORE the newest framework file
 *  was written is serving code the disk no longer has. */
export function driftVerdict(
  newest: { path: string; mtime: number } | null,
  startedAt: number,
): DriftVerdict {
  if (newest === null || newest.mtime <= startedAt) return { stale: false };
  return {
    stale: true,
    newest: newest.path,
    newestMtime: newest.mtime,
    startedAt,
  };
}

export type DoctorFinding = {
  check: "running-aio-matches-disk";
  appId: string;
  pid: number;
  ok: boolean;
  detail: string;
  fix?: string;
};

/** The finding for one running instance against the framework under
 *  `<projectDir>/dep/aio`. Exported for the test — the CLI below is the only
 *  product caller. */
export async function checkRunningAio(
  projectDir: string,
  inst: Pick<InstanceInfo, "appId" | "pid" | "startedAt">,
): Promise<DoctorFinding> {
  const link = join(projectDir, "dep", "aio");
  const real = await Deno.realPath(link).catch(() => null);
  const base = { check: "running-aio-matches-disk" as const, ...inst };
  if (real === null) {
    return {
      ...base,
      ok: true,
      detail: "no dep/aio in this project (JSR pin or vendored) — not checked",
    };
  }
  const candidates = await Promise.all([
    newestMtimeUnder(join(real, "src")),
    Deno.stat(join(real, "mod.ts")).then((s) =>
      s.mtime ? { path: join(real, "mod.ts"), mtime: s.mtime.getTime() } : null
    ).catch(() => null),
  ]);
  const newest = candidates.reduce<{ path: string; mtime: number } | null>(
    (a, b) => (b !== null && (a === null || b.mtime > a.mtime)) ? b : a,
    null,
  );
  const v = driftVerdict(newest, inst.startedAt);
  if (!v.stale) {
    return {
      ...base,
      ok: true,
      detail: `running aio is the one on disk (dep/aio → ${real})`,
    };
  }
  const rel = v.newest.startsWith(real)
    ? v.newest.slice(real.length + 1)
    : v.newest;
  return {
    ...base,
    ok: false,
    detail:
      `the running aio differs from dep/aio on disk: ${rel} was written ` +
      `at ${
        new Date(v.newestMtime).toISOString()
      }, the process (pid ${inst.pid}) ` +
      `started at ${new Date(v.startedAt).toISOString()} — it is serving the ` +
      `OLD framework`,
    fix: `am restart --app=${inst.appId}`,
  };
}

/** `am doctor` — every running instance of this project, checked. Exit 1 on
 *  any finding: a stale process is a fact about the machine, and a diagnosis
 *  that exits 0 with a finding in it is one nobody's script will read. */
export async function cmdDoctor(
  _args: string[],
  flags: GlobalFlags,
): Promise<void> {
  const mode = detectMode(flags);
  const root = resolve(projectRoot());
  const running = instancesInProject(root).filter((i) => i.alive);
  if (running.length === 0) {
    out(
      {
        ok: true,
        findings: [],
        message: "no running instance of this project — nothing to compare",
      },
      mode,
      // A person asked a yes/no question and used to get `{ "ok": true,
      // "findings": [], "message": … }` — braces, quotes and an empty array —
      // because the object fell through to JSON.stringify. Say the answer.
      () =>
        stack(
          heading("doctor", "nothing running"),
          block(
            "info",
            "No instance of this project is running, so there is nothing to compare against the framework on disk.",
            undefined,
            "am start",
          ),
        ),
    );
    return;
  }
  const findings = await Promise.all(
    running.map((i) => checkRunningAio(root, i)),
  );
  const bad = findings.filter((f) => !f.ok);
  out({ ok: bad.length === 0, findings }, mode, () =>
    stack(
      heading("doctor", count(findings.length, "instance")),
      statusList(
        findings.map((f) => ({
          tone: f.ok ? "ok" as const : "bad" as const,
          name: f.appId,
          detail: `pid ${f.pid}  ${f.detail}`,
        })),
        { indent: "  " },
      ),
      indent(tally([
        [findings.length - bad.length, "ok", "ok"],
        [bad.length, "failed", "bad"],
      ])),
    ));
  if (bad.length > 0) {
    outError(
      `${
        count(bad.length, "running instance")
      } serve a framework the disk no longer has.`,
      mode,
      bad.map((f) => f.fix).filter(Boolean).join("  ·  ") || "am fix",
    );
    Deno.exit(1);
  }
}
