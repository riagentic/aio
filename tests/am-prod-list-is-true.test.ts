// When `am` hits a production app it prints what DOES work there. That list
// named `am errors` and `am metrics`, and neither does: `am errors` reads
// `/__aio/error`, which `server-static.ts` gates on `!prod`, and `am metrics`
// goes through the trojan, which a production build never mounts. Measured
// against a real compiled binary, both answered 404 — one of them with a bare
// "404 Not Found" and no cause at all, immediately after being told it would
// work.
//
// "The commands printed are the commands that work" is this project's rule for
// docs and CLI output. A list of what works in production has to be a list of
// what works in production, so it is checked against the implementations
// rather than maintained by hand.
import { assertEquals } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import { codeText } from "../src/diagnostics/code-mask.ts";

const REPO = dirname(dirname(fromFileUrl(import.meta.url)));
const read = (p: string) => Deno.readTextFileSync(join(REPO, p));

/** The verbs the production-diagnosis message promises. */
function claimedProdVerbs(): string[] {
  // The sentence is built from concatenated string literals, so read a window
  // after it rather than one literal — stopping at the first closing quote
  // found only half the list.
  const src = read("src/am/am-http.ts");
  const at = src.indexOf("Against a production app, these work:");
  if (at < 0) throw new Error("the production-capability sentence is gone");
  const window = src.slice(at, src.indexOf(".\\n", at));
  return [...window.matchAll(/am ([a-z]+)/g)].map((x) => x[1]!);
}

/** verb → handler name, from the one COMMANDS table. */
function handlerFor(verb: string): string | null {
  const cli = read("src/am.ts");
  const block = cli.slice(
    cli.indexOf("const COMMANDS"),
    cli.indexOf("\n};", cli.indexOf("const COMMANDS")),
  );
  return new RegExp(`^\\s*${verb}:\\s*([A-Za-z0-9_]+)`, "m").exec(block)?.[1] ??
    null;
}

/** A handler's body, by brace depth from its `export … function <name>` line.
 *
 *  `raw` for MESSAGE text and `code` for call sites: `codeText` blanks string
 *  bodies, which is exactly right for "does this call the trojan" and exactly
 *  wrong for "does this message say why". Line numbers are preserved, so the
 *  two views share one range. */
function handlerBodies(name: string): { raw: string; code: string } {
  for (const f of Deno.readDirSync(join(REPO, "src", "am"))) {
    if (!f.name.endsWith(".ts")) continue;
    const rawSrc = read(join("src", "am", f.name));
    const lines = codeText(rawSrc).split("\n");
    const rawLines = rawSrc.split("\n");
    const start = lines.findIndex((l) =>
      new RegExp(`^export (async )?function ${name}\\b`).test(l)
    );
    if (start < 0) continue;
    // `depth <= 0` cannot end the body until it has been OPENED: these
    // signatures span lines, so `export async function cmdErrors(` is followed
    // by two parameter lines with no brace at all. Breaking on the first of
    // them returned a two-line "body" — and a body with nothing in it makes
    // every check below pass for the wrong reason, which is how the first
    // draft of this file reported a green over a list it had never read.
    let depth = 0;
    let opened = false;
    let end = start;
    for (let i = start; i < lines.length; i++) {
      depth += (lines[i]!.match(/\{/g) ?? []).length -
        (lines[i]!.match(/\}/g) ?? []).length;
      if (depth > 0) opened = true;
      end = i;
      if (opened && depth <= 0) break;
    }
    return {
      code: lines.slice(start, end + 1).join("\n"),
      raw: rawLines.slice(start, end + 1).join("\n"),
    };
  }
  return { raw: "", code: "" };
}

Deno.test("am: every verb promised for production avoids dev-only endpoints", () => {
  const verbs = claimedProdVerbs();
  assertEquals(verbs.length > 3, true, `only found: ${verbs.join(", ")}`);
  const broken: string[] = [];
  for (const verb of verbs) {
    const handler = handlerFor(verb);
    if (!handler) {
      broken.push(`${verb} (no such command)`);
      continue;
    }
    const { code: body } = handlerBodies(handler);
    if (!body) continue; // handler lives outside src/am — nothing to judge
    // Not "does it touch a dev-only endpoint" — `am status` asks the trojan for
    // metrics and prints a shorter line when that fails, which is exactly how a
    // command SHOULD be listed here. The defect is an UNGUARDED dependency:
    // ending the command on that call's failure. `cmdErrors` did precisely
    // that, and `cmdMetrics` still does, which is why neither belongs.
    const lines = handlerBodies(handler).raw.split("\n");
    lines.forEach((line, i) => {
      if (!/\btrojan(Get|Post)\s*\(|__aio\/error/.test(line)) return;
      const after = lines.slice(i, i + 8).join("\n");
      const bails = /\bfail\s*\(|Deno\.exit\s*\(/.test(after) &&
        /!\s*\w+\.ok|!result\.ok/.test(after);
      if (bails) {
        broken.push(
          `${verb} → ${handler} ENDS on a dev-only endpoint's failure ` +
            `(line ${i + 1} of its body)`,
        );
      }
    });
  }
  assertEquals(
    broken,
    [],
    "the production-capability list promises commands that cannot work " +
      `against a production build:\n  ${broken.join("\n  ")}`,
  );
});

Deno.test("am errors explains itself instead of a bare 404", () => {
  // A status code with no cause, for a command a message had just recommended.
  const { raw: body } = handlerBodies("cmdErrors");
  assertEquals(
    /DEV-ONLY/.test(body),
    true,
    "cmdErrors must say WHY a production app has no /__aio/error",
  );
  assertEquals(
    /am logs/.test(body),
    true,
    "…and point at where a compiled app's errors actually are",
  );
});
