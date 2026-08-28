// aio/cli — the CLI toolkit, driven through injected streams (`testIO`), so
// none of this needs a terminal and all of it runs in CI. Every behaviour a
// doc line claims is pinned here: refusals exit `usage`, prompts never hang,
// output degrades to plain lines, colour follows ONE decider.
import {
  assert,
  assertEquals,
  assertMatch,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  args,
  CliExit,
  confirm,
  EXIT,
  fail,
  helpText,
  InputClosedError,
  NoTerminalError,
  password,
  plainWidth,
  progress,
  prompt,
  readLine,
  select,
  spinner,
  styleWith,
  table,
  testIO,
  watch,
} from "../src/cli.ts";
import { signal } from "../src/state/signal.ts";
import { colorEnabled } from "../src/diagnostics/color.ts";
import { defaultIO } from "../src/cli/io.ts";

const SPEC = {
  name: "todo",
  help: "A todo list.",
  version: "1.2.3",
  commands: { list: "show", add: "add one" },
  positional: ["id"],
  rest: "text",
  flags: {
    url: { type: "string", default: "ws://x/ws", help: "server" },
    n: { type: "number", short: "n", help: "count" },
    json: { type: "boolean", help: "json out" },
    tag: { type: "string[]", help: "tags" },
  },
} as const;

/** Run `fn` and return the exit it ended with (a `CliExit` from testIO). */
function exitOf(fn: () => unknown): number {
  try {
    fn();
  } catch (e) {
    if (e instanceof CliExit) return e.code;
    throw e;
  }
  throw new Error("did not exit");
}

// ── args ─────────────────────────────────────────────────────────────────────

Deno.test("cli args: typed flags, command, positional, rest, --flag=v and -s v", () => {
  const io = testIO();
  const a = args(SPEC, {
    argv: [
      "add",
      "7",
      "--url=ws://y",
      "-n",
      "3",
      "--tag",
      "a",
      "--tag=b",
      "x",
      "y",
    ],
    io,
  });
  assertEquals(a.command, "add");
  assertEquals(a.pos.id, "7");
  assertEquals(a.rest, ["x", "y"]);
  assertEquals(a.flags.url, "ws://y");
  assertEquals(a.flags.n, 3);
  assertEquals(a.flags.json, false);
  assertEquals(a.flags.tag, ["a", "b"]);
  assertEquals(a.json, false);
  // types: the spec's defaults decide the result type
  const _url: string = a.flags.url;
  const _n: number | undefined = a.flags.n;
  const _cmd: "list" | "add" = a.command;
  void [_url, _n, _cmd];
  assertEquals(io.stdout, "");
});

Deno.test("cli args: defaults apply, -- stops flag parsing", () => {
  const a = args(SPEC, { argv: ["list", "--", "--not-a-flag"], io: testIO() });
  assertEquals(a.flags.url, "ws://x/ws");
  assertEquals(a.flags.n, undefined);
  assertEquals(a.pos.id, "--not-a-flag");
});

Deno.test("cli args: an unknown flag is REFUSED with did-you-mean, exit usage", () => {
  const io = testIO();
  const code = exitOf(() => args(SPEC, { argv: ["list", "--urk=1"], io }));
  assertEquals(code, EXIT.usage);
  assertStringIncludes(io.stderr, "error: unknown flag: --urk");
  assertStringIncludes(io.stderr, "did you mean --url?");
  assertStringIncludes(io.stderr, "todo --help");
  assertEquals(io.stdout, "");
});

Deno.test("cli args: unknown short flag, unknown command, stray argument, bad number, missing value", () => {
  const cases: [string[], string][] = [
    [["list", "-z"], "unknown flag: -z"],
    [["lsit"], "unknown command: lsit (did you mean list?)"],
    [[], "missing command"],
    [["list", "-n", "abc"], "--n expects a number"],
    [["list", "--url"], "--url needs a value"],
    [["list", "--json=1"], "--json takes no value"],
  ];
  for (const [argv, msg] of cases) {
    const io = testIO();
    assertEquals(
      exitOf(() => args(SPEC, { argv, io })),
      EXIT.usage,
      argv.join(" "),
    );
    assertStringIncludes(io.stderr, msg);
  }
  // no `rest` declared → an extra positional is a refusal, not a silent drop
  const io = testIO();
  exitOf(() =>
    args({ name: "t", positional: ["a"] }, { argv: ["1", "2"], io })
  );
  assertStringIncludes(io.stderr, "unexpected argument: 2");
});

