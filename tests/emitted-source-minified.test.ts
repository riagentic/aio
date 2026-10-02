// A function whose SOURCE leaves its module must still run where it lands —
// after `build.minify` (ON by default) has rewritten the module it came from.
//
// Three places in aio take `fn.toString()` and rebuild it elsewhere: the
// Electron main script (generated CJS), the video encoder's page script, and
// `blocking(id, fn)`'s worker. Each was tested against the UN-minified module
// — "the script includes the function's text" — and each shipped broken:
//
//   · the reconnect curve read two module constants the minifier renamed
//     (`s is not defined` on a dropped socket: the window never reconnected);
//   · `keepNames` wrapped every nested named function, arrow and class in a
//     helper declared at module scope, under a name that differs per module
//     (`t is not defined` in the worker, in every compiled build).
//
// So these tests take each module FROM A MINIFIED COPY, generate what the
// build generates, and EVALUATE it. A string comparison cannot fail here.
import { assert, assertEquals, assertRejects } from "@std/assert";
import { fromFileUrl, join, relative, toFileUrl } from "@std/path";
import { walk } from "@std/fs/walk";
import * as esbuild from "esbuild";
import {
  minifiedCopy,
  minifiedModule,
  stopEsbuild,
} from "./minified-copy-helper.ts";
import {
  KEEP_NAME,
  minifyModule,
  Unminifiable,
} from "../src/build/minify-server.ts";
import { createBlockingPool } from "../src/state/blocking.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import {
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
} from "../src/protocol/transport-shared.ts";

const ROOT = fromFileUrl(new URL("../", import.meta.url));

/** EVERY place in src/ that emits a function's source, and the test below
 *  that runs it minified. A new site fails the guard until it is listed —
 *  and listing it means writing the test that evaluates it. */
const SITES: Record<string, string[]> = {
  "src/electron/electron-uds.ts": ["backoffDelay", "createLineReader"],
  "src/media/encoder.ts": ["fitFrame"],
  "src/state/blocking.ts": ["fn"],
};

const ID = "[A-Za-z_$][\\w$]*";
// A function's source taken to be put somewhere else: interpolated into a
// template, or assigned/passed as a value. (`x.toString()` on a number or a
// URL is followed by a method call or sits in an expression — not matched.)
const EMIT = new RegExp(
  `(?:\\$\\{\\s*|\\bsrc:\\s*)(${ID})\\.toString\\(\\)\\s*[},]`,
  "g",
);
// The other spellings of the same thing: `String(f)`, `${"" + f}`, `${f}`.
// These are ordinary code for a string or a number, so they count only when
// the name is a function declared at the top of that file or imported into it.
const COERCED = new RegExp(
  `\\bString\\(\\s*(${ID})\\s*\\)|` +
    `\\$\\{\\s*(?:""|'')\\s*\\+\\s*(${ID})\\s*\\}|` +
    `\\$\\{\\s*(${ID})\\s*\\+\\s*(?:""|'')\\s*\\}`,
  "g",
);
// …and a bare `${f}` only in the files that already emit source (SITES): a
// parameter there rarely shares a name with a function, where across all of
// src/ it often does (`msg`, `count`). A bare interpolation that starts a NEW
// emitting file is the one spelling this guard does not see.
const BARE = new RegExp(`\\$\\{\\s*(${ID})\\s*\\}`, "g");
const TOP_FN = new RegExp(
  `^(?:export\\s+)?(?:async\\s+)?(?:function\\*?\\s+(${ID})\\s*[(<]|` +
    `const\\s+(${ID})\\s*(?::[^=]+)?=\\s*(?:async\\s*)?` +
    `(?:function\\b|\\(|${ID}\\s*=>))`,
  "gm",
);
const IMPORTED = /import\s*\{([^}]*)\}\s*from/g;

/** The functions whose source `text` emits, by name, in order. `allFns`: every
 *  top-level function name in src/ (an import is a function when it is one). */
function emittedIn(
  text: string,
  allFns: ReadonlySet<string>,
  bare: boolean,
): string[] {
  const fns = new Set(topFns(text));
  for (const m of text.matchAll(IMPORTED)) {
    for (const part of m[1]!.split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop()!;
      if (allFns.has(name)) fns.add(name);
    }
  }
  const coerced = [COERCED, ...(bare ? [BARE] : [])].flatMap((re) =>
    [...text.matchAll(re)].map((m) => m[1] ?? m[2] ?? m[3]!)
  ).filter((n) => fns.has(n));
  return [...[...text.matchAll(EMIT)].map((m) => m[1]!), ...coerced];
}
const topFns = (text: string) =>
  [...text.matchAll(TOP_FN)].map((m) => m[1] ?? m[2]!);

