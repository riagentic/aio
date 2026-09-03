// Log forging: a client could write its own lines into the app's log files.
//
// Attacker-controlled strings reach the logger from half a dozen doors — a
// rejected WS action type, a protocol-version mismatch out of a client's own
// handshake, a sync op's cell name, a method name a browser invented. Every
// one of them was interpolated into the message VERBATIM, so a raw "\n" in it
// wrote a second line into app.log / warning.log / error.log / debug.log,
// starting at column 0, in the exact shape of a real entry:
//
//   2026-09-02 00:00:00.000  ERROR  auth        FORGED admin login ok
//
// …which is the file an operator reads after an incident. A raw "\r" did the
// same to a TERMINAL without needing a newline at all, and a raw "\x1b" could
// repaint it.
//
// The fix is ONE decider at the rendering boundary (`_safeMsg`/`_safeValue` in
// src/diagnostics/logger-format.ts), which both text sinks pass through — not
// a sanitising call at each of the sites that relay remote text. So these
// tests assert the PROPERTY over the logger, not over any one call site: one
// emitted entry is one line at column 0, always, whatever it was handed.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { interceptConsole } from "./console-capture.ts";
import { AioLogger } from "../src/diagnostics/logger.ts";
import {
  _safeMsg,
  _safeValue,
  formatText,
} from "../src/diagnostics/logger-format.ts";

/** A real entry's line starts with the timestamp, at column 0. Nothing a
 *  caller supplies may ever produce one. */
const ENTRY_LINE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/;

const FORGERY = "2026-09-02 00:00:00.000  ERROR  auth        FORGED login ok";

function realLines(text: string): string[] {
  return text.split("\n").filter((l) => ENTRY_LINE.test(l));
}

Deno.test("log forging: one emitted entry is exactly one line at column 0", async () => {
  const dir = Deno.makeTempDirSync();
  const l = new AioLogger({
    dir,
    level: "debug",
    console: false,
    heartbeat: 0,
    backupLogs: false,
  });
  await l.init();

  // Every level, so every sink file is exercised: debug.log takes all of
  // them, app.log takes info/warn/error, error.log and warning.log one each.
  const payloads = [
    `bad type "\n${FORGERY}"`,
    `bad type "\r${FORGERY}"`,
    `bad type "\r\n${FORGERY}"`,
  ];
  let emitted = 0;
  for (const p of payloads) {
    for (const lvl of ["info", "warn", "error"] as const) {
      l.pub(lvl, "ws", p);
      emitted++;
    }
  }
  await l.flush();

  const app = await Deno.readTextFile(`${dir}/app.log`);
  assertEquals(
    realLines(app).length,
    emitted,
    `app.log must hold ONE column-0 line per emitted entry — a client-supplied` +
      ` newline forged extra ones. Got:\n${app}`,
  );
  const warn = await Deno.readTextFile(`${dir}/warning.log`);
  assertEquals(
    realLines(warn).length,
    payloads.length,
    `warning.log:\n${warn}`,
  );
  const err = await Deno.readTextFile(`${dir}/error.log`);
  assertEquals(realLines(err).length, payloads.length, `error.log:\n${err}`);
  const dbg = await Deno.readTextFile(`${dir}/debug.log`);
  assertEquals(
    realLines(dbg).length,
    emitted,
    `debug.log:\n${dbg}`,
  );

  // Refused, not swallowed: the text is still on record, just never at column
  // 0 and never as an escape the terminal would act on.
  assertStringIncludes(app, "FORGED login ok");
  assertEquals(app.includes("\r"), false, "a raw CR reached the log file");
  assertEquals(app.includes("\x1b"), false, "a raw ESC reached the log file");

  await l.flush();
  await Deno.remove(dir, { recursive: true });
});

Deno.test("log forging: a field VALUE is collapsed to one line", async () => {
  const dir = Deno.makeTempDirSync();
  const l = new AioLogger({
    dir,
    level: "debug",
    console: false,
    heartbeat: 0,
    backupLogs: false,
  });
  await l.init();
  // Both the inline (<= 4 fields) and the bulk shape.
  l.pub("warn", "ws", "rejected", { type: `x\n${FORGERY}` });
  l.pub("warn", "ws", "rejected", {
    a: 1,
    b: 2,
    c: 3,
    d: 4,
    e: 5,
    type: `x\n${FORGERY}`,
  });
  await l.flush();

  const warn = await Deno.readTextFile(`${dir}/warning.log`);
  assertEquals(realLines(warn).length, 2, `warning.log:\n${warn}`);
  assertEquals(
    warn.trimEnd().split("\n").length,
    2,
    `a k=v field must never span lines at all:\n${warn}`,
  );
  assertStringIncludes(warn, "\\n");

  await l.flush();
  await Deno.remove(dir, { recursive: true });
});

