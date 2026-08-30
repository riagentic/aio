// fmt.ts — THE presentation vocabulary. Every surface aio shows a human —
// `am`, the build, the dev banner, errors, the linter, the gates — composes
// its output from these functions and nothing else.
//
// Why one module, and why here. Before this file, twelve surfaces each had a
// private idea of what a warning looks like: `⚠ …` on one line running 200
// columns off the right edge (`am pin`), `[build] note: …`, `error: …`,
// `┏━━ AIO ERROR ━━┓`, and `JSON.stringify(x, null, 2)` printed straight at a
// terminal (`am doctor`). Same facts, five vocabularies, none of them wrapped.
// A user learns ONE of these or none. It lives in `diagnostics/` because that
// is the folder every other folder is already allowed to import (the boundary
// matrix, scripts/check-boundaries.ts) — a copy in `cli/` would have needed
// four new matrix edges, and a second copy is how one surface keeps printing
// the old shape after the vocabulary moved on.
//
// The house style is PLAIN: no box drawing, no frames, no rules. Structure is
// carried by a dim label column, a bright value column, and blank lines
// between groups; state is carried by colour and one glyph. That degrades
// perfectly — with `NO_COLOR`, in a pipe, in CI, in a screen reader, every
// line still says the same words in the same columns.
//
// Everything here is PURE: a function of its arguments to a string. Nothing
// prints, nothing reads the environment except the two deciders it must
// (`colorEnabled`, and the terminal's width). That is what lets a test assert
// on a rendered block without a TTY, and what keeps `--json` byte-identical:
// the JSON branch simply never calls in here.

import { colorEnabled } from "./color.ts";

// ── width ────────────────────────────────────────────────────────────────

/** Strip ANSI escapes — what a terminal actually shows.
 *
 *  Both SGR (`\x1b[1m`) and the cursor/erase codes a live line uses
 *  (`\x1b[2K`, `\r`), because a progress line is measured too. */
export function stripAnsi(s: string): string {
  // deno-lint-ignore no-control-regex
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

/** True for code points a terminal renders two cells wide (CJK, Hangul, most
 *  emoji). Padding that counts them as one splits every column after them. */
function isWide(cp: number): boolean {
  return (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) || // CJK radicals … Yi
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK compatibility ideographs
    (cp >= 0xfe30 && cp <= 0xfe6f) || // CJK compatibility forms
    (cp >= 0xff00 && cp <= 0xff60) || // fullwidth forms
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) || // emoji
    (cp >= 0x1f900 && cp <= 0x1f9ff);
}

/** The number of terminal cells `s` occupies: ANSI stripped, combining marks
 *  free, wide code points counted twice. */
export function width(s: string): number {
  let n = 0;
  for (const ch of stripAnsi(s)) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x20 || cp === 0x7f) continue; // C0 controls: \r, \b — zero cells
    if (cp === 0x200d) continue; // ZWJ — an emoji sequence is still one glyph
    if (cp >= 0x300 && cp <= 0x36f) continue; // combining marks
    if (cp >= 0xfe00 && cp <= 0xfe0f) continue; // variation selectors
    n += isWide(cp) ? 2 : 1;
  }
  return n;
}

/** Back-compat name for {@link width} — `aio/cli` has exported it since the
 *  toolkit shipped. Same function, one implementation. */
export const plainWidth = width;

/** How wide the terminal is, clamped to a readable range.
 *
 *  Clamped for two opposite reasons and they are both real: a 400-column
 *  window would set prose 400 characters wide (unreadable), and a 20-column
 *  one would wrap `provisioned` onto six lines. Not a terminal → 80, the
 *  width every log file, CI transcript and `| less` is read at. */
export function termWidth(): number {
  try {
    // deno-lint-ignore no-explicit-any
    const D = (globalThis as any).Deno;
    if (!D?.stdout?.isTerminal?.()) return 80;
    const cols = D.consoleSize?.(D.stdout.rid ?? undefined)?.columns ??
      D.consoleSize?.()?.columns;
    if (typeof cols !== "number" || cols <= 0) return 80;
    return Math.max(40, Math.min(100, cols));
  } catch {
    return 80; // aio-ok: an unmeasurable terminal is 80 columns, not a crash
  }
}

// ── colour ───────────────────────────────────────────────────────────────

/** Colour/emphasis helpers. Each returns `s` untouched when colour is off. */
export type Style = Record<
  | "bold"
  | "dim"
  | "underline"
  | "red"
  | "green"
  | "yellow"
  | "blue"
  | "magenta"
  | "cyan",
  (s: string) => string
