// Stopping a spawned app, with a DEADLINE.
//
// `proc.kill("SIGTERM"); await proc.status` is unbounded: a child that does not
// act on SIGTERM hangs the test — and, because deno test runs files in one
// runner, the whole suite. That is exactly what happened here (a `--expose`d
// app in tests/seam-paths.test.ts, 56 minutes before it was noticed, with the
// runner reporting only "has been running for over 16m0s"). A hang says
// nothing; a bounded stop that FAILS says which child, after how long, with
// its own output.
//
// It is also the stricter test of the product: aio's contract is that an app
// stops when asked ("what it opens, it closes" — alpha65), so a child that
// needs SIGKILL is a defect, not a slow machine.
//
// HOW GENEROUS the grace should be is a question this helper is the wrong
// place to answer. It was 15 s, and a full suite running beside a `--expose`
// app exceeded it twice during the alpha72 audit — a red that says "your app
// ignored SIGTERM" when the truth was "this machine had 764 test files on it".
// A confusing red costs more than a slow one.
//
// So the promptness of a stop is measured EXACTLY ONCE, precisely, on its own:
// `tests/exit-promptly.test.ts` times a real process from `app.close()` to
// unload (49 ms) and from a refused boot to exit (103 ms), against a ceiling
// that a loaded machine cannot plausibly cross. That is the gate. This grace
// is only a backstop against a suite that would otherwise hang forever, so it
// can afford to be patient — raising it weakens nothing, because it is not
// what proves the property.

//
// WINDOWS has no SIGTERM to deliver: `proc.kill("SIGTERM")` is
// TerminateProcess there — no handler, no `onStop`, no final save — so for
// the whole 1.0.19 port every file using this helper hard-killed its app and
// the "needed a hard kill" verdict could not fire. There the app is asked the
// way `am stop` and `--takeover` ask it: the stop request
// (`askToStop`, single-instance-lock.ts) at the endpoint the app's own lock
// record names, with the control credential beside its data. Only a child
// with no lock record (a browser, a sleeper, a file watcher, an app run with
// `singleton: false` — nothing `am stop` could find either) is ended
// outright, as before.

import { dirname, join } from "@std/path";
import {
  descendantsIn,
  familyTies,
  WINDOWS_PROCESS_QUERY,
  windowsProcessRows,
} from "./proc-helper.ts";
import {
  askToStop,
  descendantPids,
  type LockData,
  lockDir,
} from "../src/server/single-instance-lock.ts";

const WINDOWS = Deno.build.os === "windows";
/** Between two looks for the app's lock record / two stop requests. */
const ASK_POLL_MS = 200;

/** Every lock record under the runtime base, whatever apps root it is scoped
 *  to: a child is given its own `AIO_APPS_DIR` more often than not, and its
 *  lock dir is a sibling of this process's (`lockDir`). */
function lockRecords(): LockData[] {
  const base = dirname(lockDir());
  const out: LockData[] = [];
  let dirs: string[];
  try {
    dirs = [...Deno.readDirSync(base)]
      .filter((e) => e.isDirectory && e.name.startsWith("aio"))
      .map((e) => join(base, e.name));
  } catch {
    return out; // aio-ok: no runtime base — no app has started
  }
  for (const dir of dirs) {
    try {
      for (const e of Deno.readDirSync(dir)) {
        if (!e.isFile || !e.name.endsWith(".lock")) continue;
        try {
          const l = JSON.parse(Deno.readTextFileSync(join(dir, e.name)));
          if (typeof l?.pid === "number" && typeof l?.appId === "string") {
            out.push(l as LockData);
          }
        } catch { /* aio-ok: mid-write or removed — the next look reads it */ }
      }
    } catch { /* aio-ok: pruned between the listing and the read */ }
  }
  return out;
}

/** `pid` and everything under it, on Windows (`deno task` is a parent of the
 *  app, never the app). CIM, because `pgrep` is not there. */
async function windowsTree(pid: number): Promise<Set<number>> {
  const o = await new Deno.Command("powershell", {
    args: ["-NoProfile", "-Command", WINDOWS_PROCESS_QUERY],
    stdout: "piped",
    stderr: "null",
  }).output();
  // By parent pid AND creation time (`familyTies`): a parent pid alone also
  // names strangers whose dead parent once had this number.
  const ties = familyTies(
    windowsProcessRows(new TextDecoder().decode(o.stdout)),
  );
  return new Set([pid, ...descendantsIn(ties, pid)]);
}

/** The lock record of the app running as `pid` or under it; null when there
 *  is none — the child is not an aio app, or has not taken its lock yet. */
async function lockUnder(pid: number): Promise<LockData | null> {
  const all = lockRecords();
  const own = all.find((l) => l.pid === pid);
  if (own || all.length === 0) return own ?? null;
  const tree = await windowsTree(pid);
  return all.find((l) => tree.has(l.pid)) ?? null;
}

