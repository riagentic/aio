// args.ts — typed flags, positionals and commands from ONE spec, with `--help`
// generated from that spec so the help can never describe a flag the parser
// does not accept.
//
// Unknown flags are REFUSED, not ignored — the rule `aio` itself follows
// (src/server/aio-cli.ts): `--experse` warned and booted, and the app sat on
// 127.0.0.1 while its author believed it was on the LAN. A typo is loud, with
// a did-you-mean, and exits `EXIT.usage`.

import { AIO_RUNTIME_FLAGS } from "../diagnostics/runtime-flags.ts";
import { nearestOf } from "../state/cell-helpers.ts";
import { type CliIO, defaultIO } from "./io.ts";
import { EXIT, fail } from "./exit.ts";

/** One flag. `type` decides parsing; `default` decides the result type. */
export type FlagSpec = {
  type: "string" | "number" | "boolean" | "string[]";
  /** One line for `--help`. */
  help?: string;
  /** Single-letter alias: `short: "n"` accepts `-n`. */
  short?: string;
  /** Value when absent. Booleans default to `false`, lists to `[]`. */
  default?: string | number | boolean | string[];
  /** Refuse the invocation when absent (string/number only). */
  required?: boolean;
};

/** The spec `args()` parses against and prints as `--help`. */
export type ArgsSpec = {
  /** Program name, as typed by the user — first word of every usage line. */
  name: string;
  /** One-line description, the first line of `--help`. */
  help?: string;
  /** Printed by `--version` (omit and there is no `--version`). */
  version?: string;
  /** Sub-commands: name → one-line help. When set, the first positional must
   *  be one of them. */
  commands?: Record<string, string>;
  /** Named positionals, in order: `["id"]` → `a.pos.id`. */
  positional?: readonly string[];
  /** Name of the variadic tail (`add <text...>`): everything after the named
   *  positionals lands in `a.rest`. */
  rest?: string;
  /** Flags by long name (`url` → `--url`). A boolean `json` flag is special:
   *  when set, refusals are emitted as `{"error"}` JSON on stdout. */
  flags?: Record<string, FlagSpec>;
};

type FlagValue<F extends FlagSpec> = F["type"] extends "boolean" ? boolean
  : F["type"] extends "string[]" ? string[]
  : F["type"] extends "number"
    ? (F extends { default: number } | { required: true } ? number
      : number | undefined)
  : F extends { default: string } | { required: true } ? string
  : string | undefined;

/** What `args()` returns — typed from the spec. */
export type Parsed<S extends ArgsSpec> = {
  /** The sub-command (only when `commands` was declared). */
  command: S["commands"] extends Record<string, string>
    ? keyof S["commands"] & string
    : undefined;
  /** Flags, typed by their spec. */
  flags: { [K in keyof S["flags"]]: FlagValue<NonNullable<S["flags"]>[K]> };
  /** Named positionals; a missing optional one is `undefined`. */
  pos: {
    [K in NonNullable<S["positional"]>[number]]: string | undefined;
  };
  /** The variadic tail (empty unless `rest` was declared). */
  rest: string[];
  /** `--json` was given (a declared boolean `json` flag). */
  json: boolean;
  /** The generated `--help` text. */
  help: string;
};

/** Options for {@link args}. */
export type ArgsOptions = {
  /** The argv to parse — default `Deno.args`. */
  argv?: readonly string[];
  /** Injected streams (tests). */
  io?: CliIO;
};

/** Parse `argv` against `spec`: typed result, or a refusal that exits
 *  `EXIT.usage`; `--help` / `--version` print and exit 0. */