>;

const CODES: Record<keyof Style, string> = {
  bold: "1",
  dim: "2",
  underline: "4",
  red: "31",
  green: "32",
  yellow: "33",
  blue: "34",
  magenta: "35",
  cyan: "36",
};

/** A {@link Style} bound to an explicit colour decision — for tests, or a
 *  stream that is not stdout. */
export function styleWith(color: boolean): Style {
  const out = {} as Style;
  for (const [k, code] of Object.entries(CODES)) {
    out[k as keyof Style] = color
      ? (s) => `\x1b[${code}m${s}\x1b[0m`
      : (s) => s;
  }
  return out;
}

/** `style.bold("x")`, `style.dim("x")`, … — bound to THE process decider
 *  (`colorEnabled`, src/diagnostics/color.ts). */
export const style: Style = styleWith(colorEnabled);

// ── the vocabulary ───────────────────────────────────────────────────────

/** What a line is telling the reader. The ONE axis every surface shares: a
 *  build target, a doctor check, a running app and a linter finding all reduce
 *  to one of these, and each maps to exactly one glyph and one colour. */
export type Tone = "ok" | "warn" | "bad" | "info" | "note" | "run";

const GLYPH: Record<Tone, string> = {
  ok: "✓",
  warn: "!",
  bad: "✗",
  info: "i",
  note: "·",
  run: "●",
};

const PAINT: Record<Tone, keyof Style> = {
  ok: "green",
  warn: "yellow",
  bad: "red",
  info: "cyan",
  note: "dim",
  run: "green",
};

/** The glyph for a tone, coloured. One character wide in every tone, so a
 *  column of mixed statuses stays aligned. */
export function mark(tone: Tone, st: Style = style): string {
  return st[PAINT[tone]](GLYPH[tone]);
}

/** A green `✓` — the same character `mark("ok")` renders, as a constant, for
 *  the many lines that are one interpolated string rather than a call worth
 *  restructuring. Substituting `${OK}` for a bare `✓` colours the glyph
 *  through the ONE decider without touching the sentence around it. */
export const OK: string = mark("ok");
/** A red `✗`. */
export const NO: string = mark("bad");
/** A yellow `!`. */
export const HEY: string = mark("warn");
/** A dim `·`. */
export const NOTE: string = mark("note");

/** Pad `s` to `w` cells. Display-width aware, so a value containing a colour
 *  escape or a wide glyph still lands in its column. Never truncates: a long
 *  value pushes its row, it does not lose characters. */
export function pad(s: string, w: number, align: "left" | "right" = "left") {
  const gap = Math.max(0, w - width(s));
  return align === "right" ? " ".repeat(gap) + s : s + " ".repeat(gap);
}

/** Break `text` into lines of at most `w` cells, on spaces where it can.
 *  A word longer than `w` (a path, a URL, a token) is never chopped — it
 *  overhangs, because half a path is worse than a ragged edge.
 *
 *  `firstW` gives the FIRST line a different budget, for the common case where
 *  something already occupies the head of the line: a log entry's timestamp +
 *  level + category eats ~44 columns, and wrapping the whole message to what
 *  is left of them would then indent every continuation line 44 columns deep
 *  to keep the block square. The first line is short, the rest are full width
 *  under a shallow indent — which is how a paragraph is set. */
export function wrap(text: string, w: number, firstW = w): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(/ +/)) {
      const budget = out.length === 0 && line !== "" ? firstW : w;
      if (!line) line = word;
      else if (width(line) + 1 + width(word) <= budget) line += " " + word;
      else {
        out.push(line);
        line = word;
      }
    }
    out.push(line);
  }
  return out;
}

/** Prefix every line of `s` with `by`. */
export function indent(s: string, by = "  "): string {
  return s.split("\n").map((l) => (l ? by + l : l)).join("\n");
}

/** One `label   value` row. `null`/`undefined` values are dropped by
 *  {@link kv}, so a caller lists every field it *might* show and the absent
 *  ones simply do not appear — instead of printing `linked: undefined`. */
export type Row = {
  label: string;
  value: string | number | null | undefined;
  /** Colour for the value — default: plain. */
  tone?: Tone;
  /** A dim trailing comment on the same line. */
  note?: string;
};

/** Options shared by the block builders. */
export type FmtOptions = {
  /** Total width to wrap prose at — default {@link termWidth}. */
  width?: number;
  /** Styling decision — default: the process decider. */
  style?: Style;
  /** Left margin — default two spaces, the house indent for a detail block. */
  indent?: string;
};

