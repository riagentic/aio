/**
 * @module
 * THE per-verb flag table for `am`, and the one validator that reads it.
 *
 * A mistyped flag used to be handled three different ways in one CLI:
 * `am logs --zzz` refused with "unknown flag" and exit 1; `am status --zzz`,
 * `am instances --zzz`, `am timeline --zzz`, `am snapshot --zzz` and
 * `am top --zzz` accepted it and did the default thing; and `am state --zzz`
 * read it as a STATE PATH and answered `undefined` — a typo silently reported
 * as an absent value. All three are the same defect: `parseGlobalFlags` keeps
 * the flags it knows and drops everything else into the positional list, where
 * each command decides for itself (or does not) what an unknown `--word` is.
 *
 * So the flags live in a table and one gate reads it, before any command runs:
 * a `--flag` that is neither global nor listed for the verb is refused, with a
 * did-you-mean. {@linkcode PASSTHROUGH} names the verbs where that is exactly
 * wrong — the ones whose surplus flags are FORWARDED to another program (deno,
 * the app itself, an installer). There the caller's flag is not am's to judge,
 * and saying so in the table is how that stays a decision rather than a gap.
 *
 * tests/am-unknown-flags.test.ts pins both halves: every gated verb refuses
 * `--zzz`, and every verb in `am`'s command map appears here.
 */

/** Flags `parseGlobalFlags` consumes — accepted after every verb. */
export const GLOBAL_FLAGS: readonly string[] = [
  "--all",
  "--app",
  "--args",
  "--as-server",
  "--body",
  "--client",
  "--client-index",
  "--data",
  "--entry",
  "--filter",
  "--follow",
  "--force",
  "--help",
  "--home",
  "--json",
  "--lines",
  "--long",
  "--no-wait",
  "--port",
  "--print",
  "--quiet",
  "--stale",
  "--tables",
  "--timeout",
  "--transport",
  "--ui",
  "--wait",
];

/** Verbs whose extra flags belong to something else, with the reason. Nothing
 *  is validated for these — an unknown flag is the other program's to reject,
 *  and am guessing on its behalf would break the forwarding. */
export const PASSTHROUGH: Readonly<Record<string, string>> = {
  start: "flags are handed to the app's own process (--env-file, --expose, …)",
  restart: "replays and forwards start's flags",
  watch: "starts the app; same forwarding as start",
  dev: "= deno task dev — flags go to the app",
  build: "= deno task build — fleet flags go to the build",
  compile: "= deno task compile — flags go to the build",
  publish: "release flags (--dir --channel --notes --targets --key --data …)",
  // NOT `--dir`: `am create` refuses it by name ("there is no --dir; cd where
  // you want it first"), and a note advertising a refused flag is the same
  // defect as a help omitting a real one. The full list lives in
  // am-help-text.ts (CREATE_FLAGS) and is printed by both the help and the
  // refusal.
  create: "scaffold flags (--template --target --aio-version --mirror --jsr)",
  lab: "VM flags (--ram --cpus --disk --apk --tunnel …)",
  ui: "flags are forwarded to amui (`am ui --client=browser`)",
  upgrade: "hands off to the installer for am / an app / a checkout",
  fix: "repair flags, some forwarded to deno",
  auth: "per-subcommand fields (--email --password --role …)",
};

/** Flags each remaining verb accepts, on top of {@linkcode GLOBAL_FLAGS}.
 *  A verb with nothing of its own is listed with an empty array — presence in
 *  this table is what says "someone decided", and the test requires it. */
