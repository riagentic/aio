// What the user asked to SEE (an app's state, its logs, an eval result) is
// DATA: byte-exact when piped, and on a terminal only what it would EXECUTE is
// removed. The message sanitizer (`printable`) used to run on it too, and
// `am state`/`am logs` turned a ZWJ family emoji into 👨?👩?👧, a Persian ZWNJ
// and a Hebrew RLM into `?`, and every colour the app itself logged in 256 or
// truecolor into `?` — piped, too (`am logs -f | grep` saw other bytes than
// the file holds). Messages `am` composes (lock text inside) stay strict.
import { assert, assertEquals } from "@std/assert";
import {
  out,
  outData,
  outValue,
  sayData,
  sayDataStream,
} from "../src/am/am-output.ts";

/** Everything that DISPLAYS and must survive, byte for byte. */
const SHOWN = "👨‍👩‍👧 می‌خواهم ‏שלום‎ ﻿BOM " +
  "\x1b[38;5;208m256\x1b[0m \x1b[38;2;10;20;30mtrue\x1b[0m \x1b[1;31mbold\x1b[m" +
  " crlf\r\n";
/** What a terminal would EXECUTE. */
const EXEC =
  "\x1b]0;pwn\x07\x1b]8;;http://evil\x1b\\link\x1b]8;;\x1b\\\x1b[2J\x1b[H\x9b";

/** Run `fn` with stdout as a pipe or a terminal; what it wrote, as text. */
async function capture(tty: boolean, fn: () => unknown): Promise<string> {
  const chunks: string[] = [];
  const [log, write, isTerm] = [
    console.log,
    Deno.stdout.write,
    Deno.stdout.isTerminal,
  ];
  console.log = (...a: unknown[]) => chunks.push(a.join(" ") + "\n");
  // deno-lint-ignore no-explicit-any
  (Deno.stdout as any).write = (b: Uint8Array) => {
    chunks.push(new TextDecoder().decode(b));
    return Promise.resolve(b.length);
  };
  Deno.stdout.isTerminal = () => tty;
  try {
    await fn();
  } finally {
    console.log = log;
    // deno-lint-ignore no-explicit-any
    (Deno.stdout as any).write = write;
    Deno.stdout.isTerminal = isTerm;
  }
  return chunks.join("");
}

Deno.test("data piped: logs and state reach the pipe byte-exact", async () => {
  const text = SHOWN + EXEC;
  // `am logs -f | grep` — the stream sink.
  assertEquals(await capture(false, () => sayDataStream(text)), text);
  // `am logs` / `am surface` / tables — the line sink.
  assertEquals(await capture(false, () => sayData(text)), text + "\n");
  // `am state | jq` — the value, exactly.
  const value = { title: SHOWN, nested: { s: EXEC } };
  assertEquals(
    JSON.parse(await capture(false, () => outValue(value, "json"))),
    value,
  );
});

Deno.test("data on a terminal: what displays stays, what executes goes", async () => {
  for (
    const said of [
      await capture(true, () => sayDataStream(SHOWN + EXEC)),
      await capture(true, () => outValue(SHOWN + EXEC, "pretty")),
    ]
  ) {
    assert(said.startsWith(SHOWN), JSON.stringify(said));
    assert(
      !/\x1b\]|\x1b\[2J|\x1b\[H|\x07|\x9b/.test(said),
      JSON.stringify(said),
    );
  }
});

Deno.test("messages stay strict: lock text in an object is printable", async () => {
  // `out` with no pretty text describes the object — its strings (a lock's
  // home) go through the message sanitizer: no bidi override survives.
  const said = await capture(
    true,
    () => out({ home: "/h‮​x\x1b]0;p\x07" }, "pretty"),
  );
  assert(said.includes("/h"), said);
  assert(!/[‮​\x07]|\x1b\]/.test(said), JSON.stringify(said));
});