Deno.test("emitted source: every `fn.toString()` emission in src/ is a listed, evaluated site", async () => {
  const texts: Record<string, string> = {};
  for await (
    const e of walk(join(ROOT, "src"), {
      includeDirs: false,
      exts: [".ts", ".tsx"],
      skip: [/node_modules/],
    })
  ) {
    texts[relative(ROOT, e.path)] = await Deno.readTextFile(e.path);
  }
  const allFns = new Set(Object.values(texts).flatMap(topFns));
  const found: Record<string, string[]> = {};
  for (const [file, text] of Object.entries(texts)) {
    const names = emittedIn(text, allFns, file in SITES);
    if (names.length) found[file] = names;
  }
  assertEquals(
    found,
    SITES,
    "a function's source is emitted somewhere this file does not evaluate " +
      "it — add the site to SITES and a test that RUNS it from a minified copy",
  );
});

Deno.test("emitted source: the guard sees every spelling of 'this function as text'", () => {
  const all = new Set(["backoffDelay"]);
  const decl = "function backoffDelay(r: number) { return r; }\n";
  for (
    const [emit, bare] of [
      ["`${backoffDelay.toString()}`", false],
      ["{ src: backoffDelay.toString() }", false],
      ["`${String(backoffDelay)}`", false],
      ['`${"" + backoffDelay}`', false],
      ['`${backoffDelay + ""}`', false],
      ["`${backoffDelay}`", true],
    ] as const
  ) {
    assertEquals(
      emittedIn(`${decl}const s = ${emit};`, all, bare),
      ["backoffDelay"],
      emit,
    );
    // Imported counts as declared here.
    assertEquals(
      emittedIn(
        `import { backoffDelay } from "./t.ts";\nconst s = ${emit};`,
        all,
        bare,
      ),
      ["backoffDelay"],
      emit,
    );
  }
  // A string of the same shape is not a function's source.
  assertEquals(
    emittedIn("const s = (n: number) => `${n} ${String(n)}`;", all, true),
    [],
  );
});

Deno.test("emitted source: the Electron main script's reconnect curve and line reader RUN when aio is minified", async () => {
  await using copy = await minifiedCopy("src/electron/electron-uds.ts");
  const { electronMainScriptUDS } = await copy.load(
    "src/electron/electron-uds.ts",
  );
  const script: string = electronMainScriptUDS(
    "http://localhost:3000",
    "/tmp/t.sock",
    { title: "minified" },
  );
  // The block the generator emits, exactly as generated — every emitted
  // function and the call sites' own wiring — up to the first connection state.
  const from = script.indexOf("const BACKOFF_BASE_MS");
  const to = script.indexOf("let retry = 0");
  assert(from > 0 && to > from, "the emitted block is not where this looks");
  // (KEEP_NAME shadowed: Electron's main process is not this process, and
  // has none of the globals a minified aio module defines here.)
  const run = new Function(
    KEEP_NAME,
    script.slice(from, to) +
      `;return {
        delays: [0, 1, 2, 3, 9].map((r) => backoffDelay(r)),
        lines: [lineBuf.push("a\\nb"), lineBuf.push("c\\n"), lineBuf.pending()],
      };`,
  ) as () => { delays: number[]; lines: unknown[] };
  const { delays, lines } = run();
  [0, 1, 2, 3, 9].forEach((retry, i) => {
    const base = Math.min(BACKOFF_BASE_MS * 2 ** retry, BACKOFF_MAX_MS);
    assert(
      delays[i]! >= base * 0.8 && delays[i]! <= base * 1.2,
      `retry ${retry}: ${delays[i]} is not ${base} ±20%`,
    );
  });
  assertEquals(lines, [["a"], ["bc"], 0]);
});

