// A server module that reads a file beside itself works in dev and throws
// NotFound in a compiled binary unless the file is embedded (a field report:
// a packaged app fell back to the wrong theme in silence). The rule
// (`src/build/unembedded-reads.ts`), then the real thing: the build refuses,
// the refusal names the deno.json line, and that line is what makes the
// binary's read work.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  runtimeFileReads,
  unembeddedReadMessage,
  unembeddedReads,
} from "../src/build/unembedded-reads.ts";
import { childEnv, makeApp, task } from "./e2e-app-harness.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const reads = (src: string) =>
  runtimeFileReads(src).map((r) =>
    `${r.line}:${r.spec}:${r.certain ? "E" : "w"}`
  );

Deno.test("unembedded reads: every literal form inside a read call is certain", () => {
  assertEquals(
    reads(
      [
        `const a = await Deno.readTextFile(new URL("../../style.css", import.meta.url));`,
        `const b = Deno.readFileSync(new URL('./b.bin', import.meta.url));`,
        `const c = await Deno.open(fromFileUrl(new URL("./c.db", import.meta.url)));`,
        `const d = await fetch(new URL("./d.json", import.meta.url));`,
        `const e = await Deno.readFile(fromFileUrl(import.meta.resolve("./e.wasm")));`,
        `const f = Deno.readTextFileSync(`,
        `  new URL(`,
        `    "./f.txt",`,
        `    import.meta.url,`,
        `  ),`,
        `);`,
      ].join("\n"),
    ),
    [
      "1:../../style.css:E",
      "2:./b.bin:E",
      "3:./c.db:E",
      "5:./e.wasm:E",
      "7:./f.txt:E",
    ],
  );
});

// A client component's `fetch(new URL("./data.json", import.meta.url))` is in
// the scanned graph (the entry imports the App for SSR) and runs in the
// browser: the bundler resolved the URL, the binary's file system is not
// involved. It failed the build.
Deno.test("unembedded reads: a fetch is never certain — judged only in a *.server.ts module, as a warning", () => {
  const src = [
    `export const load = () => fetch(new URL("./data.json", import.meta.url));`,
    `const U = new URL("./more.json", import.meta.url);`,
    `export const more = () => fetch(U).then((r) => r.json());`,
    `export const real = () => Deno.readTextFile(new URL("./t.css", import.meta.url));`,
  ].join("\n");
  const of = (path: string) =>
    unembeddedReads({
      modules: [{ path, content: src }],
      included: [],
      kind: () => "file",
    }).map((f) => `${f.at} ${f.certain ? "E" : "w"}`);
  for (const client of ["src/App.tsx", "src/data.ts", "src/app.client.ts"]) {
    assertEquals(of(client), [`${client}:4 E`], client);
  }
  assertEquals(of("src/api.server.ts"), [
    "src/api.server.ts:1 w",
    "src/api.server.ts:2 w",
    "src/api.server.ts:4 E",
  ]);
  assertEquals(reads(src), ["4:./t.css:E"], "the default is not server-only");
});