// The RENDERED text is what gets sanitized, not the object: a walk over the
// value stopped at depth 4 and at any class instance, and `am state` printed
// an app's OSC title + clear-screen from a string five levels down.
Deno.test("out/outData/outValue: nothing executes, however deep or whatever class", async () => {
  let deep: unknown = { s: EXEC };
  for (let i = 0; i < 10; i++) deep = { [`k${i}`]: deep, arr: [deep] };
  class Box {
    toString() {
      return `box${EXEC}`;
    }
  }
  // the shape `am trigger` replies with: a result plus the fresh surface
  const reply = {
    ok: true,
    surface: {
      components: [{ name: "App", elements: [{ path: "A", text: EXEC }] }],
    },
  };
  const bad = /\x1b\]|\x1b\[2J|\x1b\[H|\x07|\x9b/;
  for (const v of [deep, new Box(), [new Box()], reply, { b: new Box() }]) {
    for (
      const said of [
        await capture(true, () => out(v, "pretty")),
        await capture(true, () => outValue(v, "pretty")),
        await capture(true, () => outValue(v, "json")),
      ]
    ) assert(!bad.test(said), JSON.stringify(said));
  }
});

// `terminalSafe` itself, sequence by sequence — deleting any one branch of it
// (OSC, DCS/PM/APC, C1, non-SGR CSI, bare ESC) goes red here.
Deno.test("terminalSafe: each executing sequence removed, SGR and text kept", async () => {
  const { terminalSafe } = await import(
    "../src/server/single-instance-lock.ts"
  );
  const cases: [string, string][] = [
    ["a\x1b]0;title\x07b", "ab"], // OSC, BEL-terminated
    ["a\x1b]8;;http://x\x1b\\b", "ab"], // OSC, ST-terminated
    ["a\x1bPq#0;1\x1b\\b", "ab"], // DCS (sixel)
    ["a\x1b_apc\x1b\\b\x1b^pm\x1b\\", "ab"], // APC, PM
    ["a\x9b2Jb\x9d0;t\x07", "a2Jb0;t"], // C1 CSI / OSC introducers
    ["a\x1b[2J\x1b[H\x1b[10;5H\x1b[?25lb", "ab"], // CSI erase/cursor/mode
    ["a\x1bcb\x1b7", "ab"], // bare ESC (reset, save cursor)
    ["a\x00\x08\x0bb", "ab"], // C0 other than \t \n \r
    [
      "\x1b[1;31mr\x1b[0m \x1b[38;5;208m2\x1b[m \x1b[38:2::1:2:3mt\x1b[0m",
      "\x1b[1;31mr\x1b[0m \x1b[38;5;208m2\x1b[m \x1b[38:2::1:2:3mt\x1b[0m",
    ], // SGR, every form
    ["t\tn\nr\r👨‍👩‍👧 ‏שלום", "t\tn\nr\r👨‍👩‍👧 ‏שלום"], // text
  ];
  for (const [input, want] of cases) {
    assertEquals(terminalSafe(input), want, JSON.stringify(input));
  }
});

// A table cell is MEASURED before its line is sanitized: a cell whose escape
// the sink rewrites (`\x1b[8m` → `?`) or removes (an OSC) shifted every column
// after it. The cells are cleaned first, so the columns line up.
Deno.test("out/outData: a table with escapes in its cells stays aligned", async () => {
  const rows = [
    { name: "x\x1b[8my", n: "1" },
    { name: "\x1b]0;t\x07z", n: "2" },
    { name: "plain", n: "3" },
  ];
  // deno-lint-ignore no-control-regex
  const visible = (l: string) => l.replace(/\x1b\[[0-9;]*m/g, "");
  for (const print of [out, outData]) {
    const said = await capture(true, () => print(rows, "pretty"));
    const cols = said.split("\n").filter((l) => /[123]\s*$/.test(l))
      .map((l) => visible(l).search(/[123]\s*$/));
    assertEquals(cols.length, 3, JSON.stringify(said));
    assertEquals(new Set(cols).size, 1, JSON.stringify(said));
  }
});