export function args<const S extends ArgsSpec>(
  spec: S,
  opts: ArgsOptions = {},
): Parsed<S> {
  const argv = opts.argv ?? Deno.args;
  const io = opts.io ?? defaultIO();
  const flagSpecs = spec.flags ?? {};
  const help = helpText(spec);
  const hasJson = flagSpecs.json?.type === "boolean";
  const json = hasJson && argv.includes("--json") &&
    !argv.slice(0, argv.indexOf("--json")).includes("--");
  const refuse = (msg: string): never =>
    fail(`${msg} — run \`${spec.name} --help\``, {
      code: EXIT.usage,
      json,
      io,
    });

  const flags: Record<string, unknown> = {};
  for (const [k, f] of Object.entries(flagSpecs)) {
    flags[k] = f.default ??
      (f.type === "boolean" ? false : f.type === "string[]" ? [] : undefined);
  }
  const shorts = new Map<string, string>();
  for (const [k, f] of Object.entries(flagSpecs)) {
    if (f.short) shorts.set(f.short, k);
  }
  const positionals: string[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (a === "--help" || a === "-h") {
      io.out(help + "\n");
      return io.exit(EXIT.ok);
    }
    if (a === "--version" && spec.version) {
      io.out(`${spec.name} ${spec.version}\n`);
      return io.exit(EXIT.ok);
    }
    if (!a.startsWith("-") || a === "-") {
      positionals.push(a);
      continue;
    }
    // --name, --name=value, -s, -s value
    const long = a.startsWith("--");
    const eq = long ? a.indexOf("=") : -1;
    const rawName = long ? a.slice(2, eq === -1 ? undefined : eq) : a.slice(1);
    const name = long ? rawName : shorts.get(rawName);
    const f = name ? flagSpecs[name] : undefined;
    // The aio process parses its own flags (`--port`, `--client`, …) out of
    // the same argv; they are not this tool's to refuse.
    if (!f && long && AIO_RUNTIME_FLAGS.has(`--${rawName}`)) continue;
    if (!name || !f) {
      const near = long
        ? nearestOf(rawName, Object.keys(flagSpecs))
        : undefined;
      return refuse(
        `unknown flag: ${a.split("=")[0]}` +
          (near ? ` (did you mean --${near}?)` : ""),
      );
    }
    seen.add(name);
    if (f.type === "boolean") {
      if (eq !== -1) return refuse(`--${name} takes no value`);
      flags[name] = true;
      continue;
    }
    const value = eq !== -1 ? a.slice(eq + 1) : argv[++i];
    if (value === undefined) return refuse(`--${name} needs a value`);
    if (f.type === "number") {
      const n = Number(value);
      if (value.trim() === "" || !Number.isFinite(n)) {
        return refuse(`--${name} expects a number, got "${value}"`);
      }
      flags[name] = n;
    } else if (f.type === "string[]") {
      (flags[name] as string[]).push(value);
    } else flags[name] = value;
  }

  for (const [k, f] of Object.entries(flagSpecs)) {
    if (f.required && !seen.has(k) && flags[k] === undefined) {
      return refuse(`--${k} is required`);
    }
  }

  let command: string | undefined;
  if (spec.commands) {
    command = positionals.shift();
    if (command === undefined) return refuse("missing command");
    if (!(command in spec.commands)) {
      const near = nearestOf(command, Object.keys(spec.commands));
      return refuse(
        `unknown command: ${command}` +
          (near ? ` (did you mean ${near}?)` : ""),
      );
    }
  }

  const names = spec.positional ?? [];
  const pos: Record<string, string | undefined> = {};
  names.forEach((n, i) => pos[n] = positionals[i]);
  const rest = positionals.slice(names.length);
  if (rest.length && !spec.rest) {
    return refuse(`unexpected argument: ${rest[0]}`);
  }

  return {
    command,
    flags,
    pos,
    rest,
    json,
    help,
  } as Parsed<S>;
}

/** The `--help` text for `spec` — pure, so a test can pin it. */
export function helpText(spec: ArgsSpec): string {
  const lines: string[] = [];
  if (spec.help) lines.push(spec.help, "");
  const usage = [
    spec.name,
    spec.commands ? "<command>" : "",
    ...(spec.positional ?? []).map((p) => `<${p}>`),
    spec.rest ? `[${spec.rest}...]` : "",
    "[flags]",
  ].filter(Boolean).join(" ");
  lines.push(`usage: ${usage}`);
  const col = (rows: [string, string][]) => {
    const w = Math.max(0, ...rows.map(([l]) => l.length));
    return rows.map(([l, r]) => `  ${l.padEnd(w)}  ${r}`.trimEnd());
  };
  if (spec.commands) {
    lines.push("", "commands:", ...col(Object.entries(spec.commands)));
  }
  const flagRows: [string, string][] = Object.entries(spec.flags ?? {}).map(
    ([k, f]) => {
      const left = (f.short ? `-${f.short}, ` : "    ") + `--${k}` +
        (f.type === "boolean" ? "" : `=<${f.type}>`);
      const tail = f.required
        ? " (required)"
        : f.default !== undefined && f.type !== "boolean"
        ? ` (default: ${JSON.stringify(f.default)})`
        : "";
      return [left, (f.help ?? "") + tail];
    },
  );
  flagRows.push(["    --help", "show this help"]);
  if (spec.version) flagRows.push(["    --version", "print the version"]);
  lines.push("", "flags:", ...col(flagRows));
  return lines.join("\n");
}