// A read whose absence the code handles is the app's fallback, not a crash:
// a warning that names the guard and the marker, never a refused build.
Deno.test("unembedded reads: a read guarded for the compiled case is a warning that names the guard", () => {
  const U = (n: string) => `new URL("./${n}", import.meta.url)`;
  const rows: [name: string, src: string[], want: string][] = [
    [".catch on the read", [
      `const a = await Deno.readTextFile(${U("a")}).catch(() => "");`,
    ], "1:a .catch(…) on the read"],
    [".catch after .then", [
      `const a = await Deno.readTextFile(${U("a")})`,
      `  .then((t) => JSON.parse(t))`,
      `  .catch(() => null);`,
    ], "1:a .catch(…) on the read"],
    ["try/catch", [
      `let css = "";`,
      `try {`,
      `  css = Deno.readTextFileSync(${U("a")});`,
      `} catch {`,
      `  css = FALLBACK;`,
      `}`,
    ], "3:the try/catch around it"],
    ["try/catch (e) with a nested block", [
      `try {`,
      `  if (x) { css = await Deno.readTextFile(${U("a")}); }`,
      `} catch (e) { log(e); }`,
    ], "2:the try/catch around it"],
    ["if (!Deno.build.standalone) { … }", [
      `if (!Deno.build.standalone) {`,
      `  css = await Deno.readTextFile(${U("a")});`,
      `}`,
    ], "2:the `if (!Deno.build.standalone)` around it"],
    ["if (!isCompiled()) one-liner", [
      `if (!isCompiled()) css = Deno.readTextFileSync(${U("a")});`,
    ], "1:the `if (!isCompiled())` around it"],
    ["else of the positive test", [
      `if (Deno.build.standalone) { css = EMBEDDED; } else {`,
      `  css = Deno.readTextFileSync(${U("a")});`,
      `}`,
    ], "2:the `if (Deno.build.standalone)` around it"],
    ["early return", [
      `export function load() {`,
      `  if (Deno.build.standalone) return EMBEDDED;`,
      `  return Deno.readTextFileSync(${U("a")});`,
      `}`,
    ], "3:the `if (Deno.build.standalone)` return before it"],
  ];
  for (const [name, src, want] of rows) {
    const got = runtimeFileReads(src.join("\n"));
    assertEquals(
      got.map((r) => `${r.line}:${r.guard}`),
      [want],
      name,
    );
    assertEquals(got[0]!.certain, false, name);
  }
  // What is NOT a guard stays certain.
  const not: [name: string, src: string[]][] = [
    ["a catch that rethrows", [
      `try { css = Deno.readTextFileSync(${U("a")}); }`,
      `catch (e) { throw new Error("no css", { cause: e }); }`,
    ]],
    ["try/finally", [
      `try { css = Deno.readTextFileSync(${U("a")}); } finally { done(); }`,
    ]],
    ["a try that ended before the read", [
      `try { other(); } catch { /* */ }`,
      `css = Deno.readTextFileSync(${U("a")});`,
    ]],
    ["a .catch on the NEXT statement", [
      `css = Deno.readTextFileSync(${U("a")});`,
      `other().catch(() => {});`,
    ]],
    ["the read runs ONLY when compiled", [
      `if (Deno.build.standalone) {`,
      `  css = Deno.readTextFileSync(${U("a")});`,
      `}`,
    ]],
    ["a standalone test in another function", [
      `function a() { if (Deno.build.standalone) return 1; return 2; }`,
      `function b() { return Deno.readTextFileSync(${U("a")}); }`,
    ]],
    ["the words in a string", [
      `const s = "try { } catch { } if (!Deno.build.standalone) {";`,
      `css = Deno.readTextFileSync(${U("a")});`,
    ]],
  ];
  for (const [name, src] of not) {
    const got = runtimeFileReads(src.join("\n"));
    assertEquals(
      got.map((r) => [r.certain, r.guard]),
      [[true, undefined]],
      name,
    );
  }
  const msg = unembeddedReadMessage({
    at: "src/theme.server.ts:3",
    spec: "./a.css",
    rel: "src/a.css",
    why: "unembedded",
    certain: false,
    guard: "the try/catch around it",
  }, []);
  assertStringIncludes(msg, "guarded by the try/catch around it");
  assertStringIncludes(msg, "// aio-ok(read): <why>");
  assertStringIncludes(msg, `add "compile": { "include": ["src/a.css"] }`);
});

Deno.test("unembedded reads: the heuristic forms are found, never as certain", () => {
  assertEquals(
    reads(
      [
        `const CSS = new URL("./a.css", import.meta.url);`,
        `const P: string = fromFileUrl(new URL("./b.css", import.meta.url));`,
        `const DATA = join(import.meta.dirname!, "data");`,
        `export const x = () => Deno.readTextFile(CSS);`,
        `export const y = () => Deno.readTextFile(P);`,
        `export const z = (n: string) => Deno.readTextFile(join(DATA, n));`,
        `await Deno.readTextFile(join(import.meta.dirname!, "d", "e.txt"));`,
        `await Deno.readFile(resolve(dirname(import.meta.filename!), 'f.bin'));`,
        `await Deno.stat(new URL("./g.txt", import.meta.url));`,
      ].join("\n"),
    ),
    [
      "1:./a.css:w",
      "2:./b.css:w",
      "3:data:w",
      "7:d/e.txt:w",
      "8:f.bin:w",
      "9:./g.txt:w",
    ],
  );
});