Deno.test("cli args: required flag", () => {
  const io = testIO();
  const spec = {
    name: "t",
    flags: { key: { type: "string", required: true } },
  } as const;
  assertEquals(exitOf(() => args(spec, { argv: [], io })), EXIT.usage);
  assertStringIncludes(io.stderr, "--key is required");
  const a = args(spec, { argv: ["--key", "k"], io: testIO() });
  const _k: string = a.flags.key;
  assertEquals(_k, "k");
});

Deno.test("cli args: --json turns a refusal into {error} on STDOUT (a script's stream)", () => {
  const io = testIO();
  exitOf(() => args(SPEC, { argv: ["list", "--json", "--bogus"], io }));
  assertEquals(
    JSON.parse(io.stdout.trim()).error.startsWith("unknown flag: --bogus"),
    true,
  );
  assertEquals(io.stderr, "");
  // without a declared json flag, --json is just unknown
  const io2 = testIO();
  exitOf(() => args({ name: "t" }, { argv: ["--json"], io: io2 }));
  assertStringIncludes(io2.stderr, "unknown flag: --json");
});

Deno.test("cli args: --help is generated from the spec, exit 0; --version", () => {
  const io = testIO();
  assertEquals(exitOf(() => args(SPEC, { argv: ["--help"], io })), EXIT.ok);
  const h = io.stdout;
  assertStringIncludes(h, "A todo list.");
  assertStringIncludes(h, "usage: todo <command> <id> [text...] [flags]");
  assertMatch(h, /commands:\n  list  show\n  add   add one/);
  assertMatch(h, /-n, --n=<number>\s+count/);
  assertMatch(h, /--url=<string>\s+server \(default: "ws:\/\/x\/ws"\)/);
  assertMatch(h, /--json\s+json out/);
  assertStringIncludes(h, "--version");
  assertEquals(helpText(SPEC) + "\n", h);
  // every declared flag appears in the help — help can never lag the parser
  for (const k of Object.keys(SPEC.flags)) assertStringIncludes(h, `--${k}`);
  const io2 = testIO();
  assertEquals(
    exitOf(() => args(SPEC, { argv: ["--version"], io: io2 })),
    EXIT.ok,
  );
  assertEquals(io2.stdout, "todo 1.2.3\n");
  // the parsed result carries the same help text
  const a = args(SPEC, { argv: ["list"], io: testIO() });
  assertEquals(a.help, helpText(SPEC));
});

// ── fail / EXIT ──────────────────────────────────────────────────────────────

Deno.test("cli fail: stderr `error: …` + exit 1 in one act; --json → stdout object; code override", () => {
  const io = testIO();
  assertEquals(exitOf(() => fail("boom", { io })), EXIT.error);
  assertEquals(io.stderr, "error: boom\n");
  assertEquals(io.stdout, "");
  const io2 = testIO();
  assertEquals(
    exitOf(() => fail("boom", { io: io2, json: true, code: EXIT.usage })),
    2,
  );
  assertEquals(JSON.parse(io2.stdout), { error: "boom" });
  assertEquals(io2.stderr, "");
  assertEquals(EXIT, { ok: 0, error: 1, usage: 2 });
});

// ── prompts ──────────────────────────────────────────────────────────────────

Deno.test("cli prompt/confirm/select/password: read injected stdin, chunk boundaries invisible", async () => {
  const io = testIO({ input: ["al", "ice\ny", "es\n3\nse", "cr\x7fet\n"] });
  assertEquals(await prompt("name", { io }), "alice");
  assertEquals(await confirm("ok?", { io }), true);
  assertEquals(await select("pick", ["a", "b", "c"], { io }), "c");
  assertEquals(await password("pw", { io }), "secet"); // \x7f = backspace
  assertStringIncludes(io.stdout, "name: ");
  assertStringIncludes(io.stdout, "ok? [y/N]: ");
  assertStringIncludes(io.stdout, "  3) c\n");
  assertStringIncludes(io.stdout, "choose 1-3: ");
  assertEquals(
    io.stdout.includes("secret"),
    false,
    "a password is never echoed",
  );
  assertEquals(io.raw, [true, false], "raw mode on for the secret, off after");
});

