# CLI toolkit (`aio/cli`)

A compact toolkit for command-line apps — typed flags with generated `--help`,
prompts that refuse instead of hanging, tables, progress, spinners, colour, a
live view of server state, and exit codes — so a `cli` binary or a `cli-client`
reads like the rest of an aio app instead of hand-written ANSI.

```ts
import { args, fail, style, table, watch } from "aio/cli";
```

Zero dependencies beyond `@std`. Every function takes an injectable `io`
(`testIO()`), so a CLI built on it is tested with strings, never a terminal.
Colour follows the framework's ONE decider (`NO_COLOR`, `FORCE_COLOR`, is stdout
a terminal — `src/diagnostics/color.ts`), and every renderer degrades to plain
lines on a pipe. Nothing ever waits for a human who is not there.

The complete example is [`examples/cli-tool/`](../../examples/cli-tool/) — a
todo list where one binary is both the server (`todo serve`) and the commands
that talk to it (`todo add`, `todo list --watch`, `todo list --json`).

## `args(spec)` — flags, positionals, commands, `--help`

```ts
const a = args({
  name: "todo",
  help: "A todo list you can script.",
  version: "0.1.0",
  commands: { list: "show the list", add: "add a todo: todo add <text...>" },
  positional: ["id"], // → a.pos.id
  rest: "text", //       → a.rest: everything after the named positionals
  flags: {
    url: { type: "string", default: "ws://localhost:8000/ws", help: "server" },
    watch: { type: "boolean", short: "w", help: "redraw on change" },
    json: { type: "boolean", help: "machine-readable output" },
    n: { type: "number", required: true },
    tag: { type: "string[]" }, // repeatable: --tag a --tag b
  },
});
a.command; //   "list" | "add"
a.flags.url; // string       (has a default)
a.flags.n; //   number       (required)
a.flags.tag; // string[]
a.json; //      true when --json was given
```

- Types come from the spec: a flag with a `default` or `required: true` is
  non-optional; a boolean is always `boolean` (default `false`); `string[]`
  defaults to `[]`.
- Accepted spellings: `--url=x`, `--url x`, `-n 3`, `-n3` is not. A bare `--`
  stops flag parsing.
- **Unknown flags are refused**, with a did-you-mean, exit code 2 — the same
  rule `aio` and `am` follow. So are an unknown command, a missing value, a
  non-number for a `number`, a missing `required` flag, and a stray positional
  when no `rest` was declared. Silently ignoring a typo is how an app runs with
  the wrong settings.
- `--help` / `-h` prints help generated from the spec and exits 0; `--version`
  prints `name version`. `helpText(spec)` returns the same text for a test to
  pin.
- When a boolean flag named `json` is declared and given, refusals go to
  **stdout** as `{"error": "…"}` — the stream a script parses — instead of
  `error: …` on stderr.
- Tests: `args(spec, { argv, io: testIO() })`.

## `prompt` · `confirm` · `select` · `password`

```ts
const name = await prompt("Project name", { default: "my-app" });
if (!(await confirm("Overwrite?"))) fail("aborted");
const target = await select("Target", ["browser", "electron", "cli"]);
const secret = await password("Token"); // raw mode: nothing echoed
```

