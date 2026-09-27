// Convention guard: a framework-spawned `git` may NEVER prompt.
//
// The bug this pins (2026-09-02): GitHub rate-limits anonymous HTTPS git and
// answers a throttled fetch of a PUBLIC repo with an auth challenge. Plain git
// then asks "Username for 'https://github.com':" on the user's terminal —
// which surfaced inside `am pin <tag>` and `am update`, intermittently (4 of
// 5 runs prompted, the 5th passed). It looked like aio demanded GitHub
// credentials; aio never needs any. In a script the same prompt is a silent
// hang. No test can catch the prompt itself — the suite has no TTY and never
// talks to github.com — so the invariant is gated HERE, at the spawn site:
// every `Deno.Command("git", …)` in src/ must carry `GIT_NO_PROMPT_ENV`
// (git fails loudly instead of asking) and `stdin: "null"` (nothing to read
// even if something still tries).
import { assertEquals } from "@std/assert";
import { codeMask } from "../src/diagnostics/code-mask.ts";

const SPAWN = /new Deno\.Command\(\s*"git"/g;
// The options object follows the match; the markers live within it. 1500
// chars covers the largest current site (gitLsRemote, whose options carry a
// ~700-char comment) with room to spare.
const WINDOW = 1500;
// ANY call or argv that starts with "git" — `run("git", …)`, `spawn(["git",
// …])`, whatever the helper is called and wherever in src/ it lives. The rule
// scanned only `run("git"` inside src/am/, so the updates rebuild's
// `run("git", ["clone", …])` (src/server) prompted, hung and outlived the app.
const ANY_GIT = /[([]\s*"git"\s*[,\])]/g;
const isAm = (p: string) => p === "src/am.ts" || p.startsWith("src/am/");
// Outside am, THE spawn env is `gitOwnRepoEnv(` (no-prompt + an inherited
// GIT_DIR & co. stripped: an app started from a git hook otherwise had its
// update clone's `rev-parse HEAD` answer the hook's repo). A site that means
// to honour the inherited repo says so, with its reason, by this marker.
const guardFor = (p: string) => isAm(p) ? "gitEnvFor(" : "gitOwnRepoEnv(";
const INHERITS = "aio-git-env-inherited:";
const guarded = (p: string, opts: string) =>
  opts.includes(guardFor(p)) ||
  (!isAm(p) && opts.includes(INHERITS) && opts.includes("GIT_NO_PROMPT_ENV"));

async function* tsFiles(dir: string): AsyncGenerator<string> {
  for await (const e of Deno.readDir(dir)) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory) yield* tsFiles(p);
    else if (e.isFile && /\.tsx?$/.test(e.name)) yield p;
  }
}

/** The spawn's OWN call: from the match to the bracket closing its call —
 *  `(` / `[` counted on the code mask, so a bracket in a string or comment
 *  does not count. A fixed window reached into the NEXT spawn, and so did
 *  "up to the next `})`" for a call whose options are a variable
 *  (`run("git", ["fetch"], opts);`): a marker there exempted this one. */
const callAt = (src: string, at: number) => {
  const mask = codeMask(src);
  // `spawn(["git", …])`: the call is the `(` just before the argv's `[`.
  let open = src.indexOf(src[at] === "[" ? "[" : "(", at);
  let k = open - 1;
  while (k >= 0 && /\s/.test(src[k]!)) k--;
  if (src[open] === "[" && src[k] === "(") open = k;
  for (let i = open, depth = 0; i < src.length; i++) {
    if (!mask[i]) continue;
    if (src[i] === "(" || src[i] === "[") depth++;
    else if ((src[i] === ")" || src[i] === "]") && --depth === 0) {
      return src.slice(at, i + 1);
    }
  }
  return src.slice(at, at + WINDOW);
};

/** Every unguarded git spawn in one file's source. */
function offendersIn(path: string, raw: string): string[] {
  const offenders: string[] = [];
  // Template literals are DATA (fixture source, generated scripts), not
  // code this file runs — blanked with offsets kept, as in
  // tests/test-ports-are-free.test.ts.
  const src = raw.replace(
    /`(?:[^`\\]|\\.)*`/g,
    (m) => m.replace(/[^\n]/g, " "),
  );
  // Every helper form spawns git too.
  for (const m of src.matchAll(ANY_GIT)) {
    const line = src.slice(0, m.index).split("\n").length;
    if (!guarded(path, callAt(src, m.index))) {
      offenders.push(
        `${path}:${line} — git spawned without ${guardFor(path)}`,
      );
    }
  }
  for (const m of src.matchAll(SPAWN)) {
    const opts = callAt(src, m.index);
    const line = src.slice(0, m.index).split("\n").length;
    // `am` spawns through `gitEnvFor` (src/am/am-versions.ts), which
    // carries GIT_NO_PROMPT_ENV AND strips an inherited GIT_DIR & co. — a
    // hook's environment otherwise pointed am's git at ANOTHER repo.
    if (!guarded(path, opts)) {
      offenders.push(`${path}:${line} — missing ...${guardFor(path)})`);
    }
    if (!/stdin:\s*"null"/.test(opts)) {
      offenders.push(`${path}:${line} — missing stdin: "null"`);
    }
  }
  return offenders;
}

Deno.test("git-never-prompts: a marker in the NEXT spawn never exempts this one", () => {
  const next = `  const r = await new Deno.Command("git", {\n` +
    `    args: ["status"],\n    stdin: "null",\n` +
    `    // aio-git-env-inherited: this repo\n` +
    `    env: GIT_NO_PROMPT_ENV,\n  }).output();\n`;
  assertEquals(offendersIn("src/server/x.ts", next), []);
  assertEquals(
    offendersIn(
      "src/server/x.ts",
      `new Deno.Command("git", { args: ["fetch"], stdin: "null" }).output();\n` +
        next,
    ),
    [
      "src/server/x.ts:1 — git spawned without gitOwnRepoEnv(",
      "src/server/x.ts:1 — missing ...gitOwnRepoEnv()",
    ],
  );
});

Deno.test("git-never-prompts: options in a variable end the call at its `)`", () => {
  // No `})` of its own: "up to the next `})`" read the NEXT call's guard.
  const src = `await run("git", ["fetch"], opts);\n` +
    `await run("git", ["status"], { env: gitOwnRepoEnv(), cwd: ")]" });\n` +
    `spawn(["git", "gc"], o);\nx({ env: gitOwnRepoEnv() });\n`;
  assertEquals(offendersIn("src/server/x.ts", src), [
    "src/server/x.ts:1 — git spawned without gitOwnRepoEnv(",
    "src/server/x.ts:3 — git spawned without gitOwnRepoEnv(",
  ]);
});

Deno.test("src: every spawned git carries gitOwnRepoEnv (am: gitEnvFor) and a null stdin", async () => {
  const offenders: string[] = [];
  for await (const path of tsFiles("src")) {
    offenders.push(...offendersIn(path, await Deno.readTextFile(path)));
  }
  assertEquals(
    offenders,
    [],
    "a spawned git without the no-prompt guard can ask the user for GitHub " +
      "credentials mid-command (or hang a script) whenever GitHub " +
      "rate-limits anonymous fetches, and one that inherits GIT_DIR addresses " +
      "ANOTHER repo — spread gitOwnRepoEnv() from " +
      "src/server/git-noninteractive.ts:\n  " + offenders.join("\n  "),
  );
});