export const VERB_FLAGS: Readonly<Record<string, readonly string[]>> = {
  // Process
  stop: [],
  kill: [],
  status: [],
  instances: [],
  // State
  //
  // `--watch` is DOCUMENTED (`am help`: "state <path> --watch    A line per
  // CHANGE, not per poll — the loop you were about to write") and IMPLEMENTED
  // (`am-cmd-state.ts` reads it, and has a whole comment about accepting it on
  // either side of the path). It was simply absent here, so the central gate
  // killed the command before it ran. The two tests around this table pin
  // "every gated verb refuses --zzz" and "every verb appears" — neither can
  // see a flag the COMMAND implements and the table omits. That direction is
  // gated now too (tests/am-help-flags-are-accepted.test.ts).
  state: ["--watch"],
  expect: [],
  record: ["--from"],
  timeline: ["--from"],
  replay: ["--from", "--dry"],
  open: [],
  dispatch: [],
  actions: [],
  timetravel: [],
  persist: [],
  snapshot: [],
  // Data
  data: [],
  backup: [],
  restore: [],
  migrations: [],
  report: [],
  // Inspect
  clients: [],
  client: [],
  surface: ["--full", "--component", "--path", "--depth", "--names", "--rects"],
  trigger: [],
  where: [],
  // `--pose` is NOT here: cmdShot refuses it by name with a better message,
  // and this list is what "shot takes:" prints. See RECOGNISED_NOT_OFFERED.
  shot: [
    "--full",
    "--out",
    // The visual-regression half of `shot`, advertised in `am help` and fully
    // implemented in `am-cmd-shot.ts` — and unreachable from the CLI, because
    // the gate refused all five before the command ran. `--update`/`--check`
    // ARE the feature; without them `shot` is a screenshot button.
    "--selector",
    "--update",
    "--check",
    "--threshold",
    "--max-diff",
    // `--video[=file.mp4|.webm]` records the window until Ctrl-C;
    // `--duration=<s>` stops it by itself.
    "--video",
    "--duration",
  ],
  eval: ["--window"],
  sql: [],
  tables: [],
  schedules: [],
  // `--level` was listed here and REFUSED by the command for a while: the
  // central gate permitted a flag the verb did not take, and the two tests
  // around this table pin "every gated verb refuses --zzz" and "every verb
  // appears in the table" — neither half can see an entry the command
  // rejects. That is resolved in the other direction as of 1.0.0-beta: the three
  // structured filters are REAL now (`logFlagError` accepts them), so the
  // table lists them and the two sides agree again.
  logs: ["--level", "--tag", "--since"],
  errors: [],
  metrics: [],
  cost: ["--keys", "--cell", "--window"],
  top: [],
  health: [],
  doctor: [],
  discover: [],
  profile: ["--out"],
  pair: [],
  config: [],
  // What the process HOLDS, as opposed to what it serves.
  heap: [],
  // Does the client graph BUILD? `deno check` cannot answer this.
  check: [],
  migrate: ["--from"],
  testgen: ["--out", "--entry"],
  preview: ["--export", "--props"],
  // Where findings about aio go — outside the version store.
  feedback: ["--create"],
  // Meta
  add: [],
  pin: ["--latest", "--major", "--aio"],
  theme: [],
  link: ["--aio"],
  uninstall: [],
  remove: ["--no-run"],
  installed: [],
  version: [],
  trust: [],
  help: [],
  // `--task=<slug>` one section, `--list` the section index. Gated (not
  // passthrough) so a mistyped slug is refused with the real list rather
  // than silently printing the whole brief.
  agent: ["--task", "--list", "--min", "--medium", "--max"],
};

/** The flag name in `--name=value` / `--name`. Non-flags return null, and so
 *  does a bare `--` (the end-of-options marker) and a negative number. */
export function flagName(arg: string): string | null {
  if (!/^--[a-zA-Z]/.test(arg)) return null;
  const eq = arg.indexOf("=");
  return eq === -1 ? arg : arg.slice(0, eq);
}

/** Every `--flag` in `argv` this verb does not accept, in order. Empty for a
 *  passthrough verb, and for anything after a bare `--`. Pure. */
/** Flags a verb RECOGNISES only in order to refuse them WELL — let through the
 *  central gate so the command's own message is the one the user reads, but
 *  never advertised in "…takes:".
 *
 *  `--pose` was in `VERB_FLAGS.shot` for the first half of that (cmdShot
 *  answers "the app decides its own camera. Expose a cell method … then
 *  `am shot`"), and paid the second: `am shot --zzz` replied "shot takes:
 *  --full --out --pose", offering a flag that fails when used. The table's own
 *  note records the mirror-image mistake for `--level` — listed there and
 *  refused by the command — and says the two tests around this table cannot
 *  see either half. This map is the missing third state: recognised, refused,
 *  not offered. */
export const RECOGNISED_NOT_OFFERED: Record<string, readonly string[]> = {
  shot: ["--pose"],
};

export function unknownFlags(
  command: string,
  argv: readonly string[],
): string[] {
  if (command in PASSTHROUGH) return [];
  const known = VERB_FLAGS[command];
  if (!known) return []; // an unknown VERB is a different refusal, already made
  const bad: string[] = [];
  for (const a of argv) {
    if (a === "--") break;
    const name = flagName(a);
    if (name === null) continue;
    if (GLOBAL_FLAGS.includes(name) || known.includes(name)) continue;
    // Recognised so the COMMAND can refuse it with the better sentence; the
    // "…takes:" line never names these, so nothing is offered that fails.
    if ((RECOGNISED_NOT_OFFERED[command] ?? []).includes(name)) continue;
    bad.push(name);
  }
  return bad;
}

