// Two aiol rules that answered a different question than the code they judge.
//
// 1. Code written WITHOUT semicolons. The live-draft-escape and sync-I/O rules
//    scanned to the next `;`, so a statement ran on into the next one: a false
//    ERROR (`cache.set(id, 1)⏎ s.$do(() => s.n)` "stores a callback") and a
//    missed one (`const double = (x) => x * 2⏎ s.t = Deno.readTextFileSync()`
//    blanked as if inside the arrow). Same rule, also: a local `const saved = s`
//    shadowing a module-level `saved` was reported, and the second name of
//    `let first = 0, saved = null` was invisible.
//
// 2. The credential rule claims to be the boot refusal, pre-boot. It disagreed
//    with the boot on four spellings, both ways. The differential below asks
//    the BOOT (the harness's `_refuseUnsafeCells`, which runs the same
//    `refuseUnsafeComposition` `aio.run()` does) and aiol the same question
//    about the same source text.
import { assertEquals, assertStringIncludes } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import { buildContext } from "../aiol/context.ts";
import {
  checkCredentialFieldName,
  checkProxyEscape,
  checkSyncMethodIO,
} from "../aiol/checks.ts";
import type { Checker, Issue } from "../aiol/types.ts";
import { _refuseUnsafeCells } from "../src/testing/boot-refusals.ts";
import { getRegisteredCells } from "../src/state/cell-reactive.ts";
import type { CellDef } from "../src/state/cell-types.ts";

const DENO_JSON = JSON.stringify({
  imports: { aio: "jsr:@riagentic/aio@1.0.0" },
});

