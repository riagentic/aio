/**
 * @module
 * `am build` / `am compile` / `am dev` — the three entrances an app author
 * reaches for every day, and the ONE rule about them: they are the app's own
 * `deno task build` / `compile` / `dev`, run for you. Not a second build
 * pipeline that resembles the task, not a re-implementation that agrees with
 * it on the day it was written — the same command line, in the same process
 * tree, so the two spellings cannot drift.
 *
 * Why the task and not the framework's `buildAll()` directly (a decision, not
 * an accident): THE APP'S PIN DECIDES WHICH AIO BUILDS IT. The task is the
 * one place an app records HOW it builds — through the aio version it PINS
 * (`jsr:@riagentic/aio@<pin>/build-all` or `dep/aio/…`), with any flag its
 * author added. An installed `am` calling its own copy of the fleet build
 * would build with `am`'s version of aio, not the app's, and would ignore a
 * customised task — a difference that shows up as two different artifacts for
 * one app. `am publish` already builds this way (am-cmd-publish.ts).
 *
 * ```sh
 * am build                      # = deno task build     (every build.targets)
 * am build server electron      # = deno task build --targets=server,electron
 * am build --list               # = deno task build --list
 * am compile                    # = deno task compile   (the default target)
 * am compile cli                # = deno task build --targets=cli
 * am dev --client=electron      # = deno task dev --client=electron (foreground)
 * ```
 */
import type { CmdHandler, GlobalFlags } from "./am-types.ts";
import { detectMode, outError } from "./am-output.ts";
import { readDenoJson } from "../server/deno-json.ts";

/** The verbs this module owns, each the name of the task it runs. */
export type BuildVerb = "build" | "compile" | "dev";

/** What `am <verb> …` turns into: which task, with which argv. */
export type TaskPlan =
  | { ok: true; task: "build" | "compile" | "dev"; args: string[] }
  | { ok: false; error: string };

/** The argv the user typed AFTER the verb — verbatim. `am`'s global parser
 *  has already interpreted `--force`, `--port=` and friends for its own
 *  purposes, but a build/dev flag is the TASK's to read, so the plan is made
 *  from the raw process argv, not from the parsed remainder. Global flags
 *  written BEFORE the verb (`am --json build`) belong to am and are dropped.
 *  Pure. */
export function argvAfterVerb(
  raw: readonly string[],
  verb: BuildVerb,
): string[] {
  const i = raw.indexOf(verb);
  return i === -1 ? [] : raw.slice(i + 1);
}

/** Turn `am <verb> <argv>` into the task to run and its argv. Pure.
 *
 *  - `build [t…]`: positional words are target names → ONE `--targets=a,b`
 *    (the fleet's own spelling; writing both is refused, not merged).
 *  - `compile`: the app's `compile` task (= build narrowed to the default
 *    target). `compile <t>` is `build --targets=<t>` — the `compile` task
 *    already carries a `--targets=` and the fleet reads the FIRST one, so
 *    appending a second would silently build the default.
 *  - `dev`: everything forwarded verbatim; `deno task dev` is a pass-through
 *    (`--client=electron`, `--expose`, `--port=N`) and so is this. */
export function planTask(verb: BuildVerb, argv: readonly string[]): TaskPlan {
  const flags = argv.filter((a) => a.startsWith("-"));
  const words = argv.filter((a) => !a.startsWith("-"));
  if (verb === "dev") return { ok: true, task: "dev", args: [...argv] };
  const hasTargetsFlag = flags.some((f) => f.startsWith("--targets="));
  if (verb === "build") {
    if (words.length === 0) return { ok: true, task: "build", args: flags };
    if (hasTargetsFlag) {
      return {
        ok: false,
        error: `am build: targets were given twice — as words (${
          words.join(" ")
        }) and as --targets=. Use one: am build ${words.join(" ")}`,
      };
    }
    return {
      ok: true,
      task: "build",
      args: [`--targets=${words.join(",")}`, ...flags],
    };
  }
  // compile
  if (hasTargetsFlag) {
    return {
      ok: false,
      error: "am compile builds ONE target: `am compile <target>`, or " +
        "`am build --targets=a,b` for several",
    };
  }
  if (words.length === 0) return { ok: true, task: "compile", args: flags };
  if (words.length > 1) {
    return {
      ok: false,
      error: `am compile builds ONE target (got: ${
        words.join(" ")
      }) — for several: am build ${words.join(" ")}`,
    };
  }
  // `am compile <t>` runs the app's own `compile` task with the target as an
  // override — NOT the `build` task wearing a `--targets=`.
  //
  // It used to re-route, because the `compile` task line already carries a
  // `--targets=<default>` and the fleet read the FIRST one, so appending a
  // second silently built the default. That workaround was correct about the
  // hazard and wrong about the cure: it meant `am compile cli` and
  // `deno task compile --targets=cli` ran DIFFERENT tasks — precisely the
  // drift this module exists to make impossible. The fleet now takes the LAST
  // occurrence and says so, which is what `parseCli` has always done for the
  // runtime's flags, so the override works and one verb is one task.
  return {
    ok: true,
    task: "compile",
    args: [`--targets=${words[0]}`, ...flags],
  };
}

/** What to say when the app has no such task — the repair, not a shrug. */
export function missingTaskLine(task: string, root: string): string {
  return `am: no "${task}" task in ${root}/deno.json — am ${task} runs the ` +
    `app's own task, so the two can never differ. \`am fix\` adds the ` +
    `standard tasks (dev, build, compile, …) without touching the ones you ` +
    `have.`;
}

/** Run one of the app's tasks in the foreground with inherited stdio, and
 *  exit with its code. THE mechanism behind all three verbs. */
async function runTask(
  verb: BuildVerb,
  flags: GlobalFlags,
  raw: readonly string[] = Deno.args,
): Promise<never> {
  const mode = detectMode(flags);
  const plan = planTask(verb, argvAfterVerb(raw, verb));
  if (!plan.ok) {
    outError(plan.error, mode);
    Deno.exit(1);
  }
  const root = Deno.cwd();
  let tasks: Record<string, unknown> = {};
  try {
    tasks = ((await readDenoJson(root))?.config.tasks ?? {}) as Record<
      string,
      unknown
    >;
  } catch (e) {
    outError(
      `am ${verb}: cannot read ${root}/deno.json (${
        String(e)
      }) — run from the app directory, the one holding deno.json.`,
      mode,
    );
    Deno.exit(1);
  }
  if (typeof tasks[plan.task] !== "string") {
    outError(missingTaskLine(plan.task, root), mode);
    Deno.exit(1);
  }
  const p = new Deno.Command(Deno.execPath(), {
    // `-q`: no `Task build deno run …` banner — the output is the build's
    // own, byte for byte what `deno task -q build` prints.
    args: ["task", "-q", plan.task, ...plan.args],
    cwd: root,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();
  Deno.exit((await p.status).code);
}

/** `am build [targets…] [fleet flags]` — `deno task build`, every target in
 *  deno.json `build.targets` (or the ones named). */
export const cmdBuild: CmdHandler = (_args, flags) => runTask("build", flags);

/** `am compile [target]` — `deno task compile` (the default target), or the
 *  fleet build narrowed to the one target named. */
export const cmdCompile: CmdHandler = (_args, flags) =>
  runTask("compile", flags);

/** `am dev [runtime flags]` — `deno task dev`, in the FOREGROUND: your
 *  terminal, your Ctrl-C. `am start` is the supervised background form. */
export const cmdDev: CmdHandler = (_args, flags) => runTask("dev", flags);
