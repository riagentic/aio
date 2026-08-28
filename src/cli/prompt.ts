// prompt.ts — interactive input that REFUSES without a terminal.
//
// A prompt on a non-TTY stdin is a hang in CI, a hang under `am`, a hang in a
// pipe — and a hang is the one failure nobody can diagnose from the outside.
// So every asker here checks `io.tty` first and throws a `NoTerminalError`
// naming the question and the way out (a flag). It never waits.

import { type CliIO, defaultIO, readLine, takePending } from "./io.ts";
import { EXIT } from "./exit.ts";

/** Thrown when a prompt runs without a terminal. `code` is `EXIT.usage`. */
export class NoTerminalError extends Error {
  readonly code: number = EXIT.usage;
  constructor(what: string, question: string) {
    super(
      `${what}(${
        JSON.stringify(question)
      }) needs a terminal, and stdin is not ` +
        `one — pass the value as a flag, or run from a terminal`,
    );
    this.name = "NoTerminalError";
  }
}

/** Thrown when stdin closes before an answer arrived. */
export class InputClosedError extends Error {
  readonly code: number = EXIT.usage;
  constructor(question: string) {
    super(`no answer to ${JSON.stringify(question)}: stdin closed`);
    this.name = "InputClosedError";
  }
}

/** Common prompt options. */
export type PromptOptions = {
  /** Injected streams (tests). */
  io?: CliIO;
};

function need(what: string, q: string, io: CliIO): void {
  if (!io.tty) throw new NoTerminalError(what, q);
}

/** Ask a free-text question; empty answer → `default`, or asked again. */
export async function prompt(
  question: string,
  opts: PromptOptions & { default?: string } = {},
): Promise<string> {
  const io = opts.io ?? defaultIO();
  need("prompt", question, io);
  const hint = opts.default !== undefined ? ` [${opts.default}]` : "";
  for (;;) {
    io.out(`${question}${hint}: `);
    const line = await readLine(io);
    if (line === null) throw new InputClosedError(question);
    const v = line.trim();
    if (v) return v;
    if (opts.default !== undefined) return opts.default;
  }
}

/** Ask yes/no; `default` is what Enter means (`false` unless given). */
export async function confirm(
  question: string,
  opts: PromptOptions & { default?: boolean } = {},
): Promise<boolean> {
  const io = opts.io ?? defaultIO();
  need("confirm", question, io);
  const dflt = opts.default ?? false;
  for (;;) {
    io.out(`${question} ${dflt ? "[Y/n]" : "[y/N]"}: `);
    const line = await readLine(io);
    if (line === null) throw new InputClosedError(question);
    const v = line.trim().toLowerCase();
    if (v === "") return dflt;
    if (v === "y" || v === "yes") return true;
    if (v === "n" || v === "no") return false;
    io.out("answer y or n\n");
  }
}

/** Pick one of `choices` by number (or by name); returns the chosen string. */
export async function select<const T extends string>(
  question: string,
  choices: readonly T[],
  opts: PromptOptions & { default?: T } = {},
): Promise<T> {
  if (choices.length === 0) throw new Error("select(): no choices");
  const io = opts.io ?? defaultIO();
  need("select", question, io);
  const di = opts.default !== undefined ? choices.indexOf(opts.default) : -1;
  for (;;) {
    io.out(`${question}\n`);
    choices.forEach((c, i) =>
      io.out(`  ${i + 1}) ${c}${i === di ? " (default)" : ""}\n`)
    );
    io.out(`choose 1-${choices.length}: `);
    const line = await readLine(io);
    if (line === null) throw new InputClosedError(question);
    const v = line.trim();
    if (v === "" && di !== -1) return choices[di]!;
    const n = Number(v);
    if (Number.isInteger(n) && n >= 1 && n <= choices.length) {
      return choices[n - 1]!;
    }
    const byName = choices.find((c) => c === v);
    if (byName) return byName;
    io.out(`not a choice: ${JSON.stringify(v)}\n`);
  }
}

/** Ask for a secret: no echo (raw mode), never printed back. */
export async function password(
  question: string,
  opts: PromptOptions = {},
): Promise<string> {
  const io = opts.io ?? defaultIO();
  need("password", question, io);
  io.out(`${question}: `);
  io.setRaw(true);
  const dec = new TextDecoder();
  const buf = new Uint8Array(64);
  let value = "";
  try {
    let chunk = takePending(io);
    for (;;) {
      if (chunk.length === 0) {
        const n = await io.read(buf);
        if (n === null) throw new InputClosedError(question);
        chunk = buf.subarray(0, n);
      }
      const text = dec.decode(chunk);
      chunk = new Uint8Array(0);
      for (const ch of text) {
        if (ch === "\r" || ch === "\n") {
          io.out("\n");
          return value;
        }
        if (ch === "\x03") throw new InputClosedError(question); // ^C
        if (ch === "\x7f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    }
  } finally {
    io.setRaw(false);
  }
}
