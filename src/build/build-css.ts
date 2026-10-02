// The door for a CSS toolchain — Tailwind, PostCSS, Sass, or a shell script.
//
// WHY THIS EXISTS. `grep -ril tailwind docs/ src/` returned zero hits, and two
// field reports said the same thing about it: for a large share of new projects
// Tailwind is not a preference, it is the assumed default, and its total
// absence reads as "unsupported" even though nothing was actually blocked. The
// honest answer to "can I use Tailwind with aio?" was "yes, if you run the CLI
// yourself, and nothing in the framework knows" — which is the shape of answer
// that loses an evaluation.
//
// WHY IT IS CHEAP. aio already solved the hard half. `docs/ui/theme.md`'s
// contract is that the generated theme steps fully aside the moment
// `style.css` exists, and Tailwind's output IS a `style.css`. The architecture
// already accommodates this; only the ergonomics were missing. So this is one
// optional key and a step that runs before the stylesheet is read — no new
// concept, no dependency, and nothing changes for an app that omits it.
//
// TWO RULES, both learned from this project's own scars.
//
// FAIL LOUD. A CSS step that quietly did not run is exactly the "pretends to
// work" class: the build succeeds, `dist/style.css` is yesterday's, and the app
// ships unstyled or half-styled with every gate green. A non-zero exit is a
// failed build, and a command that cannot be spawned at all says which command
// and why. It is never "skipped".
//
// NO SHELL. The command is argv, not a shell line — split on whitespace, or
// given as an array. `deno task` already exists for pipes and `&&`, and a
// config value that reaches a shell is a config value that can do anything a
// shell can. A quoted argument with spaces takes the array form.
import { readDenoJson } from "../server/deno-json.ts";

/** How the command was declared, once it is argv. */
export type CssBuildStep = { readonly argv: readonly string[] };

/** Read `build.css` from an app's deno.json, or null when it declares none.
 *
 *  Throws on a malformed value rather than ignoring it: a `build.css` that is a
 *  number, an empty string or an array with a non-string in it is a mistake the
 *  author wants to hear about now, not after shipping an unstyled build. */
export function cssBuildStep(
  denoJsonConfig: unknown,
): CssBuildStep | null {
  const build = (denoJsonConfig as { build?: unknown } | undefined)?.build;
  if (!build || typeof build !== "object") return null;
  const raw = (build as { css?: unknown }).css;
  if (raw === undefined || raw === null) return null;
  if (typeof raw === "string") {
    const argv = raw.trim().split(/\s+/).filter(Boolean);
    if (argv.length === 0) {
      throw new Error(
        `deno.json build.css is an empty string. Give it a command — e.g. ` +
          `"deno run -A npm:@tailwindcss/cli -i src/app.css -o src/style.css" ` +
          `— or remove the key.`,
      );
    }
    return { argv };
  }
  if (Array.isArray(raw)) {
    if (raw.length === 0 || !raw.every((a) => typeof a === "string" && a)) {
      throw new Error(
        `deno.json build.css, as an array, must be a non-empty list of ` +
          `non-empty strings (argv). Got ${JSON.stringify(raw)}.`,
      );
    }
    return { argv: raw as string[] };
  }
  throw new Error(
    `deno.json build.css must be a command string or an argv array, not ` +
      `${typeof raw}. Example: "build": { "css": "deno run -A ` +
      `npm:@tailwindcss/cli -i src/app.css -o src/style.css" }`,
  );
}

/** Result of one CSS build. `ran: false` means the app declared no step. */
export type CssBuildResult = {
  readonly ran: boolean;
  readonly ok: boolean;
  readonly command?: string;
  readonly output?: string;
  readonly ms?: number;
  /** The step was ended by the caller's `signal` — neither a success nor a
   *  failure of the command, and reported as neither. */
  readonly stopped?: boolean;
  /** …and it did not end when asked: it was killed. */
  readonly killed?: boolean;
  /** …and a process it started still holds its output: that one runs on. */
  readonly left?: boolean;
};

/** How long a step that was asked to end gets before it is killed. Short: the
 *  dev server's close is waiting, and a CSS tool has nothing to save. */
const STOP_GRACE_MS = 500;

/** How long a stopped step's pipes get to show their end. The process has
 *  exited by then, so the end is already there unless something else holds
 *  the pipe; this only decides what the log line says. */
const PIPES_END_MS = 100;

/** `work`, or false if it has not settled within `ms` — no timer left armed. */
async function within(work: Promise<unknown>, ms: number): Promise<boolean> {
  let t: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work.then(() => true),
      new Promise<false>((r) => t = setTimeout(() => r(false), ms)),
    ]);
  } finally {
    clearTimeout(t);
  }
}