Without a terminal (CI, a pipe, under `am`) every one of them **throws
`NoTerminalError`** immediately — naming the question and the way out ("pass the
value as a flag") — and reads nothing. A prompt that waits on a stdin nobody
will type into is a hang that cannot be diagnosed from outside; a refusal is a
one-line fix. Stdin closing mid-question is `InputClosedError`, never an empty
answer. `select` takes a number or the choice's name; Enter picks the `default`
when one was given. In tests, pass `{ io: testIO({ input: "yes\n" }) }` — chunk
boundaries are invisible.

## `table` · `progress` · `spinner` · `style`

```ts
console.log(
  table(rows, { columns: [{ key: "id", align: "right" }, "text"] }),
);
// id  text          ← header bold when colour is on, plain otherwise
//  1  buy milk

const p = progress(files.length, { label: "copy" });
for (const f of files) {
  await copy(f);
  p.tick();
}
p.done();

const s = spinner("connecting");
await app.ready;
s.stop("connected");

console.log(style.green("ok"), style.dim("(cached)"));
```

- `table(rows, { columns?, color? })` is pure — it returns the string. Columns
  default to the keys of the first row; a column can rename its header and
  right-align.
- `progress(total)` on a terminal redraws one line in place
  (`copy [####----] 4/8 50%`); on a pipe it prints a plain `copy 4/8 (50%)` line
  at every 10% and at `done()`.
- `spinner(label)` animates on a terminal; on a pipe it prints `label...` once
  and the final line at `stop(final?)`. Its timer never keeps the process alive.
- `style.bold/dim/underline/red/green/yellow/blue/magenta/cyan` wrap in ANSI
  when colour is on and return the string untouched when it is off.
  `styleWith(true|false)` binds an explicit decision; `plainWidth(s)` measures a
  styled string.

## `watch(source, render)` — a live view

```ts
const app = connectCli(url);
app.bind(todos);
await app.ready;
const w = watch(app, () => table(todos.items)); // draws now, again on every change
Deno.addSignalListener("SIGINT", () => {
  w.stop();
  Deno.exit(0);
});
```

`source` is anything with `subscribe(fn) → unsubscribe`: the handle
`connectCli()` returns, a signal, `getCellSignal(name)` from `aio/state-core`.
On a terminal each frame is a clean full redraw (screen cleared, cursor hidden,
restored on `stop()`); on a pipe frames are appended as plain lines, so
`todo list --watch | tee log` works. Changes in one tick are coalesced into one
frame. `refresh()` forces a redraw.

## `fail(msg)` · `EXIT`

```ts
import { args, EXIT, fail } from "aio/cli";
import { cell } from "aio";

const todos = cell("todos", {
  state: { items: [] as string[] },
  methods: {
    done(s, id: string) {
      s.items = s.items.filter((i) => i !== id);
    },
  },
});
const a = args({
  name: "todo",
  positional: ["id"],
  flags: { json: { type: "boolean" } },
});
const id = a.pos.id;
if (!id) fail("todo done <id>", { code: EXIT.usage });
await todos.done(id).catch((e: Error) => fail(e.message, { json: a.json }));
```

`fail` writes `error: msg` to stderr and exits — one act, so the exit code can
never drift from the message (the lesson from `am`, where a refusal followed by
`return` handed the shell a success). `{ json: true }` puts `{"error": msg}` on
stdout instead. Codes: `EXIT.ok` 0 · `EXIT.error` 1 (the command failed) ·
`EXIT.usage` 2 (the invocation was wrong: unknown flag, missing argument, no
terminal).

## Testing a CLI

```ts
import { args, CliExit, prompt, testIO } from "aio/cli";
import { assertEquals, assertStringIncludes } from "@std/assert";

const SPEC = { name: "todo", flags: { port: { type: "number" } } } as const;

Deno.test("refuses a typo", () => {
  const io = testIO();
  try {
    args(SPEC, { argv: ["--prot=1"], io });
  } catch (e) {
    if (!(e instanceof CliExit)) throw e;
    assertEquals(e.code, 2);
  }
  assertStringIncludes(io.stderr, "did you mean --port?");
});

Deno.test("answers", async () => {
  const io = testIO({ input: "alice\n" });
  assertEquals(await prompt("name", { io }), "alice");
});
```

`testIO({ input?, tty?, color? })` captures `stdout`/`stderr` as strings, throws
`CliExit(code)` instead of exiting, reads `input` as stdin (exhausted input is
EOF, never a hang), and records raw-mode toggles in `raw`.

## Shapes this fits

- **`cli` target** — one compiled binary. It can be the server
  (`aio.run({ client: "server-only" })`) behind a `serve` command AND the
  commands that talk to it, as `examples/cli-tool` does; `aio` parses its own
  flags (`--port`, `--expose`) and a bare command word passes through.
- **`cli-client` target** — a thin binary that only connects (`connectCli` +
  `bind`): `args()` for its flags, `watch()` for a dashboard, `table()` for its
  output.
- **Scripts** — `--json` on the flags you declare, refusals as JSON on stdout,
  exit 2 for usage, 1 for failure.

See [Clients](README.md) for how a CLI connects, and
[targets](../build/targets.md) for building it.
