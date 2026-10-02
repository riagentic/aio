// Convention guard: a test's dev server does not watch the live repo.
//
// `aio.run({…})` in dev (every in-process test is dev: `prod` comes from the
// process's own `--prod`, never from the config) starts the file watcher on
// `baseDir`, and with no `baseDir` that is the main module's directory — for a
// test, `tests/` itself; for a fixture app, `tests/fixtures/`. So a file SAVED
// there by anything else while the suite runs (another session, an editor, a
// formatter) starts a reload inside whichever test server is up: esbuild, a
// graph walk, a broadcast. `tests/shutdown-hung-onstop.test.ts` failed exactly
// that way — a save of an unrelated test file landed inside its 5 s close and
// the reload's esbuild child outlived the test.
//
// A call is fine when its config literal says where the app is or turns the
// watcher off — the two things `server-watcher.ts` reads:
//   · `baseDir` (a directory of the test's own), or
//   · `watch: false` (`startWatcher` opens nothing at all),
// written AFTER any spread, which could otherwise carry or clear either.
// `testServer()` needs neither: it defaults `baseDir` to a temp dir. The
// standalone runtime (`src/standalone-air.ts`) and the browser stub have no
// watcher. A config that is not a literal cannot be read here, so it is on
// the counted allow-list below, with the reason it is safe.
import { assertEquals } from "@std/assert";
import { argumentSpan, codeMask } from "../aiol/scan.ts";

type Verdict = "ok" | "no-server" | "offender" | "opaque";
type Call = { line: number; verdict: Verdict; why: string };

/** Modules whose `aio.run` starts no server, so no watcher. */
const NO_SERVER = /(^|\/)src\/(standalone-air\.ts|browser\/)/;

