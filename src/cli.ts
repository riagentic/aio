/**
 * @module
 * `aio/cli` — the compact toolkit for rich command-line apps: typed `args()`
 * with generated `--help`, prompts that refuse (never hang) without a
 * terminal, `table`/`progress`/`spinner`/`style` that degrade to plain lines
 * when stdout is not a terminal or `NO_COLOR` is set, `watch()` for a live
 * view of server state from a `cli-client`, and `fail()`/`EXIT`.
 *
 * Every function takes an injectable `io` (see `testIO()`), so a CLI built on
 * it is tested with strings, not a TTY. Works in a compiled `cli` binary and a
 * `cli-client`. Guide: docs/clients/cli-toolkit.md.
 *
 * ```ts
 * import { args, fail, table } from "aio/cli";
 * const a = args({ name: "todo", commands: { list: "show todos" } });
 * ```
 */
export {
  args,
  type ArgsOptions,
  type ArgsSpec,
  type FlagSpec,
  helpText,
  type Parsed,
} from "./cli/args.ts";
export { EXIT, fail, type FailOptions } from "./cli/exit.ts";
export {
  CliExit,
  type CliIO,
  defaultIO,
  readLine,
  type TestIO,
  testIO,
} from "./cli/io.ts";
export {
  confirm,
  InputClosedError,
  NoTerminalError,
  password,
  prompt,
  type PromptOptions,
  select,
} from "./cli/prompt.ts";
export {
  type Column,
  plainWidth,
  type Progress,
  progress,
  type ProgressOptions,
  type Spinner,
  spinner,
  type SpinnerOptions,
  type Style,
  style,
  styleWith,
  table,
  type TableOptions,
} from "./cli/output.ts";
export {
  type Watch,
  watch,
  type Watchable,
  type WatchOptions,
} from "./cli/watch.ts";