Deno.test("emitted source: the video encoder's page script RUNS its inlined fitFrame when aio is minified", async () => {
  await using copy = await minifiedCopy("src/media/encoder.ts");
  const { openPageEncoder } = await copy.load("src/media/encoder.ts");
  // A page, as far as the script can tell: the WebCodecs surface it touches.
  const drawn: unknown[][] = [];
  const page: Record<string, unknown> = {
    VideoEncoder: class {
      static isConfigSupported = () => Promise.resolve({ supported: true });
      configure() {}
      encode() {}
    },
    OffscreenCanvas: class {
      getContext() {
        return {
          fillRect() {},
          drawImage: (_bmp: unknown, ...at: unknown[]) => drawn.push(at),
        };
      }
    },
    VideoFrame: class {
      close() {}
    },
    createImageBitmap: () =>
      Promise.resolve({ width: 101, height: 100, close() {} }),
  };
  // The page's scope: this process's globals, MINUS the name helper a
  // minified aio module defines here — a page has never loaded one.
  const inPage = new Function(KEEP_NAME, "x", "return eval(x)").bind(
    null,
    undefined,
  ) as (expression: string) => unknown;
  const g = globalThis as Record<string, unknown>;
  const saved = Object.keys(page).map((k) => [k, g[k]] as const);
  Object.assign(g, page);
  try {
    const cdp = {
      call: async (method: string, p?: { expression?: string }) => {
        if (method === "Page.getFrameTree") {
          return { frameTree: { frame: { id: "f" } } };
        }
        if (method === "Page.createIsolatedWorld") {
          return { executionContextId: 1 };
        }
        try {
          return { result: { value: await inPage(p!.expression!) } };
        } catch (e) {
          return { exceptionDetails: { text: String(e) } };
        }
      },
    };
    const enc = await openPageEncoder(cdp, "webm", 101, 100);
    await enc.add([{ image: btoa("x"), us: 0, key: true }]);
    // 101×100 into a 100×100 video: the odd pixel is CROPPED, drawn 1:1.
    assertEquals(drawn, [[0, 0, 101, 100]]);
  } finally {
    for (const [k, v] of saved) v === undefined ? delete g[k] : (g[k] = v);
    delete g.__aioVideo;
  }
});

/** What an app writes: a self-contained function with helpers of its own —
 *  an arrow const, a function declaration, a class. */
const APP = `
export const work = (n: unknown) => {
  const square = (x: number) => x * x;
  function total(k: number) {
    let t = 0;
    for (let i = 0; i < k; i++) t += square(i);
    return t;
  }
  class Tally { constructor(public v: number) {} }
  return [new Tally(total(n as number)).v, square.name, total.name, Tally.name];
};
export function named() {}
`;
const WORKED = [285, "square", "total", "Tally"];