/** Signal a child that may already have exited. */
function signalChild(child: Deno.ChildProcess, sig: Deno.Signal): void {
  try {
    child.kill(sig);
  } catch {
    // aio-ok: it has already exited — the exit is what the caller waits for
    // next, and there is nothing left to signal.
  }
}

/** End a running step: ask, wait for its EXIT a short grace, then kill.
 *  Returns whether it had to be killed. Waits for the exit only, never for
 *  the pipes — a child of the step can hold those for as long as it likes. */
async function endChild(child: Deno.ChildProcess): Promise<boolean> {
  signalChild(child, "SIGTERM");
  if (await within(child.status, STOP_GRACE_MS)) return false;
  signalChild(child, "SIGKILL");
  await child.status;
  return true;
}

/** Read a pipe to its end, keeping what came — and able to stop reading. */
function collect(stream: ReadableStream<Uint8Array>): {
  done: Promise<void>;
  text: () => string;
  cancel: () => Promise<void>;
} {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let text = "";
  const done = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += dec.decode(value, { stream: true });
    }
  })();
  return {
    done,
    text: () => text + dec.decode(),
    cancel: async () => {
      await reader.cancel();
      await done;
    },
  };
}

/**
 * Run the app's declared CSS step, if it has one.
 *
 * `throwOnFail` is the dev/prod split, and it is the allowed direction: a BUILD
 * refuses (an unstyled artifact must not ship), while the dev watcher reports
 * and keeps serving (a typo in a Tailwind class must not kill the dev server
 * you are using to fix it). Dev is never more permissive about what SHIPS.
 */
export async function runCssBuild(
  root: string,
  opts: {
    throwOnFail: boolean;
    log?: (msg: string) => void;
    /** Ends the step: its process is asked to end, killed if it does not,
     *  and this returns once it has EXITED, with `stopped: true`. The dev
     *  server's close uses it; a build never does. */
    signal?: AbortSignal;
  } = {
    throwOnFail: true,
  },
): Promise<CssBuildResult> {
  const cfg = (await readDenoJson(root))?.config;
  const step = cssBuildStep(cfg);
  if (!step) return { ran: false, ok: true };

  const command = step.argv.join(" ");
  // Ended before it began: nothing is started, and nothing is reported.
  if (opts.signal?.aborted) {
    return { ran: true, ok: false, command, stopped: true };
  }
  const started = Date.now();
  let child: Deno.ChildProcess;
  try {
    child = new Deno.Command(step.argv[0]!, {
      args: step.argv.slice(1),
      cwd: root,
      stdout: "piped",
      stderr: "piped",
    }).spawn();
  } catch (e) {
    // A command that cannot be SPAWNED is the most common failure here (the
    // tool is not installed) and the least self-explanatory, so it names both
    // the command and the reason rather than surfacing a bare NotFound.
    const msg = `deno.json build.css could not run \`${command}\`: ${
      e instanceof Error ? e.message : String(e)
    }`;
    if (opts.throwOnFail) throw new Error(msg);
    opts.log?.(msg);
    return { ran: true, ok: false, command, output: msg };
  }
  const stdout = collect(child.stdout);
  const stderr = collect(child.stderr);
  const pipes = Promise.all([stdout.done, stderr.done]);
  // A run ends on its own — the exit AND both pipes at their end, so the
  // output is whole — or it is ended by the signal, whichever comes first.
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<"aborted">((r) => {
    onAbort = () => r("aborted");
    opts.signal?.addEventListener("abort", onAbort, { once: true });
  });
  let status: Deno.CommandStatus;
  try {
    const ended = await Promise.race([
      Promise.all([child.status, pipes]).then(() => "ended" as const),
      aborted,
    ]);
    if (ended === "aborted") {
      const killed = await endChild(child);
      // The step's own process is gone. Its pipes are at their end too —
      // unless a process IT started still holds them: the stop reaches the
      // step's process only, and whatever a wrapper left behind runs on.
      const left = !await within(pipes, PIPES_END_MS);
      await Promise.all([stdout.cancel(), stderr.cancel()]);
      return {
        ran: true,
        ok: false,
        command,
        ms: Date.now() - started,
        stopped: true,
        killed,
        left,
      };
    }
    status = await child.status;
  } finally {
    if (onAbort) opts.signal?.removeEventListener("abort", onAbort);
  }
  const out = { success: status.success, code: status.code };
  const text = (stdout.text() + stderr.text()).trim();
  const ms = Date.now() - started;
  if (!out.success) {
    const msg =
      `deno.json build.css failed (exit ${out.code}): \`${command}\`` +
      (text ? `\n${text}` : "");
    if (opts.throwOnFail) throw new Error(msg);
    opts.log?.(msg);
    return { ran: true, ok: false, command, output: text, ms };
  }
  return { ran: true, ok: true, command, output: text, ms };
}
