// Every generated script must PARSE — with a negative control proving the
// check can fail.
//
// cc §5.4: the Electron main process is generated source, and a generator that
// can emit text can emit text that does not parse. One `'\n'` written where the
// outer template literal consumed it left main.cjs with a string literal broken
// across two lines — and "the app would not start at all. The server booted,
// Electron launched, and the window never appeared." Nothing had checked, so it
// surfaced when a human launched the product. Every other newline in the same
// file was escaped, which is what makes the slip easy to make and hard to see.
//
// So: every script this repo generates — both Electron mains, the client
// picker, the preload and its diagnostics, the dev socket script, and every
// <script> body in every HTML shell — is run through the parser here. Module
// bodies use top-level `await import(...)`, which the AsyncFunction
// constructor accepts and a plain `new Function` does not; classic scripts are
// a subset. Milliseconds, no Electron, no browser.
import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  electronClientScript,
  electronMainScript,
  electronMainScriptUDS,
} from "../src/electron/electron.ts";
import {
  udsPreloadDiagnostics,
  udsPreloadScript,
  udsProdHTML,
} from "../src/electron/electron-shared.ts";
import { devWsScript } from "../src/server/server-html-scripts.ts";
import {
  androidLocalHTML,
  generateHTML,
} from "../src/server/server-html-gen.ts";
import { generateDiagnosticHTML } from "../src/server/server-html-diagnostic.ts";

const AsyncFunction = Object.getPrototypeOf(async function () {})
  .constructor as new (body: string) => unknown;

/** Throws the parser's own SyntaxError (with its line) when `src` does not
 *  parse. Parses only — nothing runs. */
function mustParse(name: string, src: string): true {
  try {
    new AsyncFunction(src);
    return true;
  } catch (e) {
    throw new Error(
      `generated script "${name}" does not parse — ${e}\n` +
        `A template-literal generator emitted text JavaScript cannot read. ` +
        `The usual cause is a JS escape written once (\`'\\n'\`) where the TS ` +
        `template needs it twice (\`'\\\\n'\`), or a backtick in a comment.`,
    );
  }
}

/** Every <script> body in an HTML shell, in order. Inline only — a `src=`
 *  script has no body here. */
function scriptBodies(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) {
    if (/\btype\s*=\s*["']importmap["']/.test(m[0])) continue; // JSON, not JS
    if (m[1]!.trim()) out.push(m[1]!);
  }
  return out;
}

const GENERATED: [string, () => string][] = [
  [
    "electron main (UDS shell)",
    () =>
      electronMainScriptUDS("http://localhost:3000", "/tmp/parse.sock", {
        title: "t",
      }),
  ],
  [
    "electron main (UDS shell, zero-port)",
    () =>
      electronMainScriptUDS("aio://app/", "/tmp/parse.sock", {
        title: "t",
        baseDir: "/tmp/nope",
      }),
  ],
  [
    "electron main (WS shell)",
    () => electronMainScript("http://localhost:3000"),
  ],
  ["electron client picker", () => electronClientScript()],
  [
    "electron client picker (baked url)",
    () => electronClientScript("http://10.0.0.2:3000"),
  ],
  ["uds preload", () => udsPreloadScript()],
  ["uds preload diagnostics", () => udsPreloadDiagnostics()],
  ["dev socket script", () => devWsScript()],
];

Deno.test("generated scripts: every standalone script parses", () => {
  const parsed: string[] = [];
  for (const [name, gen] of GENERATED) {
    const src = gen();
    assert(src.length > 200, `${name}: the generator returned almost nothing`);
    if (mustParse(name, src)) parsed.push(name);
  }
  // Every generator in the list was reached and parsed — a list that shrank
  // by accident, or a loop that never ran, is not a green result.
  assertEquals(parsed, GENERATED.map(([n]) => n));
});

Deno.test("generated scripts: every <script> in every HTML shell parses", () => {
  const shells: [string, string][] = [
    [
      "dev shell",
      generateHTML({
        title: "t",
        prod: false,
        hasCSS: true,
        importMap: '{"imports":{}}',
      }),
    ],
    [
      "prod shell",
      generateHTML({
        title: "t",
        prod: true,
        hasCSS: false,
        importMap: "",
      }),
    ],
    [
      "prod shell, themed chrome",
      generateHTML({
        title: "t",
        prod: true,
        hasCSS: false,
        importMap: "",
        chrome: "themed",
      }),
    ],
    ["uds prod html", udsProdHTML("t", true)],
    ["android local html", androidLocalHTML("t", true)],
    ["diagnostic html", generateDiagnosticHTML([], "t")],
  ];
  // A shell may carry no inline script at all (Android loads its bundle by
  // `src=`), so the floor is on the TOTAL: an extractor that silently matched
  // nothing would fail it, while a src-only shell does not.
  let checked = 0;
  for (const [name, html] of shells) {
    const bodies = scriptBodies(html);
    bodies.forEach((b, i) => mustParse(`${name} <script> #${i + 1}`, b));
    checked += bodies.length;
  }
  assert(
    checked >= 6,
    `only ${checked} script bodies checked — extractor broken?`,
  );
});

// The instrument, verified: the exact §5.4 defect must FAIL here. A parse
// check that cannot fail is a comment.
Deno.test("generated scripts: the §5.4 escape defect is caught", () => {
  const good = electronMainScriptUDS("http://localhost:3000", "/tmp/p.sock", {
    title: "t",
  });
  // What `'\n'` in the TS source produced: the JS escape replaced by a REAL
  // newline inside a single-quoted string literal.
  const at = good.indexOf("+ '\\n'");
  assert(
    at > -1,
    "the generated main should contain a '\\\\n' escape to break",
  );
  const broken = good.slice(0, at) + "+ '\n'" +
    good.slice(at + "+ '\\n'".length);
  assert(broken !== good, "the negative control did not perturb the script");
  assertThrows(
    () => mustParse("electron main (deliberately broken)", broken),
    Error,
    "does not parse",
  );
});