Deno.test("emitted source: a minified function's source runs in a scope that has ONLY the one global name helper", async () => {
  try {
    const src: string = (await minifiedModule(APP)).work.toString();
    const fn = new Function(
      KEEP_NAME,
      `"use strict"; return (${src});`,
    )((f: object, name: string) =>
      Object.defineProperty(f, "name", { value: name, configurable: true })
    );
    assertEquals(fn(10), WORKED);
    // …and the names everything else reads are still the written ones.
    const mod = await minifiedModule(APP);
    assertEquals(mod.named.name, "named");
    // No module-scope helper under a per-module name is left to lean on.
    const code = await minifyModule(esbuild, "/app/mod.ts", APP);
    assert(
      !/\(\w+,\s*\w+\)\s*=>\s*\w+\(\w+,\s*"name"/.test(code),
      `esbuild's own per-module name helper survived:\n${code}`,
    );
  } finally {
    await stopEsbuild();
  }
});

Deno.test("emitted source: blocking() runs a MINIFIED function with nested named helpers — un-minified aio, and a minified worker", async () => {
  const dir = await tempDir("emitted-worker-");
  const pool = createBlockingPool({ size: 1 });
  let worker: Worker | undefined;
  try {
    const { work } = await minifiedModule(APP);
    // aio un-minified (a remote import is never minified), the app minified.
    assertEquals(await pool.run("w", work, 10), WORKED);
    // The worker module as a compiled build ships it. (A `.js` copy: a `.ts`
    // worker is type-checked on spawn, and minified text has no types.)
    const at = join(dir, "blocking-worker.js");
    await Deno.writeTextFile(
      at,
      await minifyModule(
        esbuild,
        "blocking-worker.ts",
        await Deno.readTextFile(join(ROOT, "src/state/blocking-worker.ts")),
      ),
    );
    worker = new Worker(toFileUrl(at), { type: "module" });
    const reply = new Promise((ok) => worker!.onmessage = (e) => ok(e.data));
    worker.postMessage({ n: 1, src: work.toString(), arg: 10 });
    assertEquals(await reply, { n: 1, ok: true, data: WORKED });
  } finally {
    worker?.terminate();
    await pool.dispose();
    await stopEsbuild();
    await dropTempDir(dir);
  }
});

Deno.test("emitted source: a module binding named `value` or `target` does not bring esbuild's per-module helper back", async () => {
  // esbuild then numbers the helper's own parameters
  // (`(target, value2) => … { value: value2 }`), and a helper that is not
  // recognised stays in the module — the `blocking()` failure again.
  const pool = createBlockingPool({ size: 1 });
  try {
    for (
      const own of [
        "export const value = 42;",
        "export function target() {}",
        "export class target {} export const value = 1;",
        'import { join as value } from "node:path"; export const v = value;',
      ]
    ) {
      const { work } = await minifiedModule(own + APP);
      assertEquals(await pool.run("w", work, 10), WORKED, own);
    }
  } finally {
    await pool.dispose();
    await stopEsbuild();
  }
});

Deno.test("emitted source: a module that cannot be minified safely is REFUSED by name, never minified wrong", async () => {
  try {
    const refused = (src: string, why: string) =>
      assertRejects(
        () => minifyModule(esbuild, "/app/mod.ts", src),
        Unminifiable,
        why,
      );
    // The module's own `__aioName`: the kept-name calls would land on it.
    await refused(
      `const ${KEEP_NAME} = () => "mine"; function f() {} export const out = [${KEEP_NAME}(), f.name];`,
      KEEP_NAME,
    );
    await refused(
      `export const out = ((${KEEP_NAME}: number) => { const g = () => 1; return [g.name, ${KEEP_NAME}]; })(7);`,
      KEEP_NAME,
    );
    // A mention is not a use: aio's own two modules that spell it, a string,
    // a property read.
    for (
      const f of ["src/state/blocking-worker.ts", "src/build/minify-server.ts"]
    ) {
      const code = await minifyModule(
        esbuild,
        f,
        await Deno.readTextFile(join(ROOT, f)),
      );
      assert(code.length > 0, f);
    }
    const mentions = await minifiedModule(
      `export function f() { return ["${KEEP_NAME}", typeof (globalThis as Record<string, unknown>).${KEEP_NAME}]; }`,
    );
    assertEquals(mentions.f(), [KEEP_NAME, "function"]);
    // A helper line this build does not know (another esbuild's print).
    const odd = {
      transform: (src: string, o: { keepNames?: boolean }) =>
        Promise.resolve({
          code: o.keepNames
            ? 'var __name = (t, v, extra) => __defProp(t, "name", { value: v });\n' +
              src
            : src,
        }),
    };
    await assertRejects(
      () => minifyModule(odd, "/app/mod.js", "export const a = 1;"),
      Unminifiable,
      "not recognised",
    );
  } finally {
    await stopEsbuild();
  }
});

Deno.test("blocking: a named function expression reads its OWN name in the worker, minified or not", async () => {
  const pool = createBlockingPool({ size: 1 });
  try {
    // Minified, the source is `function e(){return e.name}`.
    const { work } = await minifiedModule(
      "export const work = function count() { return count.name; };",
    );
    assert(!work.toString().includes("count"), work.toString());
    assertEquals(await pool.run("n", work), "count");
    assertEquals(
      await pool.run("n", function plain() {
        return plain.name;
      }),
      "plain",
    );
  } finally {
    await pool.dispose();
    await stopEsbuild();
  }
});

Deno.test("blocking: a function that is NOT self-contained says so, not just `x is not defined`", async () => {
  const outer = 2;
  const pool = createBlockingPool({ size: 1 });
  try {
    const e = await assertRejects(
      () => pool.run("leaky", (n) => (n as number) * outer, 1),
      Error,
      "outer is not defined",
    );
    assert(e.message.includes("SELF-CONTAINED"), e.message);
    assert(e.message.includes("pass it as the argument"), e.message);
    // Any other error is the function's own, word for word.
    await assertRejects(
      () =>
        pool.run("own", () => {
          throw new ReferenceError("my own words");
        }),
      Error,
      "my own words",
    ).then((own) => assertEquals(own.message, "my own words"));
  } finally {
    await pool.dispose();
  }
});
