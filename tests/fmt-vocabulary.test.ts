// fmt-vocabulary.test.ts — the house output vocabulary (src/diagnostics/fmt.ts).
//
// The load-bearing property is the LAST test in this file: for every renderer,
// colour-off output is the colour-on output with the escapes removed. Not
// "similar" — identical, character for character. That is the whole contract
// that lets `NO_COLOR`, a pipe, a CI transcript and a screen reader see the
// same words in the same columns as a terminal does, and it is the one thing
// a future renderer is most likely to break (by padding with a coloured
// string, or by only emitting a glyph when colour is on).

import { assert, assertEquals } from "@std/assert";
import {
  block,
  bytes,
  count,
  dur,
  fold,
  heading,
  hints,
  indent,
  kv,
  mark,
  pad,
  stack,
  statusList,
  stripAnsi,
  style,
  styleWith,
  table,
  tally,
  termWidth,
  type Tone,
  width,
  wrap,
} from "../src/diagnostics/fmt.ts";

const OFF = styleWith(false);
const ON = styleWith(true);

Deno.test("fmt width: ANSI is free, wide glyphs cost two, combining marks cost nothing", () => {
  assertEquals(width("abc"), 3);
  assertEquals(width(ON.red("abc")), 3);
  assertEquals(width("\x1b[2K\rabc"), 3); // cursor codes too, not just SGR
  assertEquals(width("日本"), 4);
  assertEquals(width("é"), 1); // e + combining acute = one cell
  assertEquals(width("✓"), 1); // the status glyphs MUST be one cell…
  assertEquals(width("!"), 1); // …in every tone, or a column of mixed
  assertEquals(width("✗"), 1); //    statuses stops lining up
  assertEquals(width("●"), 1);
  assertEquals(width("i"), 1);
  assertEquals(width("·"), 1);
});

Deno.test("fmt pad: pads by DISPLAY width, so a coloured cell keeps its column", () => {
  assertEquals(pad("ab", 5), "ab   ");
  assertEquals(pad("ab", 5, "right"), "   ab");
  // The bug this exists to prevent: padEnd() on a coloured string counts the
  // escape bytes and under-pads by ~9 characters, shifting every later column.
  assertEquals(width(pad(ON.green("ab"), 5)), 5);
  assertEquals(pad("toolong", 3), "toolong"); // never truncates
});

Deno.test("fmt wrap: fits the width, keeps long words whole, honours hard newlines", () => {
  const lines = wrap("the quick brown fox jumps over the lazy dog", 12);
  for (const l of lines) assert(width(l) <= 12, `too wide: ${l}`);
  assertEquals(lines.join(" "), "the quick brown fox jumps over the lazy dog");
  // A path or URL is never chopped in half — half a path is worse than a
  // ragged right edge, because it cannot be copied.
  const long = wrap("run /home/dev/very/long/path/to/a/file.ts now", 10);
  assert(long.includes("/home/dev/very/long/path/to/a/file.ts"));
  assertEquals(wrap("a\nb", 40), ["a", "b"]);
});

Deno.test("fmt kv: aligned label column, nullish rows DROPPED, tones and notes", () => {
  const s = kv([
    { label: "latest", value: "v1.0.0-alpha72" },
    { label: "linked", value: null }, // absent, not `linked  null`
    { label: "pin", value: undefined }, // absent
    { label: "provisioned", value: 34, note: "alpha26 … alpha72" },
  ], { style: OFF });
  assertEquals(
    s,
    "  latest       v1.0.0-alpha72\n" +
      "  provisioned  34  alpha26 … alpha72",
  );
  assertEquals(kv([{ label: "a", value: null }], { style: OFF }), "");
  assertEquals(kv([], { style: OFF }), "");
});

Deno.test("fmt statusList: glyph + aligned name + dim detail", () => {
  const s = statusList([
    { tone: "ok", name: "client", detail: "214.3 KB" },
    { tone: "bad", name: "electron" },
    { tone: "warn", name: "server", detail: "slow" },
  ], { style: OFF });
  assertEquals(s, "✓ client    214.3 KB\n✗ electron\n! server    slow");
});

Deno.test("fmt block: headline, wrapped body, the fix on its OWN line", () => {
  const s = block(
    "warn",
    "This app is not pinned.",
    "A clone builds against whatever aio happens to be installed here.",
    "am pin --latest",
    { style: OFF, width: 44 },
  );
  const lines = s.split("\n");
  assertEquals(lines[0], "  !  This app is not pinned.");
  // The remedy is a separate, copyable line — never trailing off the right
  // edge of a sentence, which is what every aio warning used to do.
  assertEquals(lines.at(-1), "     fix  am pin --latest");
  for (const l of lines) assert(width(l) <= 44, `too wide: ${l}`);
});

Deno.test("fmt hints: aligned `command  description` footer", () => {
  assertEquals(
    hints(
      [["am pin <version>", "switch this app"], ["am pin main", "the tip"]],
      {
        style: OFF,
      },
    ),
    "  am pin <version>  switch this app\n  am pin main       the tip",
  );
  assertEquals(hints([], { style: OFF }), "");
});