Deno.test("unembedded reads: what is not a file read is not reported", () => {
  assertEquals(
    reads(
      [
        `// Deno.readTextFile(new URL("./comment.css", import.meta.url))`,
        `const doc = 'Deno.readTextFile(new URL("./string.css", import.meta.url))';`,
        `new Worker(new URL("./w.ts", import.meta.url), { type: "module" });`,
        `await import(new URL("./m.ts", import.meta.url).href);`,
        `const unused = new URL("./unused.css", import.meta.url);`,
        `const notRead = new URL("./page.html", import.meta.url); console.log(notRead);`,
        `await Deno.readTextFile(new URL(name, import.meta.url));`,
        `await Deno.readTextFile(new URL("./x.css", base));`,
        `await Deno.writeTextFile(new URL("./out.txt", import.meta.url), "x");`,
        `await fetch("https://example.com/x.json");`,
      ].join("\n"),
    ),
    [],
  );
});

Deno.test("unembedded reads: `// aio-ok(read): why` on the line or the line above silences it", () => {
  assertEquals(
    reads(
      [
        `await Deno.readTextFile(new URL("./a.css", import.meta.url)); // aio-ok(read): dev tool`,
        `// aio-ok: read — only under \`deno task dev\``,
        `await Deno.readTextFile(new URL("./b.css", import.meta.url));`,
        `await Deno.readTextFile(new URL("./c.css", import.meta.url)); // aio-ok: something else`,
      ].join("\n"),
    ),
    ["4:./c.css:E"],
  );
});

const tree: Record<string, "file" | "dir"> = {
  "style.css": "file",
  "data": "dir",
  "data/a.json": "file",
  "models": "dir",
  "models/m.bin": "file",
  "src/rud/serve.server.ts": "file",
  "src/rud/table.json": "file",
  "../shared/x.css": "file",
};
const judge = (content: string, included: string[]) =>
  unembeddedReads({
    modules: [{ path: "src/rud/serve.server.ts", content }],
    included,
    kind: (rel) => tree[rel] ?? null,
  }).map((f) => `${f.at} ${f.rel} ${f.why} ${f.certain ? "E" : "w"}`);

Deno.test("unembedded reads: a file on disk that nothing embeds is the finding; an included file, directory or graph module is covered", () => {
  const src =
    `await Deno.readTextFile(new URL("../../style.css", import.meta.url));\n` +
    `await Deno.readTextFile(new URL("../../data/a.json", import.meta.url));\n` +
    `await Deno.readTextFile(new URL("./table.json", import.meta.url));\n`;
  assertEquals(judge(src, ["dist/"]), [
    "src/rud/serve.server.ts:1 style.css unembedded E",
    "src/rud/serve.server.ts:2 data/a.json unembedded E",
    "src/rud/serve.server.ts:3 src/rud/table.json unembedded E",
  ]);
  assertEquals(
    judge(src, ["./style.css", "data", "src/rud/table.json"]),
    [],
    "a file, a containing directory (`compile.include` or `assets`), a graph module",
  );
});

Deno.test("unembedded reads: a typo is a warning, an outside file names the real fix, a directory with anything embedded in it is not judged", () => {
  assertEquals(
    judge(
      `await Deno.readTextFile(new URL("../../styel.css", import.meta.url));\n` +
        `await Deno.readTextFile(new URL("../../../shared/x.css", import.meta.url));\n` +
        `for await (const e of Deno.readDir(new URL("../../models/", import.meta.url))) e;\n` +
        `for await (const e of Deno.readDir(new URL("../../data/", import.meta.url))) e;\n`,
      ["data/a.json"],
    ),
    [
      "src/rud/serve.server.ts:1 styel.css missing w",
      "src/rud/serve.server.ts:2 ../shared/x.css outside E",
      "src/rud/serve.server.ts:3 models unembedded E",
    ],
  );
});

Deno.test("unembedded reads: the message is the exact deno.json edit — merged when include already exists", () => {
  const f = {
    at: "src/a.ts:3",
    spec: "../style.css",
    rel: "style.css",
    why: "unembedded" as const,
    certain: true,
  };
  assertStringIncludes(
    unembeddedReadMessage(f, []),
    `add "compile": { "include": ["style.css"] } to deno.json`,
  );
  assertStringIncludes(
    unembeddedReadMessage(f, ["models"]),
    `add "style.css" to deno.json "compile": { "include": ["models", "style.css"] }`,
  );
  assertStringIncludes(unembeddedReadMessage(f, []), "src/a.ts:3");
  assertStringIncludes(unembeddedReadMessage(f, []), "aio-ok(read)");
});

