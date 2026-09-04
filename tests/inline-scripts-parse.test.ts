// Every HTML shell aio serves carries hand-written JavaScript inside a
// TypeScript TEMPLATE LITERAL. That is a language boundary with no compiler on
// the far side: TS interprets the escapes, so a `'\n'` written for the JS
// string becomes a REAL newline in the emitted script and splits the string
// literal across two lines. The page then dies on a SyntaxError before
// anything else in that <script> runs — no reload socket, no app bundle, a
// blank screen with one line in a console nobody has open. Measured: exactly
// that, from one `\n` inside a `console.error(...)` in the dev reload script.
//
// `deno check` cannot see it (it is a string), `deno lint` cannot see it, and
// the type system is on the wrong side of the quote. So: PARSE the strings.
import { assert } from "@std/assert";
import { devWsScript } from "../src/server/server-html-scripts.ts";
import { generateDiagnosticHTML } from "../src/server/server-html-diagnostic.ts";

/** Every `<script>…</script>` body in `html` (module scripts included, and
 *  never `type="importmap"` / `application/json`, which are data). */
function scriptBodies(html: string): string[] {
  const out: string[] = [];
  for (
    const m of html.matchAll(
      /<script([^>]*)>([\s\S]*?)<\/script>/g,
    )
  ) {
    const attrs = m[1] ?? "";
    if (/type\s*=\s*"(importmap|application\/json)"/.test(attrs)) continue;
    const body = (m[2] ?? "").trim();
    if (body) out.push(body);
  }
  return out;
}

/** Why `src` is not parseable JavaScript, or null when it is. */
function syntaxError(src: string): string | null {
  try {
    // `new Function` rejects `import`/`export`, so a module script is wrapped
    // in an async IIFE body the same way the engine would evaluate its
    // statements. Neither form EXECUTES anything — parsing is the whole test.
    new Function(src);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

Deno.test("the dev reload script is parseable JavaScript", () => {
  const src = devWsScript();
  const err = syntaxError(src);
  assert(
    err === null,
    `devWsScript() does not parse: ${err}\n--- script ---\n${src}`,
  );
});

Deno.test("every script in the diagnostic shell is parseable JavaScript", () => {
  const html = generateDiagnosticHTML(
    [] as Parameters<typeof generateDiagnosticHTML>[0],
    "diagnostics",
  );
  const bodies = scriptBodies(html);
  assert(bodies.length > 0, "no <script> found — did the shell change shape?");
  for (const body of bodies) {
    const err = syntaxError(body);
    assert(
      err === null,
      `a diagnostic-shell script does not parse: ${err}\n--- script ---\n${body}`,
    );
  }
});