Deno.test("cli prompt: defaults and re-asking", async () => {
  const io = testIO({ input: "\n\n\nn\n\nb\n" });
  assertEquals(await prompt("q", { io, default: "d" }), "d");
  assertEquals(await confirm("c", { io, default: true }), true);
  assertEquals(await confirm("c", { io }), false); // "" → false
  assertEquals(await confirm("c", { io }), false); // "n"
  assertEquals(await select("s", ["a", "b"], { io, default: "b" }), "b"); // ""
  assertEquals(await select("s", ["a", "b"], { io }), "b"); // by name
});

Deno.test("cli prompt: NOT a terminal → refuses loudly, reads nothing, never hangs", async () => {
  const io = testIO({ tty: false, input: "would-be-answer\n" });
  for (
    const [what, run] of [
      ["prompt", () => prompt("q", { io })],
      ["confirm", () => confirm("q", { io })],
      ["select", () => select("q", ["a"], { io })],
      ["password", () => password("q", { io })],
    ] as const
  ) {
    const e = await assertRejects(run, NoTerminalError);
    assertStringIncludes(e.message, `${what}("q") needs a terminal`);
    assertStringIncludes(e.message, "pass the value as a flag");
    assertEquals(e.code, EXIT.usage);
  }
  assertEquals(io.stdout, "", "a refusal asks nothing");
  assertEquals(await readLine(io), "would-be-answer", "stdin untouched");
});

Deno.test("cli prompt: stdin closing mid-question is an error, not an empty answer", async () => {
  const io = testIO({ input: "" });
  await assertRejects(
    () => prompt("q", { io }),
    InputClosedError,
    'no answer to "q"',
  );
  await assertRejects(() => password("q", { io }), InputClosedError);
  assertEquals(io.raw, [true, false]);
  await assertRejects(() => select("q", [], { io }), Error, "no choices");
});

// ── output ───────────────────────────────────────────────────────────────────

Deno.test("cli table: aligned columns, right-align, header bold only with colour", () => {
  const rows = [{ id: 1, text: "a" }, { id: 10, text: "longer" }];
  const plain = table(rows, {
    columns: [{ key: "id", align: "right" }, { key: "text", header: "what" }],
    color: false,
  });
  assertEquals(plain, "id  what\n 1  a\n10  longer");
  const colored = table(rows, { color: true });
  assertEquals(colored.split("\n")[0], "\x1b[1mid  text\x1b[0m");
  assertEquals(plainWidth(colored.split("\n")[0]!), "id  text".length);
  assertEquals(table([]), "");
  assertEquals(table([], { columns: ["a"], color: false }), "a");
  assertEquals(
    table([{ v: null, w: undefined, x: true }], { color: false }),
    "v  w  x\n      true",
  );
});

Deno.test("cli progress: TTY redraws one line; non-TTY prints plain lines at 10% steps + end", () => {
  const tty = testIO({ tty: true });
  const p = progress(4, { io: tty, label: "copy", width: 4 });
  p.tick();
  p.tick(2);
  p.done();
  p.done(); // idempotent
  const frames = tty.stdout.split("\r\x1b[2K").filter(Boolean);
  assertEquals(frames, [
    "copy [----] 0/4 0%",
    "copy [#---] 1/4 25%",
    "copy [###-] 3/4 75%",
    "copy [####] 4/4 100%\n",
  ]);
  const pipe = testIO({ tty: false });
  const q = progress(100, { io: pipe, label: "copy" });
  for (let i = 0; i < 100; i++) q.tick();
  q.done();
  const lines = pipe.stdout.trimEnd().split("\n");
  assertEquals(lines.length, 11, "0%..100% at every decile, nothing per tick");
  assertEquals(lines[0], "copy 0/100 (0%)");
  assertEquals(lines.at(-1), "copy 100/100 (100%)");
  assertEquals(pipe.stdout.includes("\x1b"), false, "no escapes in a pipe");
  assertEquals(pipe.stdout.includes("\r"), false);
});

Deno.test("cli spinner: non-TTY is two plain lines; TTY animates and clears; timer never holds the process", async () => {
  const pipe = testIO({ tty: false });
  const s = spinner("loading", { io: pipe });
  s.update("still loading");
  s.stop("loaded");
  s.stop(); // idempotent
  assertEquals(pipe.stdout, "loading...\nstill loading...\nloaded\n");
  const tty = testIO({ tty: true });
  const t = spinner("x", { io: tty, intervalMs: 5 });
  await new Promise((r) => setTimeout(r, 30));
  t.stop("done");
  assert(tty.stdout.split("\r\x1b[2K").length > 3, "animated");
  assert(tty.stdout.endsWith("\r\x1b[2Kdone\n"));
  // (the interval is unref'd + cleared: this test process exits — the leak
  // sanitizer would fail it otherwise)
});