Deno.test("log forging: the CONSOLE sink gets the same treatment", () => {
  const dir = Deno.makeTempDirSync();
  const l = new AioLogger({
    dir,
    level: "debug",
    console: true,
    heartbeat: 0,
    backupLogs: false,
  });
  // No init(): the console half prints before the files exist, which is
  // exactly the window this used to be invisible in.
  const lines: string[] = [];
  const restore = interceptConsole(lines);
  try {
    l.pub("warn", "ws", `bad type "\r\n${FORGERY}"\x1b[2J`);
  } finally {
    restore();
  }
  const printed = lines.join("\n");
  assertEquals(
    realLines(printed).length,
    1,
    `one console entry is one column-0 line:\n${printed}`,
  );
  assertEquals(printed.includes("\r"), false, "a raw CR reached the terminal");
  assertEquals(
    printed.includes("\x1b[2J"),
    false,
    `a client-supplied ANSI sequence reached the terminal:\n${
      JSON.stringify(printed)
    }`,
  );
  Deno.removeSync(dir, { recursive: true });
});

Deno.test("log forging: the message cap is loud, not silent", () => {
  const huge = "a".repeat(20_000);
  const out = _safeMsg(huge);
  assert(out.length < 9000, `capped: ${out.length}`);
  assertStringIncludes(out, "truncated");
  assertEquals(_safeValue("a\nb"), "a\\nb");
  // A literal backslash-x-0-a in the input must stay literal — an unescape
  // pass that turned it back into a newline would reopen the whole hole.
  assertEquals(
    formatText({
      ts: "2026-09-02 00:00:00.000",
      lvl: "warn",
      cat: "ws",
      msg: "a\\x0ab",
    }).split("\n").length,
    1,
  );
});

// ── What the sanitiser must NOT cost ──────────────────────────────────
//
// The first version of this guard escaped `\x1b` wholesale and indented every
// continuation line by four spaces. Both were too broad, and both were visible
// in ordinary use: a message that paints one word red printed a literal
// `\x1b[31m`, and the framework's own aligned blocks — the config error list,
// the graph report, `doctor` — were shoved four columns right, breaking the
// alignment their authors had counted on. The forgery property never needed
// either. What a forger needs is a line at column 0 (a newline, or a `\r` that
// rewinds over the timestamp) or an escape that MOVES or REPAINTS the cursor.
// Colour cannot do that, and a line that already begins with whitespace is
// already not at column 0. So the rule is exact: SGR through, everything else
// escaped; indentation preserved, with a single space added only to a line
// that would otherwise start hard against the margin.

Deno.test("log formatting: colour survives, cursor control does not", () => {
  // Allowed: SGR only sets colour and weight; it cannot leave its own line.
  for (const sgr of ["\x1b[31m", "\x1b[0m", "\x1b[1;32m", "\x1b[38;5;244m"]) {
    assertStringIncludes(
      _safeMsg(`before${sgr}after`),
      sgr,
      `SGR ${JSON.stringify(sgr)} must reach the terminal — a log message that
       paints part of itself is ordinary, and escaping it prints raw bytes`,
    );
  }
  // Refused: everything that moves, erases, retitles, or starts nothing.
  for (
    const [what, seq] of [
      ["cursor up", "\x1b[2A"],
      ["cursor home", "\x1b[H"],
      ["erase display", "\x1b[2J"],
      ["set title", "\x1b]0;pwned\x07"],
      ["lone escape", "\x1bZ"],
    ] as const
  ) {
    const out = _safeMsg(`x${seq}y`);
    assertEquals(
      /\x1b/.test(out.replace(/\x1b\[[0-9;]*m/g, "")),
      false,
      `${what} reached the terminal: ${JSON.stringify(out)}`,
    );
  }
});

Deno.test("log formatting: a message keeps its own indentation", () => {
  // A deliberate block (this is the shape `doctor` and the config error list
  // emit) must render exactly as it was written, so its columns still line up.
  const block = "3 problems:\n  ✗ maxConnections: 0\n      why: at least 1";
  const out = _safeMsg(block);
  assertEquals(out, block, "an already-indented block was reflowed");

  // Only a line that would start at column 0 is moved, and only by one space,
  // which is all the forgery property asks for.
  assertEquals(_safeMsg("first\nsecond"), "first\n second");
  const continuations = _safeMsg("first\nsecond\n\tthird").split("\n").slice(1);
  assertEquals(continuations.length, 2, "the block lost a continuation line");
  for (const line of continuations) {
    assertEquals(/^\S/.test(line), false, `continuation at column 0: ${line}`);
  }
});
