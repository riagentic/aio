// am status and am instances — what is running, where, and the command
// that stops each one. Split out of am-cmd-process.ts, which re-exports every
// name here, so no importer changes.

import {
  instances,
  isLockOwnerAlive,
  isSocketAlive,
  liveInstancesUnder,
  otherAppsRootOf,
  probeEndpoint,
  replaceLockIf,
} from "../server/single-instance-lock.ts";
import type { InstanceInfo } from "../server/single-instance-lock.ts";
import { join, resolve } from "@std/path";
import {
  appHome,
  appsDirEnv,
  instanceAppsDir,
  instanceOfAppsDir,
  profileOfHome,
} from "../server/app-dirs.ts";
import { homedir } from "../server/paths.ts";
import type { GlobalFlags } from "./am-types.ts";
import { HEY } from "../diagnostics/fmt.ts";
import { VERSION } from "../server/aio-cli.ts";
import {
  block,
  count,
  detectMode,
  formatUptime,
  heading,
  hints,
  indent,
  mark,
  out,
  outError,
  say,
  sayErr,
  stack,
  style,
  table,
  tally,
} from "./am-output.ts";
import {
  holderSince,
  liveLock,
  MAINTENANCE_STATUS,
  maintenanceOp,
  removePid,
  resolveAmAppId,
  runningApps,
  sayOtherRoot,
} from "./am-utils.ts";
import { processPlan } from "./am-components.ts";
import type { StartedBy } from "./am-instance.ts";
import { trojanGet } from "./am-http.ts";
import {
  notAnsweringLine,
  resolveLockTarget,
  startedByInstance,
} from "./am-cmd-stop.ts";
import {
  doorAnswers,
  localAppUrl,
  servesTls,
  waitingMessage,
  waitingOf,
  waitingSaid,
} from "./am-cmd-start.ts";
import { psQuote } from "./am-launch.ts";

/** The one-line pointer a running app's status carries.
 *
 *  Three field reports finished an entire build and only then discovered
 *  `am expect`, `am surface --path=` and `am timeline`; one dumped the whole
 *  32 kB semantic surface into its context five or six times before finding
 *  `--path=`. They named the cause themselves: an agent greps `am help` for
 *  its own word, does not find it, and composes primitives it already knows —
 *  it will not browse. `am status` is the command everyone runs FIRST and
 *  runs OFTEN, which makes it the one place a pointer is actually read.
 *
 *  Pretty mode only: `--json` is parsed by scripts, and prose in a data
 *  channel is noise. */
const STATUS_TIP = `  next: \`am surface --path=App\` (the UI by name) · ` +
  `\`am expect <path> eq <v>\` (assert state) · \`am help\` · docs/AGENTS.md`;