/** Aligned `label   value` rows: dim labels, plain values, one column.
 *
 *  This is the workhorse. `am pin`, `am doctor`, the build summary and the
 *  dev banner are all this shape, and aligning them in ONE place is why they
 *  finally line up with each other. Rows with a nullish value are dropped. */
export function kv(rows: readonly Row[], opts: FmtOptions = {}): string {
  const st = opts.style ?? style;
  const pre = opts.indent ?? "  ";
  const live = rows.filter((r) => r.value !== null && r.value !== undefined);
  if (live.length === 0) return "";
  const w = Math.max(...live.map((r) => width(r.label)));
  return live.map((r) => {
    const v = String(r.value);
    const painted = r.tone ? st[PAINT[r.tone]](v) : v;
    const note = r.note ? "  " + st.dim(r.note) : "";
    // Padded OUTSIDE the paint: trailing spaces inside a dim/cyan run show up
    // as coloured whitespace when the line is selected or copied.
    // `pad` measures DISPLAY width, so padding a painted label appends plain
    // spaces after the reset — never coloured whitespace, which shows up the
    // moment someone selects or copies the line.
    return `${pre}${pad(st.dim(r.label), w)}  ${painted}${note}`.replace(
      / +$/,
      "",
    );
  }).join("\n");
}

/** A `✓ name   detail` status line — one per check, target, or app. */
export function statusLine(
  tone: Tone,
  name: string,
  detail?: string,
  opts: FmtOptions = {},
): string {
  const st = opts.style ?? style;
  const pre = opts.indent ?? "";
  return `${pre}${mark(tone, st)} ${name}${
    detail ? "  " + st.dim(detail) : ""
  }`;
}

/** A column-aligned run of {@link statusLine}s — `✓ client   214 KB`. */
export function statusList(
  items: readonly { tone: Tone; name: string; detail?: string }[],
  opts: FmtOptions = {},
): string {
  const st = opts.style ?? style;
  const pre = opts.indent ?? "";
  if (items.length === 0) return "";
  const w = Math.max(...items.map((i) => width(i.name)));
  return items.map((i) =>
    `${pre}${mark(i.tone, st)} ${pad(i.name, w)}${
      i.detail ? "  " + st.dim(i.detail) : ""
    }`.trimEnd()
  ).join("\n");
}

/** A wrapped, indented advisory block: a glyph, a headline, prose, and — the
 *  part that was always missing — the fix on its own line.
 *
 *  Every warning aio printed used to be one unwrapped sentence with the
 *  remedy trailing off the right edge of the terminal (`⚠ UNPINNED — a clone
 *  of this repo builds against whatever aio is installed. Pin it: …`). The
 *  reader needs three separable things: what happened, why it matters, what to
 *  type. They get three shapes. */
export function block(
  tone: Tone,
  headline: string,
  body?: string,
  fix?: string,
  opts: FmtOptions = {},
): string {
  const st = opts.style ?? style;
  const pre = opts.indent ?? "  ";
  const cols = (opts.width ?? termWidth()) - width(pre) - 3;
  const cont = pre + "   ";
  // The HEADLINE wraps too. It is the line most likely to be a whole sentence,
  // and leaving it unwrapped just moves the defect this block exists to remove
  // — a warning running off the right edge — up by one line.
  const lines = wrap(headline, cols).map((l, i) =>
    i === 0
      ? `${pre}${mark(tone, st)}  ${st[PAINT[tone]](l)}`
      : cont + st[PAINT[tone]](l)
  );
  if (body) { for (const l of wrap(body, cols)) lines.push(cont + st.dim(l)); }
  if (fix) lines.push(`${cont}${st.dim("fix")}  ${st.cyan(fix)}`);
  return lines.join("\n");
}

/** `command   what it does` rows — the "what you can type next" footer.
 *  Commands cyan, descriptions dim, aligned on the longest command. */
export function hints(
  rows: readonly (readonly [string, string])[],
  opts: FmtOptions = {},
): string {
  const st = opts.style ?? style;
  const pre = opts.indent ?? "  ";
  if (rows.length === 0) return "";
  const w = Math.max(...rows.map(([c]) => width(c)));
  return rows.map(([c, d]) =>
    `${pre}${st.cyan(c)}${" ".repeat(Math.max(0, w - width(c)))}  ${st.dim(d)}`
  ).join("\n");
}

