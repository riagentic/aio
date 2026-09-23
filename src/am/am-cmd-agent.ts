/**
 * @module
 * `am agent` — the whole of aio for a model, in one command: the page (concept,
 * API, every verb, the new-app flow, testing, debugging, shipping) by default,
 * a compact rendition with `--min`, everything with `--max`, one section with
 * `--task=<slug>`.
 *
 * The text lives in am-agent-text.ts (a leaf, so a gate and the scaffolder can
 * both read it). This file is the door: argument handling, and the one output
 * decision worth explaining.
 *
 * **Why this command prints prose to a pipe.** Every other `am` command treats
 * "no terminal on the other end" as "a machine is reading, send JSON"
 * (`detectMode`), which is right when the payload is DATA. Here the payload is
 * the text itself, and the reader is a model whose stdout is always a pipe. In
 * JSON mode that text arrives as one enormous quoted line with literal `\n`
 * escapes — technically parseable, unreadable in practice, and the exact shape
 * `am-output.ts` already calls out as the wrong answer for a command that only
 * has a sentence to say. So the brief prints as the brief, and `--json` is
 * available for a caller that really wants the sections addressable.
 *
 * That is a formatting choice keyed on what this command's payload IS, not a
 * behaviour fork: both forms carry the same bytes of brief, and asking for
 * `--json` gets JSON on a terminal and off it alike.
 *
 * **Why three sizes.** Context windows differ by an order of magnitude between
 * the models that read this. A small window wants the rules, the model, the
 * loop and the three shapes (a cell, a component, a test) and nothing else; a
 * large one wants every deep section at once rather than eight `--task` calls.
 * `--min` / (default) / `--max` are those three; the sections and their order
 * are the same, only the rendition changes.
 */
import type { GlobalFlags } from "./am-types.ts";
import { detectMode, out, outError, say } from "./am-output.ts";
import {
  agentBrief,
  BRIEF_SECTIONS,
  BRIEF_TASKS,
  type BriefLevel,
  levelSections,
  pickSections,
} from "./am-agent-text.ts";
import { VERSION } from "../server/aio.ts";

/** `am agent [--min|--medium|--max] [--task=<slug>] [--list] [--json]` */
export function cmdAgent(args: string[], flags: GlobalFlags): void {
  const mode = detectMode(flags);
  const task = readTask(args);
  const level = readLevel(args);

  if (level === null) {
    outError(
      "pick ONE size: --min, --medium (the default), or --max",
      mode,
      "am agent --min prints the compact brief; am agent --max everything",
    );
    Deno.exit(1);
  }

  if (args.includes("--list")) {
    const rows = BRIEF_SECTIONS.map((s) => ({
      task: s.slug,
      covers: s.title,
      page: s.page,
      min: s.min !== undefined,
    }));
    const width = Math.max(...rows.map((r) => r.task.length));
    out(
      flags.json ? rows : [
        "  am agent prints every page section (Markdown); --min the compact " +
        "brief; --max everything; --task=<slug> one",
        "  size column: min = on the --min page too · page = default · deep = " +
        "--max / --task only",
        ...rows.map((r) =>
          `  ${r.task.padEnd(width)}  ${
            (r.min ? "min" : r.page ? "page" : "deep").padEnd(4)
          }  ${r.covers}`
        ),
      ].join("\n"),
      flags.json ? "json" : "pretty",
    );
    return;
  }

  // `--task` with no section is a question with the answer missing. It fell
  // through to "no task", printed the WHOLE brief and exited 0 — the silent
  // version of exactly what the gate below refuses for a mistyped slug.
  if (
    task === "" ||
    (task === undefined && args.includes("--task"))
  ) {
    outError(
      "--task needs a section: am agent --task=<slug>",
      mode,
      `sections: ${BRIEF_TASKS.join(", ")}, all (am agent --list)`,
    );
    Deno.exit(1);
  }

  if (task !== undefined && task !== "all" && !BRIEF_TASKS.includes(task)) {
    outError(
      `no such section: ${task}`,
      mode,
      `sections: ${BRIEF_TASKS.join(", ")}, all (am agent --list)`,
    );
    Deno.exit(1);
  }

  if (flags.json) {
    const picked = task !== undefined
      ? pickSections(task).map((section) => ({
        section,
        text: level === "min" && section.min !== undefined
          ? section.min
          : section.body,
      }))
      : levelSections(level);
    out({
      version: VERSION,
      level: task === "all" ? "max" : level,
      sections: picked.map(({ section, text }) => ({
        task: section.slug,
        title: section.title,
        body: text,
        page: section.page,
        min: section.min !== undefined,
      })),
    }, "json");
    return;
  }

  // The brief, as text, whoever is reading. See the module note above.
  say(agentBrief({ version: VERSION, task, level }));
}

/** `--task=<slug>`, or undefined. A bare `am agent <slug>` is accepted too —
 *  an agent that has just been told the slugs will try the shorter spelling,
 *  and refusing it teaches nothing. @internal */
export function readTask(args: string[]): string | undefined {
  const flag = args.find((a) => a.startsWith("--task="));
  if (flag) return flag.slice("--task=".length);
  const bare = args.find((a) => !a.startsWith("-"));
  return bare;
}

/** The size asked for: `--min` / `--medium` / `--max`, `medium` when none;
 *  `null` when two are given at once (a contradiction to refuse, not to
 *  resolve by position). @internal */
export function readLevel(args: string[]): BriefLevel | null {
  const asked = (["min", "medium", "max"] as const).filter((l) =>
    args.includes(`--${l}`)
  );
  if (asked.length > 1) return null;
  return asked[0] ?? "medium";
}