async function lint(
  check: Checker,
  files: Record<string, string>,
): Promise<Issue[]> {
  const dir = await Deno.makeTempDir({ prefix: "aiol-asi-" });
  try {
    await Deno.mkdir(join(dir, "src"), { recursive: true });
    await Deno.writeTextFile(join(dir, "deno.json"), DENO_JSON);
    for (const [rel, src] of Object.entries(files)) {
      await Deno.writeTextFile(join(dir, rel), src);
    }
    const { ctx, report } = await buildContext(dir);
    await check(ctx);
    return report.issues;
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const noSemi = (methods: string, top = "") =>
  `import { cell } from "aio"\n${top}\nexport const a = cell("a", { state: { n: 0, t: "" }, methods: {\n${methods}\n} })\n`;

// ── 1. statements end at a newline, too ──

Deno.test("proxy escape: a semicolon-free call does not own the callback on the next line", async () => {
  const issues = await lint(checkProxyEscape, {
    "src/a.ts": noSemi(
      "  add(s, id) {\n    cache.set(id, 1)\n    s.$do(() => console.log(s.n))\n  },",
      "const cache = new Map()",
    ),
  });
  assertEquals(issues, []);
});

Deno.test("proxy escape: a semicolon-free stored callback that reads s still fires", async () => {
  const issues = await lint(checkProxyEscape, {
    "src/a.ts": noSemi(
      "  sub(s) {\n    listeners.push(() => s.n)\n    s.n++\n  },",
      "const listeners = []",
    ),
  });
  assertEquals(issues.length, 1, JSON.stringify(issues));
  assertStringIncludes(issues[0]!.message, "stores a callback that reads `s`");
});

Deno.test("proxy escape: an assignment continued on the next line is still one statement", async () => {
  const issues = await lint(checkProxyEscape, {
    "src/a.ts": noSemi(
      "  hook(s) {\n    onTick =\n      () => s.n\n  },",
      "let onTick = null",
    ),
  });
  assertEquals(issues.length, 1, JSON.stringify(issues));
});

Deno.test("proxy escape: a local that shadows the module binding is not an escape", async () => {
  const issues = await lint(checkProxyEscape, {
    "src/a.ts": noSemi(
      "  bump(s) { const saved = s; saved.n++ },\n  other(s, saved) { saved = s },",
      "let saved = null",
    ),
  });
  assertEquals(issues, []);
});

Deno.test("proxy escape: every name of a comma declaration is a module binding", async () => {
  const issues = await lint(checkProxyEscape, {
    "src/a.ts": noSemi(
      "  keep(s) { saved = s },\n  peek(s) { ({ x } = { x: 1 }); pinned = s },",
      "let first = 0, saved: unknown = null\nlet { a: pinned, b } = { a: null, b: 2 }",
    ),
  });
  assertEquals(issues.length, 2, JSON.stringify(issues.map((i) => i.message)));
  for (const i of issues) assertStringIncludes(i.message, "stores `s` itself");
});

Deno.test("sync I/O: a semicolon-free local arrow does not hide the next statement", async () => {
  const issues = await lint(checkSyncMethodIO, {
    "src/a.ts": noSemi(
      '  load(s) {\n    const double = (x) => x * 2\n    s.t = Deno.readTextFileSync("x")\n  },',
    ),
  });
  assertEquals(issues.length, 1, JSON.stringify(issues));
  assertStringIncludes(issues[0]!.message, "`Deno.readTextFileSync()`");
  assertStringIncludes(issues[0]!.message, "src/a.ts:6");
});

Deno.test("sync I/O: an arrow body continued on the next line is still the arrow's", async () => {
  const issues = await lint(checkSyncMethodIO, {
    "src/a.ts": noSemi(
      '  load(s) {\n    s.$do(() =>\n      fetch("/x")\n        .then((r) => r.text()))\n    s.n++\n  },',
    ),
  });
  assertEquals(issues, []);
});

// ── 2. the credential lint and the boot answer the same question ──

const VARIANTS: Record<string, string> = {
  plain: `state: { apiKey: "" }`,
  excludeDotEscape:
    `state: { apiKey: "" }, visible: { exclude: ["apiKey.whatever"] }`,
  excludeTrailingDot:
    `state: { password: "" }, visible: { exclude: ["password."] }`,
  excludeProper:
    `state: { password: "", n: 0 }, visible: { exclude: ["password"] }`,
  none: `state: { password: "" }, visible: "none"`,
  include: `state: { password: "", n: 0 }, visible: { include: ["n"] }`,
  includeCred:
    `state: { password: "", n: 0 }, visible: { include: ["password", "n"] }`,
  publicFields:
    `state: { password: "" }, visible: { publicFields: ["password"] }`,
  scopeClient: `state: { password: "" }, scope: "client"`,
  quotedKey: `state: { "password": "" }`,
  singleQuotedKey: `state: { 'apiKey': "", n: 0 }`,
  forUser: `state: { password: "" }, visible: { forUser: (s) => s }`,
  forUserMethod:
    `state: { password: "" }, visible: { forUser(s) { return s; } }`,
  containerDeep:
    `state: { creds: { password: "" } }, visible: { exclude: ["creds.password"] }`,
  urlValue: `state: { url: "http://x", n: 0 }`,
};

Deno.test("credential rule: aiol reports exactly what the boot refuses", async () => {
  const dir = await Deno.makeTempDir({ prefix: "aiol-cred-parity-" });
  const mod = toFileUrl(new URL("../mod.ts", import.meta.url).pathname).href;
  const disagree: string[] = [];
  const refusedBy: string[] = [];
  try {
    for (const [name, cfg] of Object.entries(VARIANTS)) {
      const id = `credparity${name.toLowerCase()}`;
      const src = (from: string) =>
        `import { cell } from "${from}";\nexport const x = cell("${id}", { ${cfg}, methods: { noop(_s) {} } });\n`;

      const issues = await lint(checkCredentialFieldName, {
        "src/x.ts": src("aio"),
      });
      const linted = issues.some((i) =>
        i.message.includes("named like a credential")
      );

      const file = join(dir, `${name}.ts`);
      await Deno.writeTextFile(file, src(mod));
      const { x } = await import(toFileUrl(file).href) as { x: CellDef };
      let refused = false;
      try {
        _refuseUnsafeCells([x]);
      } catch (e) {
        refused = /credential/.test(String((e as Error).message));
      } finally {
        (getRegisteredCells() as Map<string, CellDef>).delete(id);
      }
      if (refused) refusedBy.push(name);
      if (linted !== refused) {
        disagree.push(`${name}: aiol=${linted} boot-refuses=${refused}`);
      }
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
  assertEquals(disagree, [], `\n${disagree.join("\n")}`);
  // Verify the instrument: a boot that refused nothing (or everything) would
  // agree with a broken lint just as happily.
  assertEquals(refusedBy, [
    "plain",
    "excludeDotEscape",
    "excludeTrailingDot",
    "includeCred",
    "quotedKey",
    "singleQuotedKey",
  ]);
});