export async function cmdStatus(
  _args: string[],
  flags: GlobalFlags,
): Promise<void> {
  const mode = detectMode(flags);

  // "Is the project up?" is the question a multi-component repo asks, and one
  // line about one of its three apps was not an answer to it.
  {
    const plan = processPlan(_args, {
      app: flags.app,
      port: flags.port,
      entry: flags.entry,
    });
    if (plan.kind === "error") {
      outError(plan.message, mode);
      Deno.exit(1);
    }
    if (plan.kind === "one") {
      flags = { ...flags, app: plan.component.appId };
    } else if (plan.kind === "single" && plan.appId) {
      flags = { ...flags, app: plan.appId };
    } else if (plan.kind === "all") {
      const rows = plan.components.map((c) => {
        const pf = liveLock(c.appId);
        const up = pf !== null && isLockOwnerAlive(pf);
        return {
          component: c.label,
          appId: c.appId,
          // A maintenance hold reads `maintenance` first — its `status` is
          // the "starting" written for older readers.
          status: up
            ? (maintenanceOp(pf) ? MAINTENANCE_STATUS : pf.status ?? "started")
            : "stopped",
          ...(up ? { pid: pf.pid, port: pf.port } : {}),
        };
      });
      out(
        mode === "pretty"
          ? rows.map((r) =>
            `${r.component} (${r.appId}): ${r.status}` +
            (r.pid ? ` (pid ${r.pid}, port ${r.port})` : "")
          ).join("\n")
          : { components: rows },
        mode,
      );
      // Same exit contract as the single-app form, read over the whole
      // project: 0 only when EVERY component is up.
      const up = rows.filter((r) => r.status === "started").length;
      if (up === rows.length) return;
      Deno.exit(rows.some((r) => r.status !== "stopped") ? 2 : 1);
    }
  }

  // `--port` is a GLOBAL flag that `stop` and `kill` honour and `status`
  // ignored — so from one app's directory, `am status --port=<another app's
  // port>` reported on the WRONG app with exit 0, while `am stop --port=` the
  // same number correctly targeted the other one. `resolveLockTarget`'s own
  // comment states the rule: "a flag the help lists as global, silently
  // ignored by one verb of three, is worse than a flag that does not exist".
  let appId = resolveAmAppId(flags.app);
  if (flags.port !== undefined) {
    const t = resolveLockTarget(flags);
    if (t.kind === "target") appId = t.target.appId;
    else if (t.kind === "none") {
      outError(t.error, mode);
      Deno.exit(1);
    }
    // `probe`: nothing of ours holds that port — fall through to the
    // stopped/probe reporting below with the cwd's own id.
  }
  // Wherever the instance's home is: `am status` and `am instances` read the
  // same fact, so they can never disagree about an `appDir`-homed app again.
  const pf = liveLock(appId);
  // Another apps root's app under this lock folder name: answered, and said.
  const otherAppsDir = sayOtherRoot(pf);

  // No lock file → stopped. But "stopped" is only half an answer when OTHER
  // aio apps are up: `am status` said `stopped` while `am instances` listed
  // the app as running, and two liveness sources disagreeing is what makes you
  // stop trusting your own measurements. They never actually disagreed — this
  // command asks about ONE appId (guessed from the cwd) and that one lists
  // every appId. Saying which id was asked about, and what else is running,
  // makes it one answer.
  if (!pf) {
    const others = runningApps();
    // Its PROFILES are not "the app", but they are what the reader is looking
    // for when the app itself is stopped: name each, with the command.
    const profiles = others.filter((i) => i.appId === appId && i.alive)
      .map((i) =>
        i.profile ?? (i.home ? profileOfHome(appId, i.home) : undefined)
      )
      .filter((p): p is string => !!p);
    out(
      {
        appId,
        status: "stopped",
        running: others.map((i) =>
          i.profile ? `${i.appId}@${i.profile}` : i.appId
        ),
        ...(profiles.length
          ? {
            profiles: profiles.map((p) => ({
              key: `${appId}@${p}`,
              stopWith: `am stop --app=${appId}@${p}`,
            })),
          }
          : {}),
      },
      mode,
      () =>
        stack(
          `${mark("warn")} ${style.bold(appId)}  ${style.dim("stopped")}`,
          profiles.length > 0 &&
            block(
              "info",
              `Its profile${profiles.length === 1 ? " is" : "s are"} running: ${
                profiles.map((p) => `${appId}@${p}`).join(", ")
              }.`,
              undefined,
              `am status --app=${appId}@${
                profiles[0]
              }  ·  am stop --app=${appId}@${profiles[0]}`,
            ),
          others.length > 0 &&
            block(
              "info",
              `This directory resolves to "${appId}", and nothing by that name is running.`,
              `${count(others.length, "other app")} ${
                others.length === 1 ? "is" : "are"
              }: ${
                others.map((i) =>
                  `${i.appId} @ ${i.socketPath ? "uds" : `:${i.port}`}`
                ).join(", ")
              }.`,
              "am status --app=<id>",
            ),
        ),
    );
    Deno.exit(1);
  }

  const alive = isLockOwnerAlive(pf);

  // Lock file exists but process dead → stale, clean up
  if (!alive) {
    removePid(appId, pf);
    out(
      mode === "pretty" ? `${appId}: stopped` : { appId, status: "stopped" },
      mode,
    );
    Deno.exit(1);
  }

  // Held by `am backup` / `am restore` — transitional like `stopping`, and
  // named: "starting" was the lie a maintenance hold used to read as.
  const op = maintenanceOp(pf);
  if (op) {
    out(
      mode === "pretty"
        ? `${appId}: maintenance — ${op} is running (pid ${pf.pid})`
        : { appId, status: MAINTENANCE_STATUS, op, pid: pf.pid },
      mode,
    );
    Deno.exit(2);
  }

  // A dev session waiting for a fix — transitional (exit 2), `starting` on
  // the wire (the status union is frozen), and named, with what broke.
  const waiting = waitingOf(pf);
  if (waiting) {
    const said = waitingSaid(appId, waiting.since);
    out(
      mode === "pretty"
        ? `${appId}: starting — ${waitingMessage(appId, pf.pid, waiting, said)}`
        : {
          appId,
          status: "starting",
          pid: pf.pid,
          port: pf.port,
          waiting: { ...waiting, said },
        },
      mode,
    );
    Deno.exit(2);
  }

  // Process alive + stopping → report stopping (exit 2 = transitional, not error)
  if (pf.status === "stopping") {
    out(
      mode === "pretty"
        ? `${appId}: stopping (pid ${pf.pid}, port ${pf.port})`
        : { appId, status: "stopping", pid: pf.pid, port: pf.port },
      mode,
    );
    Deno.exit(2);
  }

  // Process alive — probe control port to distinguish starting vs started
  const port = pf.port;
  const ctrlPort = pf.trojanPort ?? pf.port;
  // `doorAnswers`: a server-only prod app answers `/` with a 503 by design.
  let portResponds = await doorAnswers(ctrlPort);

  // A compiled (prod, zero-TCP) app listens on its Unix socket and NOWHERE
  // else, so the TCP probe above can never succeed — `status` sat on
  // `starting` (exit 2) forever for an app that had been drawing pixels for a
  // minute (a field report). The lock records the socket; probe it.
  if (!portResponds && pf.socketPath) {
    portResponds = await isSocketAlive(pf.socketPath);
  }

  if (portResponds) {
    // Port responds → started (auto-fix lock if stuck at 'starting')
    // CAS: repair only the record read — a lock re-published meanwhile is
    // someone else's, and is left exactly as it is (said, never silent).
    if (
      pf.status !== "started" &&
      !replaceLockIf(pf, (now) => ({ ...now, status: "started" })) &&
      mode === "pretty"
    ) {
      sayErr(
        `am: note: ${appId}'s lock changed while it was read — not repaired`,
      );
    }
    const metrics = await trojanGet(port, "metrics", appId);
    const transport = pf.socketPath ? "uds" : "ws";
    if (metrics.ok) {
      const m = metrics.data as {
        uptime: number;
        connections: number;
        schedules: number;
        cells?: Record<string, number>;
        unserializable?: string[];
      };
      if (mode === "pretty") {
        const uds = pf.socketPath ? `, transport uds (${pf.socketPath})` : "";
        const url = localAppUrl(port, servesTls(pf));
        // A cell JSON refuses is a cell that is NOT reaching disk, on every
        // window, forever. `am status` used to carry it as `cells: {todo: -1}`
        // — a number read as a size, next to the one that matters.
        const bad = m.unserializable?.length
          ? `\n  ${HEY} ${
            m.unserializable.join(", ")
          }: state cannot be serialized — NOT being persisted. See \`am logs error\`.`
          : "";
        out(
          `${appId}: started (pid ${pf.pid}, port ${port}${
            url ? `, ${url}` : ""
          }, uptime ${
            formatUptime(m.uptime)
          }, ${m.connections} connections${uds})${bad}\n${STATUS_TIP}`,
          mode,
        );
      } else {
        const url = localAppUrl(port, servesTls(pf));
        out({
          appId,
          status: "started",
          pid: pf.pid,
          port,
          transport,
          // The client the instance runs (additive): "is there a window?"
          ...(pf.client ? { client: pf.client } : {}),
          ...(url ? { url } : {}),
          ...(pf.socketPath ? { socketPath: pf.socketPath } : {}),
          ...(otherAppsDir ? { otherAppsDir } : {}),
          ...m,
        }, mode);
      }
    } else {
      if (mode === "pretty") {
        const uds = pf.socketPath ? `, transport uds (${pf.socketPath})` : "";
        const url = localAppUrl(port, servesTls(pf));
        out(
          `${appId}: started (pid ${pf.pid}, port ${port}${
            url ? `, ${url}` : ""
          }${uds})\n${STATUS_TIP}`,
          mode,
        );
      } else {
        const url = localAppUrl(port, servesTls(pf));
        out({
          appId,
          status: "started",
          pid: pf.pid,
          port,
          transport,
          // The client the instance runs (additive): "is there a window?"
          ...(pf.client ? { client: pf.client } : {}),
          ...(url ? { url } : {}),
          ...(pf.socketPath ? { socketPath: pf.socketPath } : {}),
          ...(otherAppsDir ? { otherAppsDir } : {}),
        }, mode);
      }
    }
  } else {
    // Port not responding but process alive → starting (exit 2 = transitional, not error).
    // …unless something IS listening where its record says, and does not
    // answer: then it is what `am start` refuses with — the same sentence
    // here, its record's own status, `answering: false` (additive).
    const at = await probeEndpoint(pf);
    const deaf = at !== null && at.state !== "gone";
    out(
      mode === "pretty"
        ? deaf
          ? `${appId}: ${pf.status} — ${notAnsweringLine(pf)}`
          : `${appId}: starting (pid ${pf.pid}, port ${port})`
        : {
          appId,
          status: deaf ? pf.status : "starting",
          pid: pf.pid,
          port,
          ...(pf.client ? { client: pf.client } : {}),
          ...(deaf ? { answering: false, said: notAnsweringLine(pf) } : {}),
        },
      mode,
    );
    Deno.exit(2);
  }
}