// ── the real build ──────────────────────────────────────────────────────────
Deno.test({
  name:
    "build e2e: a server read of an unembedded file fails the compile with the deno.json line; that line makes the binary's read work, and without it the read really fails",
  ignore: Deno.env.get("AIO_BUILD_E2E") !== "1",
  async fn() {
    const dir = await makeApp("counter", "build-e2e-reads-");
    const foreign = await tempDir("build-e2e-reads-cwd-");
    try {
      await Deno.mkdir(join(dir, "data"));
      await Deno.writeTextFile(join(dir, "data", "theme.txt"), "THEME-OK-4417");
      const readit = (mark: string) =>
        // Line 2 is GUARDED (a warning that names the guard); line 8 is not
        // (the refusal).
        `try {\n  console.log("READ " + await Deno.readTextFile(new URL("../data/theme.txt", import.meta.url)));\n` +
        `} catch (e) {\n  console.log("READ FAILED " + (e as Error).name);\n}\n` +
        `const TYPO = new URL("../data/thmee.txt", import.meta.url);\n` +
        `export const typo = () => Deno.readTextFile(TYPO);\n` +
        `export const raw = () => Deno.readTextFile(new URL("../data/theme.txt", import.meta.url));${mark}\n`;
      await Deno.writeTextFile(join(dir, "src", "readit.ts"), readit(""));
      await Deno.writeTextFile(
        join(dir, "src", "app.ts"),
        `import "./readit.ts";\n`,
        { append: true },
      );
      const run = async () => {
        // Not `placedBinary`: its "no extension" rule misses a Windows `.exe`.
        const bins = [...Deno.readDirSync(join(dir, "dist"))]
          .map((e) => e.name).filter((n) => n !== "manifest.json");
        assertEquals(bins.length, 1, bins.join(", "));
        const o = await new Deno.Command(join(dir, "dist", bins[0]!), {
          args: ["--version"],
          cwd: foreign,
          env: childEnv(),
          stdout: "piped",
          stderr: "piped",
        }).output();
        const d = new TextDecoder();
        return d.decode(o.stdout) + d.decode(o.stderr);
      };

      // 1. Refused, with file:line, the exact line to add, and the typo warned.
      const refused = await task(dir, "compile");
      const said = refused.out + refused.err;
      assert(refused.code !== 0, `the build passed:\n${said}`);
      assertStringIncludes(said, "src/readit.ts:8");
      assertStringIncludes(
        said,
        `"compile": { "include": ["data/theme.txt"] }`,
      );
      assertStringIncludes(said, "data/thmee.txt does not exist");

      // 2. The claim the refusal rests on: acknowledged instead of fixed, the
      //    binary builds and its read FAILS (from a foreign cwd).
      await Deno.writeTextFile(
        join(dir, "src", "readit.ts"),
        readit(" // aio-ok(read): this test proves the read fails"),
      );
      const acked = await task(dir, "compile");
      assertEquals(acked.code, 0, acked.out + acked.err);
      // The guarded read alone does not refuse the build — it is SAID.
      assertStringIncludes(acked.out + acked.err, "src/readit.ts:2");
      assertStringIncludes(
        acked.out + acked.err,
        "guarded by the try/catch around it",
      );
      assertStringIncludes(await run(), "READ FAILED NotFound");

      // 3. The line the refusal printed, added: builds, and the read works.
      await Deno.writeTextFile(join(dir, "src", "readit.ts"), readit(""));
      const cfgPath = join(dir, "deno.json");
      const cfg = JSON.parse(await Deno.readTextFile(cfgPath));
      cfg.compile = { include: ["data/theme.txt"] };
      await Deno.writeTextFile(cfgPath, JSON.stringify(cfg, null, 2));
      const fixed = await task(dir, "compile");
      assertEquals(fixed.code, 0, fixed.out + fixed.err);
      assertStringIncludes(await run(), "READ THEME-OK-4417");
    } finally {
      await dropTempDir(dir);
      await dropTempDir(foreign);
    }
  },
});