Deno.test("cli style: one decider — styleWith(false) is identity, styleWith(true) wraps; `style` follows colorEnabled", async () => {
  const off = styleWith(false), on = styleWith(true);
  for (
    const k of ["bold", "dim", "red", "green", "cyan", "underline"] as const
  ) {
    assertEquals(off[k]("s"), "s");
    assertMatch(on[k]("s"), /^\x1b\[\d+ms\x1b\[0m$/);
  }
  assertEquals(on.bold("s"), "\x1b[1ms\x1b[0m");
  assertEquals(on.red("s"), "\x1b[31ms\x1b[0m");
  assertEquals(
    defaultIO().color,
    colorEnabled,
    "the toolkit's colour IS the framework decider",
  );
  const { style } = await import("../src/cli.ts");
  assertEquals(style.bold("s"), colorEnabled ? on.bold("s") : "s");
});

Deno.test("cli style: NO_COLOR reaches the toolkit through the framework decider (child process)", async () => {
  const run = async (env: Record<string, string>) => {
    const p = await new Deno.Command(Deno.execPath(), {
      args: [
        "eval",
        `import { style, table } from "${new URL(
          "../src/cli.ts",
          import.meta.url,
        )}"; console.log(style.red("R") + table([{a:1}]))`,
      ],
      env: { ...env },
      clearEnv: false,
      stdout: "piped",
      stderr: "piped",
    }).output();
    return new TextDecoder().decode(p.stdout);
  };
  // stdout is a pipe here, so plain even without NO_COLOR; FORCE_COLOR turns it on
  assertEquals(await run({ NO_COLOR: "1" }), "Ra\n1\n");
  assertEquals(
    await run({ FORCE_COLOR: "1", NO_COLOR: "" }),
    "\x1b[31mR\x1b[0m\x1b[1ma\x1b[0m\n1\n",
  );
});

// ── watch ────────────────────────────────────────────────────────────────────

Deno.test("cli watch: draws now, redraws on change (coalesced), stop unsubscribes — TTY clears, pipe appends", async () => {
  const count = signal(0);
  const tty = testIO({ tty: true });
  const w = watch(count, () => `n=${count.value}`, { io: tty });
  assertEquals(tty.stdout, "\x1b[?25l\x1b[2J\x1b[Hn=0\n");
  count.set(1);
  count.set(2);
  await Promise.resolve();
  await Promise.resolve();
  assertEquals(
    tty.stdout,
    "\x1b[?25l\x1b[2J\x1b[Hn=0\n\x1b[2J\x1b[Hn=2\n",
    "two sets, one frame",
  );
  w.stop();
  count.set(3);
  await Promise.resolve();
  assertEquals(tty.stdout.endsWith("\x1b[?25h"), true, "cursor restored");
  assertEquals(tty.stdout.includes("n=3"), false, "stopped means stopped");
  assertEquals(count._subscribers.size, 0, "unsubscribed");

  // a connectCli-shaped source: subscribe(fn) → unsubscribe
  const subs = new Set<() => void>();
  const app = {
    subscribe: (fn: () => void) => (subs.add(fn), () => subs.delete(fn)),
  };
  const pipe = testIO({ tty: false });
  let v = "a";
  const w2 = watch(app, () => v, { io: pipe });
  v = "b";
  for (const fn of subs) fn();
  await Promise.resolve();
  w2.refresh();
  assertEquals(pipe.stdout, "a\nb\nb\n");
  assertEquals(pipe.stdout.includes("\x1b"), false);
  w2.stop();
  assertEquals(subs.size, 0);
});

// ── testIO itself ────────────────────────────────────────────────────────────

Deno.test("cli testIO: exit throws CliExit; exhausted input is EOF, never a hang", async () => {
  const io = testIO();
  assertThrows(() => io.exit(3), CliExit, "exit 3");
  assertEquals(await readLine(io), null);
  const two = testIO({ input: "x\r\ny" });
  assertEquals(await readLine(two), "x");
  assertEquals(await readLine(two), "y");
  assertEquals(await readLine(two), null);
});