/** Windows: ask the app under `proc` to stop, until it accepts, it is gone,
 *  or `until`. "none": there is nothing to ask. */
async function askWindows(
  proc: Deno.ChildProcess,
  gone: () => boolean,
  until: number,
): Promise<"asked" | "none" | "refused"> {
  for (let first = true; !gone() && Date.now() < until; first = false) {
    const lock = await lockUnder(proc.pid);
    if (!lock) {
      if (first) return "none";
    } else if (await askToStop(lock)) return "asked";
    // A record with no door yet (`starting`, port 0) is a boot in progress:
    // the request is repeated until the app can hear it.
    await new Promise((r) => setTimeout(r, ASK_POLL_MS));
  }
  return "refused";
}

/** Ask `proc` to stop, wait at most `graceMs`, then SIGKILL and THROW.
 *
 *  Returns the exit status when the child went down on its own. `label` and
 *  `log` (whatever the caller drained from the child) are what the failure
 *  carries — a test that hangs at 3am must name itself. */
export async function stopChild(
  proc: Deno.ChildProcess,
  opts: {
    label?: string;
    graceMs?: number;
    log?: () => string;
    /** Cleanup mode: SIGKILL after the grace and return, instead of throwing.
     *  A `finally` block that throws turns one failing test into a failing
     *  test plus a leaked process — but it must still not WAIT forever, which
     *  is the whole point of this helper. */
    quiet?: boolean;
  } = {},
): Promise<Deno.CommandStatus | null> {
  const grace = opts.graceMs ?? 45_000;
  const label = opts.label ?? "the spawned app";
  let gone = false;
  const status = proc.status.then((st) => (gone = true, st)).catch(() => (
    gone = true, null
  ));
  const started = Date.now();
  let how = "ignored SIGTERM";
  if (WINDOWS) {
    const said = await askWindows(proc, () => gone, started + grace);
    if (gone) return await status;
    if (said === "none") {
      // Nothing to ask: ended outright, tree and all — not a verdict on it.
      await killTree(proc);
      return await status;
    }
    how = said === "asked"
      ? "accepted the stop request but did not exit"
      : "never accepted the stop request (POST /__aio/trojan/shutdown)";
  } else {
    try {
      proc.kill("SIGTERM");
    } catch {
      return await status; // already gone
    }
  }
  // `ReturnType<typeof setTimeout>`: some test graphs pull Node types in, where
  // it is a `Timeout` object rather than a number.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((r) => {
    timer = setTimeout(
      () => r("timeout"),
      Math.max(0, started + grace - Date.now()),
    );
  });
  const outcome = await Promise.race([status, timeout]);
  clearTimeout(timer);
  if (outcome !== "timeout") return outcome;
  await killTree(proc);
  if (opts.quiet) return null;
  const tail = opts.log?.().slice(-2000) ?? "";
  throw new Error(
    `${label} (pid ${proc.pid}) ${how} for ${grace}ms and had to be ` +
      `SIGKILLed — an app that does not stop when asked is a defect, and an ` +
      `unbounded wait here hangs the whole suite.\n` +
      `  At ${grace}ms this is very unlikely to be a slow machine, but read ` +
      `tests/exit-promptly.test.ts first: it measures the same property in ` +
      `milliseconds and will say so plainly if the app really does not stop.${
        tail ? `\n── the child's last output ──\n${tail}` : ""
      }`,
  );
}

/** SIGKILL `proc` and everything under it, and wait for `proc` to be gone. */
async function killTree(proc: Deno.ChildProcess): Promise<void> {
  // The TREE, not just the process it was asked about: a browser leaves a
  // zygote and its renderers, an app leaves whatever it spawned, and a
  // survivor holds the port (and the lock) the next test needs. THE
  // descendant walk (`single-instance-lock.ts`), never a second copy of it.
  if (WINDOWS) {
    // `taskkill /T` is the tree walk there, taken while the parent lives.
    await new Deno.Command("taskkill", {
      args: ["/T", "/F", "/PID", String(proc.pid)],
      stdout: "null",
      stderr: "null",
    }).output().catch(() => {}); // aio-ok: no taskkill — the kill below still ends the child
  }
  let kids: number[] = [];
  try {
    kids = await descendantPids(proc.pid);
  } catch { /* pgrep missing (windows) — the direct child still goes */ }
  try {
    proc.kill("SIGKILL");
  } catch { /* raced with its own exit */ }
  await proc.status.catch(() => {});
  // Deepest first, so a parent cannot spawn a replacement on its way out.
  for (const pid of kids.reverse()) {
    try {
      Deno.kill(pid, "SIGKILL");
    } catch { /* already gone, or not ours */ }
  }
}