/** The code of `src[a, b)`: comments dropped, layout collapsed. */
function code(src: string, mask: Uint8Array, a: number, b: number): string {
  let s = "";
  for (let i = a; i < b; i++) {
    s += mask[i] === 1 ? src[i] : " ";
  }
  return s.replace(/\/\/|\/\*|\*\//g, " ").replace(/\s+/g, " ").trim();
}

/** Every module this file binds `name` to — a named import (static or
 *  destructured from `await import`), or a namespace. */
function boundTo(src: string, name: string): string[] {
  const out: string[] = [];
  const has = new RegExp(`(^|[\\s,{])${name}([\\s,:}]|$)`);
  for (
    const m of src.matchAll(
      /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*["'`]([^"'`]+)["'`]/g,
    )
  ) if (has.test(m[1]!)) out.push(m[2]!);
  for (
    const m of src.matchAll(
      /\{([^}]*)\}\s*=\s*await\s+import\(\s*["'`]([^"'`]+)["'`]/g,
    )
  ) if (has.test(m[1]!)) out.push(m[2]!);
  for (
    const m of src.matchAll(
      new RegExp(
        `import\\s*\\*\\s*as\\s+${name}\\s+from\\s*["'\`]([^"'\`]+)["'\`]`,
        "g",
      ),
    )
  ) out.push(m[1]!);
  for (
    const m of src.matchAll(
      new RegExp(
        `\\b${name}\\s*=\\s*await\\s+import\\(\\s*["'\`]([^"'\`]+)["'\`]`,
        "g",
      ),
    )
  ) out.push(m[1]!);
  return out;
}

/** Does this `aio` — at `at`, the `a` of `aio.run` — come from a runtime with
 *  no server? Only when EVERY binding the file has for it says so. */
function noServer(src: string, at: number): boolean {
  let b = at - 1;
  while (b >= 0 && /\s/.test(src[b]!)) b--;
  let from: string[];
  if (src[b] === ".") {
    // `X.aio.run(` or `(await import("M")).aio.run(`
    b--;
    while (b >= 0 && /\s/.test(src[b]!)) b--;
    if (src[b] === ")") {
      const open = src.lastIndexOf("import(", b);
      const m = open < 0
        ? null
        : /^import\(\s*["'`]([^"'`]+)["'`]/.exec(src.slice(open, b));
      from = m ? [m[1]!] : [];
    } else {
      let a = b;
      while (a >= 0 && /[\w$]/.test(src[a]!)) a--;
      from = boundTo(src, src.slice(a + 1, b + 1));
    }
  } else {
    from = boundTo(src, "aio");
  }
  return from.length > 0 && from.every((m) => NO_SERVER.test(m));
}

/** Every `aio.run` CALL in `src`, judged. Pure. */
function classify(src: string): Call[] {
  const mask = codeMask(src);
  const out: Call[] = [];
  for (const m of src.matchAll(/\baio\s*\.\s*run\b/g)) {
    const at = m.index!;
    if (mask[at] !== 1) continue; // prose, or source quoted in a string
    if (/\btypeof\s*$/.test(src.slice(Math.max(0, at - 12), at))) continue;
    const line = src.slice(0, at).split("\n").length;
    let p = at + m[0].length;
    while (/\s/.test(src[p] ?? "")) p++;
    if (src[p] === "<") { // run<State>(…)
      let depth = 0;
      for (; p < src.length; p++) {
        if (src[p] === "<") depth++;
        else if (src[p] === ">" && --depth === 0) break;
      }
      p++;
      while (/\s/.test(src[p] ?? "")) p++;
    }
    if (src[p] !== "(") {
      out.push({ line, verdict: "opaque", why: "aio.run taken as a value" });
      continue;
    }
    if (noServer(src, at)) {
      out.push({ line, verdict: "no-server", why: "" });
      continue;
    }
    const span = argumentSpan(src, p, 0);
    let [a, b] = span ?? [p + 1, p + 1];
    while (a < b && (/\s/.test(src[a]!) || mask[a] !== 1)) a++;
    if (src[a] !== "{") {
      const what = code(src, mask, a, Math.min(b, a + 40)) || "(none)";
      out.push({ line, verdict: "opaque", why: `config ${what}` });
      continue;
    }
    // The literal's own entries — depth 1, in order: the LAST word wins.
    const entries: string[] = [];
    let depth = 0, start = a + 1, end = a;
    for (let i = a; i < b; i++) {
      if (mask[i] !== 1) continue;
      const ch = src[i]!;
      if ("{[(".includes(ch)) depth++;
      else if ("}])".includes(ch)) {
        if (--depth === 0) {
          end = i;
          break;
        }
      } else if (ch === "," && depth === 1) {
        entries.push(code(src, mask, start, i));
        start = i + 1;
      }
    }
    entries.push(code(src, mask, start, end));
    let verdict: Verdict = "offender";
    let why = "no baseDir and no watch: false";
    for (const e of entries) {
      if (e.startsWith("...")) {
        verdict = "opaque";
        why = `a spread after it (${e.slice(0, 24)}) can carry or clear it`;
      } else if (/^baseDir(\s*:|$)/.test(e) || /^watch\s*:\s*false$/.test(e)) {
        verdict = "ok";
        why = "";
      }
    }
    out.push({ line, verdict, why });
  }
  return out;
}

const judge = (src: string) => classify(src).map((c) => c.verdict);

// ── The instrument, on text ────────────────────────────────────────────────

Deno.test("watch guard: a boot with no baseDir and no watch: false is seen", () => {
  assertEquals(
    judge(`
      import { aio } from "../mod.ts";
      await aio.run({ cells: [c], port: freePort() });
      await aio.run<State>({ cells: [c] });
      await aio.run({});
      await aio.run({ cells: [c], watch: ["src"] });
      await aio.run({ nested: { a: 1, watch: false, baseDir: dir, b: 2 } });
    `),
    ["offender", "offender", "offender", "offender", "offender"],
  );
});

Deno.test("watch guard: baseDir or watch: false in the literal is enough", () => {
  assertEquals(
    judge(`
      import { aio } from "../mod.ts";
      await aio.run({ cells: [c], baseDir: dir });
      await aio.run({ baseDir, cells: [c] });
      await aio.run({ cells: [c], watch: false });
      await aio.run({
        // why
        watch: false, // and why
        cells: [c],
      } as any);
      await aio.run({
        cells: [c],
        // Its own directory, not the live \`tests/\`: it's "quoted" prose.
        baseDir: dir,
      });
    `),
    ["ok", "ok", "ok", "ok", "ok"],
  );
});

Deno.test("watch guard: a spread or a variable config cannot be read — it is not passed", () => {
  assertEquals(
    judge(`
      import { aio } from "../mod.ts";
      await aio.run({ baseDir: dir, ...extra });
      await aio.run({ watch: false, ...(x ? { a: 1 } : {}) });
      await aio.run({ ...extra });
      await aio.run(cfg);
      await aio.run(config("a", dir) as never);
      const run = aio.run;
      await aio.run({ ...extra, watch: false });
      await aio.run({ ...extra, baseDir: dir });
    `),
    ["opaque", "opaque", "opaque", "opaque", "opaque", "opaque", "ok", "ok"],
  );
});

Deno.test("watch guard: quoted source, prose and types are not calls", () => {
  assertEquals(
    judge(`
      import { aio } from "../mod.ts";
      // aio.run({ cells }) is what this used to do
      const app = \`await aio.run({ cells: [c] });\`;
      const s = "aio.run({})";
      type App = Awaited<ReturnType<typeof aio.run>>;
      const o = { x: 1 } as Parameters<typeof aio.run>[0];
    `),
    [],
  );
});

Deno.test("watch guard: only a runtime with no server is exempt, and only when every binding says so", () => {
  assertEquals(
    judge(`
      import * as standalone from "../src/standalone-air.ts";
      await standalone.aio.run({ cells: [c] });
      const sa = await import("../src/standalone-air.ts");
      await sa.aio.run({ cells: [c] });
      await (await import("../src/standalone-air.ts")).aio.run({ cells: [c] });
      const srv = await import("../mod.ts");
      await srv.aio.run({ cells: [c] });
      await unknown.aio.run({ cells: [c] });
    `),
    ["no-server", "no-server", "no-server", "offender", "offender"],
  );
  assertEquals(
    judge(`
      import { aio } from "../src/standalone-air.ts";
      await aio.run({ cells: [c] });
    `),
    ["no-server"],
  );
  // One server binding in the file and the bare name is the server's.
  assertEquals(
    judge(`
      import { aio } from "../src/standalone-air.ts";
      { const { aio } = await import("../mod.ts"); await aio.run({}); }
    `),
    ["offender"],
  );
});

// ── The suite ──────────────────────────────────────────────────────────────

/** Calls whose config is not a literal with the answer in it. Each is here
 *  because the config it is handed carries `baseDir` or `watch: false` — and
 *  not on its word: `proof` is the code that makes it so, and it must still be
 *  in the file. The COUNT is exact, so a new call is not waved through. */
type Allowed = Record<string, { calls: number; why: string; proof: RegExp }>;
const ALLOWED: Allowed = {
  "tests/closed-app-release-scoped.test.ts": {
    calls: 4,
    why: "`config(id, dir, cells)` in the file sets `watch: false`",
    proof:
      /const config = \([^)]*\) => \(\{\n(?:  .*\n)*?  watch: false,\n\}\);/,
  },
};

/** What one file's calls come to: the ones to fix, and how many cannot be
 *  read. A call that cannot be read is an offender unless the file is allowed
 *  — for exactly that many, with its proof present. Pure. */
function report(
  path: string,
  src: string,
  allowed: Allowed,
): { calls: number; offenders: string[]; opaque: number } {
  const offenders: string[] = [];
  const all = classify(src);
  const opaque = all.filter((c) => c.verdict === "opaque");
  const a = allowed[path];
  for (const c of all) {
    if (c.verdict === "offender" || (c.verdict === "opaque" && !a)) {
      offenders.push(`${path}:${c.line} — ${c.why}`);
    }
  }
  if (a && opaque.length !== a.calls) {
    offenders.push(
      `${path} — ${opaque.length} call(s) cannot be read, ${a.calls} allowed`,
    );
  }
  if (a && !a.proof.test(src)) {
    offenders.push(`${path} — allowed because ${a.why}, which is gone`);
  }
  return { calls: all.length, offenders, opaque: opaque.length };
}

Deno.test("watch guard: the allow-list is exact and proven, never a waiver", () => {
  const src = `
    import { aio } from "../mod.ts";
    const cfg = { cells: [c], watch: false };
    await aio.run(cfg);
  `;
  const allow = (calls: number, proof: RegExp): Allowed => ({
    "t.ts": { calls, why: "cfg sets watch: false", proof },
  });
  assertEquals(report("t.ts", src, allow(1, /watch: false \}/)).offenders, []);
  // Not allowed at all; allowed for fewer; the proof no longer in the file.
  assertEquals(report("t.ts", src, {}).offenders.length, 1);
  assertEquals(
    report("t.ts", src + "await aio.run(cfg);", allow(1, /watch: false \}/))
      .offenders,
    ["t.ts — 2 call(s) cannot be read, 1 allowed"],
  );
  assertEquals(
    report("t.ts", src, allow(1, /baseDir: dir/)).offenders,
    ["t.ts — allowed because cfg sets watch: false, which is gone"],
  );
  // …and an allowed file's readable offender is still an offender.
  assertEquals(
    report("t.ts", src + "await aio.run({});", allow(1, /watch: false \}/))
      .offenders.length,
    1,
  );
});

