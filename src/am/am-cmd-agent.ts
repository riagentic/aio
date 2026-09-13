/**
 * @module
 * `am agent` — the whole of aio for a model, in one command: the page (concept,
 * API, every verb, the new-app flow, testing, debugging, shipping) by default,
 * one deeper section with `--task=<slug>`, everything with `--task=all`.
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
 */
import type { GlobalFlags } from "./am-types.ts";
import { detectMode, out, outError } from "./am-output.ts";
import {
  agentBrief,
  BRIEF_SECTIONS,
  BRIEF_TASKS,
  pickSections,
} from "./am-agent-text.ts";
import { VERSION } from "../server/aio.ts";

/** `am agent [--task=<slug>] [--list] [--json]` */
export function cmdAgent(args: string[], flags: GlobalFlags): void {
  const mode = detectMode(flags);
  const task = readTask(args);

  if (args.includes("--list")) {
    const rows = BRIEF_SECTIONS.map((s) => ({
      task: s.slug,
      covers: s.title,
      page: s.page,
    }));
    const width = Math.max(...rows.map((r) => r.task.length));
    out(
      flags.json ? rows : [
        "  am agent prints every page section; --task=<slug> one; --task=all everything",
        ...rows.map((r) => `  ${r.task.padEnd(width)}  ${r.covers}`),
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
    const picked = pickSections(task);
    out({
      version: VERSION,
      sections: picked.map((s) => ({
        task: s.slug,
        title: s.title,
        body: s.body,
        page: s.page,
      })),
    }, "json");
    return;
  }

  // The brief, as text, whoever is reading. See the module note above.
  console.log(agentBrief({ version: VERSION, task }));
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