/** Global flags only SOME verbs read — flag → the gated verbs that act on it.
 *
 *  `parseGlobalFlags` consumes every flag in {@linkcode GLOBAL_FLAGS} after
 *  any verb, so the unknown-flag gate passes them all — and a verb that never
 *  reads one did the default thing without a word: `am actions --lines=1`
 *  printed the whole history, `am timeline --filter=zzzz` filtered nothing,
 *  `am timeline --follow` returned at once, `am status --all` answered for
 *  one app, `am sql --lines=1` ran unlimited. Each looks like a working flag
 *  and is not.
 *
 *  The flags listed here are the ones whose meaning belongs to particular
 *  verbs. Not listed (and so still accepted everywhere) are the flags that
 *  really are cross-cutting (`--app --port --home --json --quiet --help
 *  --wait --timeout --client-index --entry --force`) and the two that
 *  steer a LAUNCH (`--no-wait --transport`), which a stop-then-start script
 *  passes to its whole sequence. PASSTHROUGH verbs are never judged. */
export const SCOPED_GLOBAL_FLAGS: Readonly<Record<string, readonly string[]>> =
  {
    "--all": ["stop", "help"],
    "--filter": ["logs"],
    "--follow": ["logs"],
    "--lines": ["logs", "errors", "timeline", "actions"],
    "--stale": ["kill"],
    "--tables": ["sql"],
    "--print": ["open"],
    "--long": ["instances"],
    "--ui": ["state"],
    "--as-server": ["dispatch"],
    "--body": ["dispatch"],
    "--args": ["dispatch"],
    "--data": ["remove"],
  };

/** The warning for a global flag this verb does not read, or null. Pure — the
 *  caller prints it to stderr and runs the verb anyway (the flag was always
 *  accepted, so refusing it now would break a working script).
 *
 *  `argv` is the RAW command line (`Deno.args`), not the leftover arguments
 *  `unknownFlagError` reads: `parseGlobalFlags` has already consumed every
 *  global flag out of those, which is exactly why this was invisible. */
export function misplacedFlagError(
  command: string,
  argv: readonly string[],
): string | null {
  if (command in PASSTHROUGH || !(command in VERB_FLAGS)) return null;
  const short: Record<string, string> = { "-f": "--follow", "-l": "--long" };
  const bad: string[] = [];
  for (const a of argv) {
    if (a === "--") break;
    const name = short[a] ?? flagName(a);
    if (name === null) continue;
    const readers = SCOPED_GLOBAL_FLAGS[name];
    if (readers && !readers.includes(command) && !bad.includes(name)) {
      bad.push(name);
    }
  }
  if (bad.length === 0) return null;
  return `am ${command}: ${bad.join(", ")} ${
    bad.length === 1 ? "does" : "do"
  } nothing for ${command} — ignored\n` +
    bad.map((b) =>
      `  ${b} is read by: ${
        SCOPED_GLOBAL_FLAGS[b]!.map((v) => `am ${v}`).join(", ")
      }`
    ).join("\n") +
    `\n  am help ${command}`;
}

/** Levenshtein distance, capped — for the did-you-mean only. */
function distance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]!;
      prev[j] = Math.min(
        prev[j]! + 1,
        prev[j - 1]! + 1,
        diag + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diag = tmp;
    }
  }
  return prev[b.length]!;
}

/** The closest accepted flag to `bad`, when one is close enough to suggest. */
export function didYouMean(
  bad: string,
  command: string,
): string | null {
  const pool = [...GLOBAL_FLAGS, ...(VERB_FLAGS[command] ?? [])];
  let best: string | null = null;
  let bestD = Infinity;
  for (const f of pool) {
    const d = distance(bad, f);
    if (d < bestD) {
      bestD = d;
      best = f;
    }
  }
  // Three edits on a short word is not a suggestion, it is a different flag.
  return best !== null && bestD <= Math.max(2, Math.floor(bad.length / 3))
    ? best
    : null;
}

/** The refusal for a verb's unknown flags, or null when there are none. Pure —
 *  the caller prints it through `outError` and exits 1, like every other
 *  refusal. */
export function unknownFlagError(
  command: string,
  argv: readonly string[],
): string | null {
  const bad = unknownFlags(command, argv);
  if (bad.length === 0) return null;
  const suggestions = bad
    .map((b) => {
      const near = didYouMean(b, command);
      return near ? `${b} (did you mean ${near}?)` : b;
    })
    .join(", ");
  const own = VERB_FLAGS[command] ?? [];
  return `am ${command}: unknown flag ${suggestions}\n` +
    (own.length
      ? `  ${command} takes: ${own.join(" ")}\n`
      : `  ${command} takes no flags of its own\n`) +
    `  every command also takes --app=X --port=N --home=<dir> --json ` +
    `--quiet --wait[=N] (am help lists the rest)\n` +
    `  am help ${command}`;
}