function* sources(dir: string): Generator<string> {
  for (const e of Deno.readDirSync(dir)) {
    const path = `${dir}/${e.name}`;
    if (e.isDirectory) {
      if (e.name !== "node_modules") yield* sources(path);
    } else if (e.isFile && /\.tsx?$/.test(e.name)) yield path;
  }
}

/** The whole scan: every file's report, summed. Pure but for `read`. */
function scan(
  paths: string[],
  read: (path: string) => string,
  allowed: Allowed,
): { calls: number; offenders: string[] } {
  let calls = 0;
  const offenders: string[] = [];
  for (const path of paths) {
    const r = report(path, read(path), allowed);
    calls += r.calls;
    offenders.push(...r.offenders);
  }
  for (const f of Object.keys(allowed)) {
    if (!paths.includes(f)) offenders.push(`${f} — allowed, and not there`);
  }
  return { calls, offenders };
}

Deno.test("watch guard: one offending file among clean ones turns the scan red", () => {
  const files: Record<string, string> = {
    "a.ts": `import { aio } from "../mod.ts"; await aio.run({ baseDir: d });`,
    "b.ts": `import { aio } from "../mod.ts"; await aio.run({ cells: [c] });`,
    "c.ts": `const s = "nothing here";`,
  };
  const r = scan(Object.keys(files), (p) => files[p]!, {});
  assertEquals(r.calls, 2);
  assertEquals(r.offenders, ["b.ts:1 — no baseDir and no watch: false"]);
  assertEquals(
    scan(["a.ts"], (p) => files[p]!, {
      "gone.ts": { calls: 1, why: "x", proof: /x/ },
    }).offenders,
    ["gone.ts — allowed, and not there"],
  );
});

Deno.test("tests: no test server watches the live repo", () => {
  const paths = [...sources("tests")].sort().filter((p) =>
    p !== "tests/test-servers-do-not-watch-the-repo.test.ts"
  );
  const { calls, offenders } = scan(
    paths,
    (p) => Deno.readTextFileSync(p),
    ALLOWED,
  );
  // A guard that quietly scans nothing reports the suite clean.
  assertEquals(
    paths.some((p) => p.split("/").length > 2),
    true,
    "the scan reached tests/**/ subdirectories",
  );
  assertEquals(calls > 300, true, `only ${calls} aio.run calls were read`);
  assertEquals(
    offenders,
    [],
    "a dev server with no `baseDir` watches tests/ itself, and a file saved " +
      "there mid-run reloads it. Pass `baseDir` (a temp dir) or `watch: " +
      "false`, after any spread:\n  " + offenders.join("\n  "),
  );
});
