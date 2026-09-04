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
  create: "scaffold flags (--template --target --mirror --dir …)",
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
  state: [],
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
  surface: ["--full", "--component", "--path", "--depth"],
  trigger: [],
  where: [],
  shot: ["--full", "--out", "--pose"],
  sql: [],
  tables: [],
  schedules: [],
  // `--level` was listed here and REFUSED by the command (`logFlagError`
  // rejects every stray `-…`): the central gate permitted a flag the verb
  // does not take, and the two tests around this table pin "every gated verb
  // refuses --zzz" and "every verb appears in the table" — neither half can
  // see an entry the command rejects. A level is a filter word: `am logs
  // error`.
  logs: [],
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
    bad.push(name);
  }
  return bad;
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