/** A `3 ok · 1 skipped · 1 failed` tally. Zero-count parts are dropped, so a
 *  clean run reads `5 ok` rather than `5 ok · 0 skipped · 0 failed`.
 *
 *  A label is either literal (`"ok"`, `"built"`, `"skipped"` — adjectives that
 *  must NOT gain an `s`) or a `[one, many]` pair for a noun that must
 *  (`["error", "errors"]`). Spelling it out is the only way both read right;
 *  pluralising every label gave `3 oks`, and pluralising none gave `37 hint`. */
export function tally(
  parts: readonly (readonly [
    number,
    string | readonly [string, string],
    Tone,
  ])[],
  opts: FmtOptions = {},
): string {
  const st = opts.style ?? style;
  const live = parts.filter(([n]) => n > 0);
  if (live.length === 0) return "";
  return live.map(([n, label, tone]) =>
    st[PAINT[tone]](
      typeof label === "string"
        ? `${n} ${label}`
        : count(n, label[0], label[1]),
    )
  ).join(st.dim(" · "));
}

/** Fold a long list into `a b c d e +N` — the fix for the 34-version,
 *  1200-character `provisioned:` line. Order is the caller's; the tail is a
 *  count, never a `…` that hides how much was hidden. */
export function fold(
  items: readonly string[],
  max = 6,
  opts: FmtOptions = {},
): string {
  const st = opts.style ?? style;
  if (items.length <= max) return items.join(" ");
  return items.slice(0, max).join(" ") +
    st.dim(` +${items.length - max}`);
}

/** A headline: bright subject, dim trailing facts. `counter 0.1.206  → dist/` */
export function heading(
  subject: string,
  ...meta: (string | null | undefined)[]
): string {
  const rest = meta.filter(Boolean).join("  ");
  return style.bold(subject) + (rest ? "  " + style.dim(rest) : "");
}

// ── units ────────────────────────────────────────────────────────────────

/** Bytes as a human reads them: `214.3 KB`, `88.0 MB`, `912 B`. Binary units
 *  (a build artifact is measured the way the filesystem reports it).
 *
 *  ALWAYS one decimal above bytes, even at `15.0 GB`. A column that mixes
 *  `214.3 KB` with `15 GB` does not line up on the decimal point, and the
 *  whole reason these are formatted in one place is that they are read as a
 *  column — three build targets, four running apps — not one at a time. */
