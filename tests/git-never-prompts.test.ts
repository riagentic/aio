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

const SPAWN = /new Deno\.Command\(\s*"git"/g;
// The options object follows the match; the markers live within it. 1500
// chars covers the largest current site (gitLsRemote, whose options carry a
// ~700-char comment) with room to spare.
const WINDOW = 1500;

async function* tsFiles(dir: string): AsyncGenerator<string> {
  for await (const e of Deno.readDir(dir)) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory) yield* tsFiles(p);
    else if (e.isFile && /\.tsx?$/.test(e.name)) yield p;
  }
}

Deno.test("src: every spawned git carries GIT_NO_PROMPT_ENV and a null stdin", async () => {
  const offenders: string[] = [];
  for await (const path of tsFiles("src")) {
    const raw = await Deno.readTextFile(path);
    // Template literals are DATA (fixture source, generated scripts), not
    // code this file runs — blanked with offsets kept, as in
    // tests/test-ports-are-free.test.ts.
    const src = raw.replace(
      /`(?:[^`\\]|\\.)*`/g,
      (m) => m.replace(/[^\n]/g, " "),
    );
    for (const m of src.matchAll(SPAWN)) {
      const opts = src.slice(m.index, m.index + WINDOW);
      const line = src.slice(0, m.index).split("\n").length;
      if (!opts.includes("GIT_NO_PROMPT_ENV")) {
        offenders.push(`${path}:${line} — missing env: GIT_NO_PROMPT_ENV`);
      }
      if (!/stdin:\s*"null"/.test(opts)) {
        offenders.push(`${path}:${line} — missing stdin: "null"`);
      }
    }
  }
  assertEquals(
    offenders,
    [],
    "a spawned git without the no-prompt guard can ask the user for GitHub " +
      "credentials mid-command (or hang a script) whenever GitHub " +
      "rate-limits anonymous fetches — import GIT_NO_PROMPT_ENV from " +
      "src/server/git-noninteractive.ts:\n  " + offenders.join("\n  "),
  );
});