Deno.test("fmt tally: zero-count parts are dropped, never `0 failed`", () => {
  const parts: (readonly [number, string, Tone])[] = [
    [3, "ok", "ok"],
    [0, "skipped", "warn"],
    [1, "failed", "bad"],
  ];
  assertEquals(tally(parts, { style: OFF }), "3 ok · 1 failed");
  assertEquals(tally([[5, "ok", "ok"]], { style: OFF }), "5 ok");
  assertEquals(tally([[0, "ok", "ok"]], { style: OFF }), "");
});

Deno.test("fmt fold: a long list becomes head + a COUNT, never a bare ellipsis", () => {
  const v = Array.from({ length: 34 }, (_, i) => `a${i}`);
  // `…` hides how much was hidden; `+28` answers the question the reader
  // actually has. This is the 1200-character `provisioned:` line, fixed.
  assertEquals(fold(v, 6, { style: OFF }), "a0 a1 a2 a3 a4 a5 +28");
  assertEquals(fold(["a", "b"], 6, { style: OFF }), "a b");
  assertEquals(fold([], 6, { style: OFF }), "");
});

Deno.test("fmt units: bytes, durations and plurals a human can compare", () => {
  assertEquals(bytes(912), "912 B");
  assertEquals(bytes(219442), "214.3 KB");
  assertEquals(bytes(92274688), "88.0 MB");
  assertEquals(bytes(1024 * 1024 * 1024 * 15), "15.0 GB");
  assertEquals(bytes(NaN), "?");

  assertEquals(dur(840), "840ms");
  assertEquals(dur(8400), "8.4s");
  assertEquals(dur(45_000), "45s");
  assertEquals(dur(123_000), "2m 03s");
  assertEquals(dur(48_780_000), "13h 33m");
  assertEquals(dur(360_000_000), "4d 4h");
  assertEquals(dur(-1), "?");

  assertEquals(count(1, "app"), "1 app");
  assertEquals(count(4, "app"), "4 apps");
  assertEquals(count(2, "entry", "entries"), "2 entries");
});

Deno.test("fmt stack: one blank line between blocks, empties dropped entirely", () => {
  // Every renderer returns "" for "nothing to say", so hand-joining with
  // "\n\n" produced runs of three blank lines whenever a section was empty.
  assertEquals(stack("a", "", "b", null, undefined, false, "c"), "a\n\nb\n\nc");
  assertEquals(stack("", null), "");
});

Deno.test("fmt indent/heading/mark/termWidth: the small pieces", () => {
  assertEquals(indent("a\n\nb", "> "), "> a\n\n> b"); // blank lines stay blank
  assertEquals(
    stripAnsi(heading("counter", "0.1.206", null, "→ dist/")),
    "counter  0.1.206  → dist/",
  );
  assertEquals(stripAnsi(heading("counter")), "counter");
  assertEquals(mark("ok", OFF), "✓");
  assert(mark("bad", ON).includes("\x1b[31m"));
  const w = termWidth();
  assert(w >= 40 && w <= 100, `termWidth out of range: ${w}`);
});

Deno.test("fmt: colour OFF is colour ON with the escapes removed — every renderer", () => {
  const rows = [
    { label: "version", value: "unpinned", tone: "warn" as Tone },
    { label: "latest", value: "v1.0.0-alpha72", note: "3 ahead" },
  ];
  const items = [
    { tone: "ok" as Tone, name: "client", detail: "214 KB" },
    { tone: "bad" as Tone, name: "electron" },
  ];
  const cases: [string, string][] = [
    [kv(rows, { style: OFF }), kv(rows, { style: ON })],
    [statusList(items, { style: OFF }), statusList(items, { style: ON })],
    [
      block("bad", "It broke", "Some prose here.", "am fix", {
        style: OFF,
        width: 40,
      }),
      block("bad", "It broke", "Some prose here.", "am fix", {
        style: ON,
        width: 40,
      }),
    ],
    [
      hints([["am fix", "repair"]], { style: OFF }),
      hints([["am fix", "repair"]], { style: ON }),
    ],
    [
      tally([[3, "ok", "ok"], [1, "failed", "bad"]], { style: OFF }),
      tally([[3, "ok", "ok"], [1, "failed", "bad"]], { style: ON }),
    ],
    [
      fold(["a", "b", "c"], 2, { style: OFF }),
      fold(["a", "b", "c"], 2, { style: ON }),
    ],
    [mark("warn", OFF), mark("warn", ON)],
    [
      table([{ a: 1, b: "x" }], { color: false }),
      table([{ a: 1, b: "x" }], { color: true }),
    ],
  ];
  for (const [plain, colored] of cases) {
    assertEquals(
      stripAnsi(colored),
      plain,
      `colour changed the CHARACTERS, not just the escapes:\n${
        JSON.stringify(colored)
      }`,
    );
  }
});

Deno.test("fmt style: `style` follows the ONE framework colour decider", async () => {
  // Not asserted against a literal — asserted against the decider, so this
  // test cannot pass by accident in either environment.
  const { colorEnabled } = await import("../src/diagnostics/color.ts");
  assertEquals(style.dim("s"), colorEnabled ? ON.dim("s") : "s");
});
