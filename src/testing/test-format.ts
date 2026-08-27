// test-format.ts — how a harness failure READS.
//
// Deliberately NOT re-exported from `src/cell-test.ts`: these are the shape of
// a message, not API anyone calls. `aio/testing` is `export *` over
// cell-test.ts, so a helper defined there is a public name forever.

/** THE state dump both assertion APIs print on failure (`t.expect.state` and
 *  `testUI`'s `ui.expectCell`). One formatter, so the two cannot drift into
 *  "one of them tells you what it saw and the other doesn't" — which is
 *  exactly what they had: `expectCell` said only
 *  `testUI: expectCell failed for cell 'notes'.`
 *
 *  Cycle-safe and length-capped: a cell holding a big list should not bury the
 *  assertion under 40 KB of JSON, and a proxy that throws on read must not
 *  replace the failure with a formatting failure. @internal */
export function formatCellState(state: unknown, maxLen = 2000): string {
  if (state === undefined) return "(unavailable)";
  let text: string;
  try {
    const seen = new WeakSet<object>();
    text = JSON.stringify(state, (_k, v) => {
      if (typeof v === "bigint") return `${v}n`;
      if (typeof v === "function") return "[Function]";
      if (v && typeof v === "object") {
        if (seen.has(v as object)) return "[Circular]";
        seen.add(v as object);
      }
      return v;
    }) ?? String(state);
  } catch (e) {
    return `(unserializable: ${e instanceof Error ? e.message : String(e)})`;
  }
  return text.length > maxLen
    ? `${text.slice(0, maxLen)}… (${text.length} chars, truncated)`
    : text;
}

/** Where the CALLER is, for a harness that registers `Deno.test` on their
 *  behalf. Deno stamps a test's reported location with the site of the
 *  `Deno.test` call — which, for `testCell`, is this file — so a failure
 *  header reads `=> src/testing/cell-test.ts:211` and an IDE's
 *  jump-to-failure lands inside the framework. `Deno.TestDefinition` has no
 *  `location` field to override it (checked against Deno 2.9), so the next
 *  best thing is to put the caller in the FAILURE, and to keep framework
 *  frames off the top of its stack. @internal */
export function callerLocation(skipFiles: string[]): string | undefined {
  const frames = (new Error().stack ?? "").split("\n").slice(1);
  for (const f of frames) {
    if (skipFiles.some((n) => f.includes(n))) continue;
    if (f.includes("ext:") || f.includes("node:")) continue;
    const m = /\(?((?:file|https?):\/\/\S+?):(\d+):(\d+)\)?\s*$/.exec(
      f.trim(),
    );
    if (!m) continue;
    // Relative to the project when we can — `tests/notes.test.ts:13:5` reads
    // as a place; a 90-character file:// URL reads as noise.
    let where = m[1]!;
    try {
      const cwd = new URL(`${Deno.cwd()}/`, "file:///").href;
      if (where.startsWith("file://") && where.startsWith(cwd)) {
        where = where.slice(cwd.length);
      }
    } catch {
      // aio-ok: this shortens a location for READING (`tests/x.test.ts:13:5`
      // instead of a 90-character file:// URL). Without `--allow-read` for the
      // cwd there is nothing to shorten against, and the untouched absolute
      // URL is still the correct location — the message is longer, not wrong.
    }
    return `${where}:${m[2]}:${m[3]}`;
  }
  return undefined;
}

/** Every `t.expect.*` failure, built the same way: the caller's `file:line:col`
 *  in the MESSAGE, and framework frames stripped off the top of the stack so an
 *  IDE's jump-to-failure lands on the user's assertion instead of inside
 *  `src/testing/`. (Deno stamps the test's own `=>` header with the site of the
 *  `Deno.test` call — this file — and `Deno.TestDefinition` has no `location`
 *  to override it, checked against Deno 2.9. This is the part we can fix.)
 *  @internal */
export function assertionFailure(message: string): Error {
  const at = callerLocation([HARNESS_DIR]);
  // Location FIRST: it is the one thing a reader needs before the state dump,
  // and it stays on the message's first line where terminals and IDEs linkify
  // it. A long dump must never push it out of view.
  const err = new Error(at ? `${at} — ${message}` : message);
  const lines = (err.stack ?? "").split("\n");
  const first = lines.findIndex((l) => /^\s+at /.test(l));
  if (first > 0) {
    const rest = lines.slice(first);
    // Drop the harness frames between `throw` and the user's line, so an IDE
    // parsing the stack lands on the assertion, not on this file.
    while (rest.length > 1 && rest[0]!.includes(HARNESS_DIR)) rest.shift();
    err.stack = [...lines.slice(0, first), ...rest].join("\n");
  }
  return err;
}

/** This folder, as it appears in a stack frame. */
const HARNESS_DIR = "/src/testing/";