export function bytes(n: number): string {
  if (!Number.isFinite(n)) return "?";
  if (n < 1024) return `${Math.round(n)} B`;
  const units = ["KB", "MB", "GB", "TB", "PB"];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

/** A duration a human can compare at a glance: `840ms`, `8.4s`, `2m 03s`,
 *  `13h 33m`, `4d 6h`. Never `0.13333333333h`. */
export function dur(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "?";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(Math.floor(s % 60)).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${String(m % 60).padStart(2, "0")}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** `1 app` / `4 apps` — the plural is derived, never a `(s)` suffix. */
export function count(n: number, one: string, many = one + "s"): string {
  return `${n} ${n === 1 ? one : many}`;
}

// ── table ────────────────────────────────────────────────────────────────

/** Column spec for {@link table}: a key, or a key with a header/alignment. */
export type Column<R> = keyof R & string | {
  key: keyof R & string;
  header?: string;
  align?: "left" | "right";
};

/** Options for {@link table}. */
export type TableOptions<R> = {
  /** Which columns, in order — default: every key of the first row. */
  columns?: readonly Column<R>[];
  /** Styling decision — default: the process decider. */
  color?: boolean;
};

/** Render `rows` as an aligned text table (header bold when colour is on).
 *  Pure: returns the string, no trailing newline. No rows, no columns → "".
 *
 *  Width-aware through {@link pad}, so a cell that already carries colour — a
 *  green `●`, a yellow version — does not shift every column after it. The
 *  header is printed VERBATIM: `aio/cli` is a public toolkit and an app that
 *  passes `header: "what"` gets `what`. The house style's dim uppercase
 *  headers come from callers passing uppercase, not from this function
 *  overriding what it was handed. */
export function table<R extends Record<string, unknown>>(
  rows: readonly R[],
  opts: TableOptions<R> = {},
): string {
  if (rows.length === 0 && !opts.columns) return "";
  const cols = (opts.columns ?? Object.keys(rows[0] ?? {})).map((c) =>
    typeof c === "string" ? { key: c, header: c, align: "left" as const } : {
      key: c.key,
      header: c.header ?? c.key,
      align: c.align ?? "left",
    }
  );
  const cell = (v: unknown): string =>
    v === null || v === undefined ? "" : typeof v === "string" ? v : String(v);
  const body = rows.map((r) => cols.map((c) => cell(r[c.key])));
  const widths = cols.map((c, i) =>
    Math.max(width(c.header), ...body.map((r) => width(r[i]!)))
  );
  const st = styleWith(opts.color ?? colorEnabled);
  const line = (cells: string[]) =>
    cells.map((s, i) => pad(s, widths[i]!, cols[i]!.align)).join("  ")
      .trimEnd();
  const head = st.bold(line(cols.map((c) => c.header)));
  return [head, ...body.map(line)].join("\n");
}

// ── composition ──────────────────────────────────────────────────────────

/** Join blocks with ONE blank line between them, dropping empties.
 *
 *  Every renderer here returns "" for "nothing to say" (no rows, no warnings,
 *  a clean tally). Composing with `\n\n` by hand therefore produced runs of
 *  three blank lines whenever a section was empty; this is the only correct
 *  way to stack them, so it is the only way offered. */
export function stack(
  ...blocks: (string | null | undefined | false)[]
): string {
  return blocks.filter((b): b is string => !!b && b.length > 0).join("\n\n");
}

// ── generic data ─────────────────────────────────────────────────────────

/** Options for {@link describe}. */
export type DescribeOptions = FmtOptions & {
  /** How many items of a scalar array to show before `+N` — default 8. */
  fold?: number;
};

const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const scalar = (v: unknown): string =>
  v === null || v === undefined
    ? "—"
    : typeof v === "string"
    ? v
    : Array.isArray(v) || isPlain(v)
    ? ""
    : String(v);

/** Render arbitrary data in the house style — the DEFAULT for any command
 *  that has structure to report and no bespoke renderer yet.
 *
 *  This exists because the fallback it replaces was `JSON.stringify(x, null,
 *  2)` printed straight at a terminal: `am doctor` answered a human with
 *  `{ "ok": true, "findings": [], "message": "…" }`, braces, quotes and all.
 *  A bespoke renderer always beats this; nothing should ever be *worse* than
 *  this. Scalars become aligned `label  value` rows, arrays of objects become
 *  a table, arrays of scalars fold to `a b c +N`, and nesting indents. */
export function describe(value: unknown, opts: DescribeOptions = {}): string {
  const st = opts.style ?? style;
  const pre = opts.indent ?? "  ";
  const max = opts.fold ?? 8;
  const sub = { ...opts, indent: pre + "  " };

  if (value === null || value === undefined) return pre + st.dim("—");
  if (!isPlain(value) && !Array.isArray(value)) return pre + String(value);

  if (Array.isArray(value)) {
    if (value.length === 0) return pre + st.dim("(none)");
    if (value.every((v) => !isPlain(v) && !Array.isArray(v))) {
      return pre + fold(value.map(scalar), max, opts);
    }
    // Uniform records read as a table; anything ragged reads as blocks.
    const keys = [
      ...new Set(value.flatMap((v) => isPlain(v) ? Object.keys(v) : [])),
    ];
    const flat = value.every((v) =>
      isPlain(v) &&
      Object.values(v).every((x) => !isPlain(x) && !Array.isArray(x))
    );
    if (flat && keys.length > 0 && keys.length <= 6) {
      const rows = value.map((v) =>
        Object.fromEntries(
          keys.map((k) => [k, scalar((v as Record<string, unknown>)[k])]),
        )
      );
      return indent(
        table(rows, {
          columns: keys,
          color: opts.style ? false : colorEnabled,
        }),
        pre,
      );
    }
    return value.map((v) => describe(v, opts)).join("\n\n");
  }

  const entries = Object.entries(value);
  if (entries.length === 0) return pre + st.dim("(empty)");
  const flatRows = entries.filter(([, v]) => !isPlain(v) && !Array.isArray(v));
  const deep = entries.filter(([, v]) => isPlain(v) || Array.isArray(v));
  const parts: string[] = [];
  if (flatRows.length > 0) {
    parts.push(
      kv(flatRows.map(([k, v]) => ({ label: k, value: scalar(v) })), opts),
    );
  }
  for (const [k, v] of deep) {
    if (Array.isArray(v) && v.length === 0) {
      parts.push(kv([{ label: k, value: st.dim("(none)") }], opts));
    } else if (
      Array.isArray(v) && v.every((x) => !isPlain(x) && !Array.isArray(x))
    ) {
      parts.push(
        kv([{ label: k, value: fold(v.map(scalar), max, opts) }], opts),
      );
    } else {
      parts.push(`${pre}${st.dim(k)}\n${describe(v, sub)}`);
    }
  }
  return parts.filter(Boolean).join("\n");
}
