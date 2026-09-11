// sourcemap-boot.ts — load the client bundle's source map, once, at boot.
//
// Its own module because the thing it does is easy to write and impossible to
// see: a forwarded browser error either names the author's file or says
// `app.js:1:22073`, and nothing in between reports which. Inline in the boot
// path this was five lines with no way to ask whether they had worked; here it
// returns what happened and a test can ask.

import { join } from "@std/path";
import { BUNDLE_JS, BUNDLE_MAP } from "./app-files.ts";
import {
  hasClientSourceMap,
  setClientSourceMap,
} from "../diagnostics/stack-remap.ts";

/** Install `<distDir>/.app.js.map` if the build left one.
 *
 *  Returns whether a usable map is now installed. `false` is the NORMAL answer
 *  for a dev server — it serves unbundled modules, whose positions are already
 *  the author's own — so this is a fact to report at debug level, never a
 *  warning.
 *
 *  Always calls through, including with `null`: a reload that produced no map
 *  must CLEAR the previous one rather than leave it mapping a bundle it no
 *  longer describes, which is the confident-wrong-answer version of this
 *  feature. */
export async function installBundleSourceMap(
  distDir: string,
): Promise<boolean> {
  const text = await Deno.readTextFile(join(distDir, BUNDLE_MAP))
    .catch(() => null);
  setClientSourceMap(text, BUNDLE_JS);
  // `setClientSourceMap` parses, so "the file was there" and "the map is
  // usable" are different answers — a truncated map reads fine and maps
  // nothing. Report the second one.
  return hasClientSourceMap();
}