/** Does an instance's recorded aio version differ from the `am` reading it?
 *  Unknown (a lock from before the field existed) is not a mismatch — it is
 *  printed as `?` so the absence is visible, not asserted. Pure. */
export function instanceAioMismatch(v: string | undefined): boolean {
  return v !== undefined && v !== VERSION;
}

/** One shell word: bare when it needs no quoting, else single-quoted — for
 *  the shell a user of `os` pastes into (PowerShell on Windows, where `\` is
 *  a plain character and a path is bare as it is). */
function shellWord(s: string, os: typeof Deno.build.os): string {
  if (os === "windows") return /^[\w+=:./\\-]+$/.test(s) ? s : psQuote(s);
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`;
}

/** The command that stops exactly THIS instance — scope included.
 *
 *  `am instances` lists one lock scope: the default, or the one `--instance` /
 *  `AIO_APPS_DIR` selected, and within it every data home an app id runs
 *  from. `stopWith` used to be `am stop --app=<id>` whatever the scope, so
 *  `am instances --instance=agent1 --json` printed a command that, run as
 *  written, looked in the DEFAULT scope — and stopped the human's copy of the
 *  same app instead of the agent's, or found nothing. The command has to carry
 *  every part of the address the list was read with:
 *   - the scope: `--instance=<name>` when that is what set it, otherwise the
 *     `AIO_APPS_DIR=<dir>` it came from (a variable, so it prefixes — as
 *     `$env:AIO_APPS_DIR='<dir>'; ` on Windows: `VAR=x cmd` is POSIX shell
 *     syntax, and ran in neither PowerShell nor cmd);
 *   - the home: `--profile=<name>` for a profile, `--profile=<dir>` for any
 *     other folder than the scope's default home for its id — two boots of
 *     one id are two locks.
 *
 *  Pure over its inputs: `defaultHome` is `appHome(appId)` in the listing's
 *  scope, passed in so the test does not need to move the process env. */
export function stopCommandFor(
  inst: { appId: string; home?: string; profile?: string },
  scope: { instance?: string; appsDir?: string; defaultHome: string },
  os: typeof Deno.build.os = Deno.build.os,
): string {
  const parts = ["am", "stop", `--app=${inst.appId}`];
  let prefix = "";
  if (scope.appsDir) {
    const fromInstance = scope.instance !== undefined &&
      resolve(scope.appsDir) === resolve(instanceAppsDir(scope.instance));
    if (fromInstance) parts.push(`--instance=${scope.instance}`);
    else {
      prefix = os === "windows"
        ? `$env:AIO_APPS_DIR=${psQuote(scope.appsDir)}; `
        : `AIO_APPS_DIR=${shellWord(scope.appsDir, os)} `;
    }
  }
  if (inst.home && resolve(inst.home) !== resolve(scope.defaultHome)) {
    // A profile by its NAME (what was typed to start it); any other folder
    // by its path — the one flag either way.
    const name = inst.profile ??
      (scope.defaultHome
        ? profileOfHome(inst.appId, inst.home, scope.defaultHome)
        : undefined);
    parts.push(
      name
        ? `--profile=${shellWord(name, os)}`
        : `--home=${shellWord(inst.home, os)}`,
    );
  }
  return prefix + parts.join(" ");
}

/** Every instance `am instances` lists, each with the `--instance` scope it
 *  runs in (null: the shared one) and who started it.
 *
 *  From the SHARED scope, every `--instance` scope is listed beside it: a
 *  plain `am instances` hid an agent's `--instance=ux` copy, so "what is
 *  running?" got an incomplete answer and the agent thought its server dead
 *  (jot §8). From inside an instance (or any `AIO_APPS_DIR`) only that scope
 *  — the isolation `--instance` exists for. */
export function listedInstances(): (InstanceInfo & {
  instance: string | null;
  startedBy: StartedBy;
})[] {
  const own = instanceOfAppsDir(appsDirEnv()) ?? null;
  const all = instances().map((i) => ({ ...i, instance: own }));
  if (appsDirEnv() === undefined) {
    let names: string[] = [];
    try {
      names = [...Deno.readDirSync(join(homedir(), ".aio-instances"))]
        .filter((e) => e.isDirectory).map((e) => e.name).sort();
    } catch { /* aio-ok: no instance was ever made — none to list */ }
    for (const name of names) {
      for (const i of liveInstancesUnder(instanceAppsDir(name))) {
        all.push({ ...i, instance: name });
      }
    }
  }
  return all.map((i) => ({ ...i, startedBy: startedByInstance(i) }));
}

export function cmdInstances(_args: string[], flags: GlobalFlags): void {
  const mode = detectMode(flags);
  const all = listedInstances();
  const anyInstance = all.some((i) => i.instance !== null);

  if (all.length === 0) {
    out(
      mode === "pretty" ? "no running aio instances" : [],
      mode,
      () =>
        stack(
          heading("instances", "none running"),
          hints([["am start", "start the app in this directory"]]),
        ),
    );
    return;
  }

  if (mode === "pretty") {
    // A table, because this IS a table: nine `key=value` pairs per line, one
    // line per app, is a shape a person cannot scan down. The columns a reader
    // uses to pick an app come first; `home` and `cwd` are paths nobody
    // compares across rows, so they move behind `--long`.
    const long = flags.long === true;
    const anyCdp = all.some((i) => i.cdpPort);
    const rows = all.map((inst) => ({
      "": mark(inst.status === "started" ? "run" : "warn"),
      // The KEY for a profile (`myapp@dev`) — what `am stop myapp@dev` takes.
      // Another apps root's app (one lock folder name for two roots) is
      // listed, and marked: this `am` does not act on it.
      APP: (inst.profile ? `${inst.appId}@${inst.profile}` : inst.appId) +
        (otherAppsRootOf(inst) ? " (other apps dir)" : ""),
      // Shown only when some row runs in an `--instance` scope.
      ...(anyInstance ? { INSTANCE: inst.instance ?? "" } : {}),
      PID: String(inst.pid),
      // Who started it — `other` may be a person's window.
      BY: inst.startedBy === "unknown" ? "?" : inst.startedBy,
      // A maintenance hold listens on nothing: name the op instead of `:0`.
      // An app with BOTH wires (a socket, and a TCP port for a browser or
      // `am --port`) shows both — "uds" alone hid the port a reader scans
      // this column for.
      LISTENING: maintenanceOp(inst)
        ? `(${maintenanceOp(inst)})`
        : inst.socketPath
        ? (inst.port > 0 ? `:${inst.port} + uds` : "uds")
        : `:${inst.port}`,
      UP: formatUptime(Math.round((Date.now() - holderSince(inst)) / 1000)),
      AIO: instanceAioMismatch(inst.aioVersion)
        ? style.yellow(`${inst.aioVersion ?? "?"} ≠`)
        : inst.aioVersion ?? style.dim("?"),
      // Shown only when SOMETHING has one — a column of dashes for the common
      // case is noise, and the reader who needs it always has one.
      ...(anyCdp ? { CDP: inst.cdpPort ? String(inst.cdpPort) : "" } : {}),
      // DATA before HOME: three things are spelled like "where this app
      // lives" and only `appDir` moves the database (report 1 §20). `home` was
      // the only one shown, so an app whose `appDir` pointed elsewhere looked
      // like it lived where its data did not. Shown only when it differs from
      // the default under `home` — a column repeating the obvious is noise.
      ...(long
        ? {
          SOCKET: inst.socketPath ?? "",
          ...(inst.dataDir && !inst.dataDir.startsWith(inst.home ?? "\u0000")
            ? { DATA: inst.dataDir }
            : {}),
          HOME: inst.home,
          CWD: inst.cwd,
        }
        : {}),
    }));
    const mismatched = all.filter((i) => instanceAioMismatch(i.aioVersion));
    say(stack(
      indent(table(rows, {
        columns: (Object.keys(rows[0]!) as (keyof typeof rows[0])[]).map((
          k,
        ) => ({
          key: k,
          align: k === "PID" ? "right" as const : "left" as const,
        })),
      })),
      indent(tally([[all.length, "running", "ok"]])) +
        (mismatched.length
          ? style.dim("  ·  ") + style.yellow(
            `${mismatched.map((i) => i.appId).join(", ")} ${
              mismatched.length === 1 ? "runs" : "run"
            } an aio that is not ${VERSION}`,
          )
          : ""),
      // This list is MACHINE-WIDE, and that is the fact people act on
      // wrongly. Someone who came here to end an app now has a list that
      // includes other people's work — and the habit that follows is a
      // process-table match, which takes all of them down. So when there is
      // more than one, the safe spelling is offered right here, next to the
      // list that tempts the unsafe one.
      ...all.filter((i) => otherAppsRootOf(i)).map((i) =>
        style.yellow(
          `${i.appId} (pid ${i.pid}) runs under another apps dir, ` +
            `${otherAppsRootOf(i)} — am acts on it only with that ` +
            `AIO_APPS_DIR`,
        )
      ),
      all.length > 1
        ? hints([[
          stopCommandFor({ appId: "<APP>" }, {
            instance: flags.instance,
            appsDir: appsDirEnv(),
            defaultHome: "",
          }),
          appsDirEnv() === undefined
            ? "stops ONE of these (add --instance=<INSTANCE> for one in an " +
              "instance) — this list is every aio app in the shared scope " +
              "and in every --instance"
            : "stops ONE of these — this list is every aio app in this scope " +
              "(an instance or AIO_APPS_DIR scope lists only its own apps)",
        ]])
        : "",
      long ? "" : hints([["am instances --long", "sockets, homes and cwds"]]),
    ));
  } else {
    out(
      all.map((inst) => ({
        appId: inst.appId,
        // The PROFILE (`--profile=dev`) this instance runs under; null for the
        // app's own home and any other folder. Always present, like dataDir.
        profile: inst.profile ??
          (inst.home ? profileOfHome(inst.appId, inst.home) : undefined) ??
          null,
        pid: inst.pid,
        port: inst.port,
        // `am backup` / `am restore` holding the lock is not a booting app:
        // the same `maintenance` + `op` `am status` reports, and no
        // `stopWith` — `am stop` refuses a hold (wait for it, or Ctrl-C it).
        ...(maintenanceOp(inst)
          ? { status: MAINTENANCE_STATUS, op: maintenanceOp(inst) }
          : { status: inst.status }),
        transport: inst.socketPath ? "uds" : "ws",
        ...(inst.socketPath ? { socketPath: inst.socketPath } : {}),
        uptime: Math.round((Date.now() - holderSince(inst)) / 1000),
        // The command that ends THIS app and nothing else, spelled out.
        //
        // A hint is for the pretty branch and an agent is always on the JSON
        // one, so the advice never reached the reader who needed it most —
        // the one whose next move, after listing every aio process on the
        // box, is to match them by name and kill them all. Naming the safe
        // command inline costs a field and removes the guess.
        // Another apps root's app, here because the two roots' lock folders
        // have one name: named, and stopped with ITS root.
        ...(otherAppsRootOf(inst)
          ? { otherAppsDir: otherAppsRootOf(inst) }
          : {}),
        ...(maintenanceOp(inst) ? {} : {
          stopWith: stopCommandFor(
            inst,
            otherAppsRootOf(inst)
              ? {
                appsDir: otherAppsRootOf(inst)!,
                defaultHome: join(otherAppsRootOf(inst)!, inst.appId),
              }
              // Another `--instance` scope, listed from the shared one.
              : inst.instance !== null && appsDirEnv() === undefined
              ? {
                instance: inst.instance,
                appsDir: instanceAppsDir(inst.instance),
                defaultHome: join(instanceAppsDir(inst.instance), inst.appId),
              }
              : {
                instance: flags.instance,
                appsDir: appsDirEnv(),
                defaultHome: appHome(inst.appId),
              },
          ),
        }),
        // The `--instance` scope it runs in (null: the shared one) — every
        // scope is listed, so this is what tells them apart (jot §8).
        instance: inst.instance,
        // Who started it: "am" (`am start`), "other" (a terminal, a launcher
        // — possibly a person's window: `am stop` says so when it ends one),
        // "unknown" (started by an am too old to record it).
        startedBy: inst.startedBy,
        // The DevTools port, when the app was started with `--cdp`.
        //
        // The lock has recorded it since `am shot` needed it; nothing reported
        // it, and `port` above is the WS transport port — `0` for any UDS app.
        // So an agent looking for "the port I can drive this window through"
        // found either nothing or the wrong number, and the wrong number is the
        // problem: a field report scanned `ss -ltnp` for an Electron listener,
        // got ANOTHER aio app's CDP port, and spent a long stretch believing
        // its own correct routes were broken — every observation after that
        // point was confidently about someone else's window. Ambiguity that
        // resolves silently into another app's DOM is the worst shape
        // available, and an agent has no peripheral vision to catch it.
        // One field closes it entirely.
        cdpPort: inst.cdpPort ?? null,
        aio: inst.aioVersion ?? null,
        aioMismatch: instanceAioMismatch(inst.aioVersion),
        home: inst.home,
        // Where the DATA is. `home` and `dataDir` are the SAME question only
        // when the app did not set `appDir`; three spellings mean "where this
        // app lives" and only that one moves the database (report 1 §20). Always
        // present in --json (null when the lock predates it) — a field that
        // appears conditionally is a field a script has to guess about.
        dataDir: inst.dataDir ?? null,
        cwd: inst.cwd,
      })),
      mode,
    );
  }
}
