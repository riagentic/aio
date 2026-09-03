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
import { BUILD_VERSION_ENV } from "../server/app-version.ts";

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

/** The compile step's own "this file now exists" line.
 *
 *  It is NOT the artifact's final location. Since "one path, one name, one
 *  dist/" every build runs under the fleet, which MOVES what the compiler
 *  produced into the out dir under a versioned, target-suffixed name — so a
 *  `✓ /home/me/app/app` printed here names a path that does not exist by the
 *  time the build finishes, and a reader (or a script) that takes it for the
 *  artifact looks in the wrong place. Under the fleet the line says what it
 *  is: a staged file the summary will place. Standalone, it is the answer. */
export function compiled(path: string, root: string): void {
  const rel = path.startsWith(root + "/") ? path.slice(root.length + 1) : path;
  if (Deno.env.get(BUILD_VERSION_ENV) === undefined) {
    ok(path);
    return;
  }
  step(`compiled ${rel}`, "staged — the summary below places it");
}

/** An INTERMEDIATE artifact: it exists now, and will not exist when the build
 *  finishes.
 *
 *  `dist/app.js`, `dist/style.css`, `dist/icon.png` are inputs to the compile
 *  step — the fleet moves what they become INTO the binary and then assembles
 *  a clean `dist/` holding the binaries and `manifest.json`. So a build ended
 *  with `✓ dist/app.js` on screen and no such file on disk, and the docs told
 *  readers to serve it. Same rule `compiled()` already follows for the binary:
 *  under the fleet these lines say what they are; standalone (no fleet moving
 *  anything) `✓` is the truth and stays. */
export function staged(what: string, detail?: string): void {
  if (Deno.env.get(BUILD_VERSION_ENV) === undefined) {
    ok(what, detail);
    return;
  }
  step(
    `built ${what}`,
    `${
      detail ? detail + " — " : ""
    }goes into the binary; not in the final dist/`,
  );
}
