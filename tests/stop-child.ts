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

import { descendantPids } from "../src/server/single-instance-lock.ts";

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
  try {
    proc.kill("SIGTERM");
  } catch {
    return await proc.status.catch(() => null); // already gone
  }
  // `ReturnType<typeof setTimeout>`: some test graphs pull Node types in, where
  // it is a `Timeout` object rather than a number.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((r) => {
    timer = setTimeout(() => r("timeout"), grace);
  });
  const outcome = await Promise.race([
    proc.status.then((st) => st).catch(() => null),
    timeout,
  ]);
  clearTimeout(timer);
  if (outcome !== "timeout") return outcome;
  // The TREE, not just the process it was asked about: a browser leaves a
  // zygote and its renderers, an app leaves whatever it spawned, and a
  // survivor holds the port (and the lock) the next test needs. THE
  // descendant walk (`single-instance-lock.ts`), never a second copy of it.
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
  if (opts.quiet) return null;
  const tail = opts.log?.().slice(-2000) ?? "";
  throw new Error(
    `${label} (pid ${proc.pid}) ignored SIGTERM for ${grace}ms and had to be ` +
      `SIGKILLed — an app that does not stop when asked is a defect, and an ` +
      `unbounded wait here hangs the whole suite.\n` +
      `  At ${grace}ms this is very unlikely to be a slow machine, but read ` +
      `tests/exit-promptly.test.ts first: it measures the same property in ` +
      `milliseconds and will say so plainly if the app really does not stop.${
        tail ? `\n── the child's last output ──\n${tail}` : ""
      }`,
  );
}
