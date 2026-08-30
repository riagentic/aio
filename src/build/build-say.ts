// build-say.ts — how the build talks. The ONE place a build line is coloured,
// glyphed and streamed, so `deno task build`, `am build` and `aio compile`
// cannot drift into three vocabularies.
//
// What it replaces: 38 hand-written `[build] ✓ …` / `[build] ✗ …` /
// `[build] ⚠ …` / `[build] note: …` strings, uncoloured, on whichever stream
// the author happened to reach for, with the `[build]` tag repeated on every
// line of a wall of them. The tag was doing no work — a build's output is
// obviously the build's — while the glyph, which IS the information, was
// plain grey among the rest.
//
// The stream is chosen by the LEVEL, not by the call site: a failure that
// goes to stdout cannot be separated with `2>`, and a wrapper cannot tell it
// from output. Same rule the framework logger follows (logger-format.ts).

import { block, mark, style } from "../diagnostics/fmt.ts";

/** `✓ dist/app.js   214.3 KB` — a thing that now exists. stdout. */
export function ok(what: string, detail?: string): void {
  console.log(`${mark("ok")} ${what}${detail ? "  " + style.dim(detail) : ""}`);
}

/** A step that is under way (or a fact worth stating). stdout, dim glyph. */
export function step(what: string, detail?: string): void {
  console.log(
    `${mark("note")} ${what}${detail ? "  " + style.dim(detail) : ""}`,
  );
}

/** An advisory the build is carrying on past. stderr — it is not output, and
 *  a caller filtering stdout for artifact paths must not swallow it. */
export function warn(headline: string, body?: string, fix?: string): void {
  console.warn(block("warn", headline, body, fix, { indent: "" }));
}

/** A refusal. stderr. Returns the rendered text so a caller that must ALSO
 *  throw carries exactly the words it printed, never a second wording. */
export function bad(headline: string, body?: string, fix?: string): string {
  const s = block("bad", headline, body, fix, { indent: "" });
  console.error(s);
  return s;
}
