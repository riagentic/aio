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
};

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
  opts: { throwOnFail: boolean; log?: (msg: string) => void } = {
    throwOnFail: true,
  },
): Promise<CssBuildResult> {
  const cfg = (await readDenoJson(root))?.config;
  const step = cssBuildStep(cfg);
  if (!step) return { ran: false, ok: true };

  const command = step.argv.join(" ");
  const started = Date.now();
  let out: Deno.CommandOutput;
  try {
    out = await new Deno.Command(step.argv[0]!, {
      args: step.argv.slice(1),
      cwd: root,
      stdout: "piped",
      stderr: "piped",
    }).output();
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
  const text = (new TextDecoder().decode(out.stdout) +
    new TextDecoder().decode(out.stderr))
    .trim();
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
