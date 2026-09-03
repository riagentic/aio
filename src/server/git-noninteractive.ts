/**
 * Environment for EVERY `git` subprocess the framework spawns.
 *
 * Since 2025 GitHub rate-limits anonymous HTTPS git traffic and answers a
 * throttled request with an auth challenge — even for a fully public repo.
 * Plain git then falls back to an interactive "Username for
 * 'https://github.com':" prompt, which surfaced INSIDE `am pin <tag>` on a
 * user's terminal (2026-09-02): aio looked like it demanded GitHub
 * credentials, when it never needs any. Worse, in a script that prompt is a
 * silent hang.
 *
 * So: no framework-spawned git may ever prompt. With prompts off, a
 * challenged fetch FAILS with "could not read Username … terminal prompts
 * disabled", which the call site turns into a loud, actionable error
 * (fail loud, never silent — CLAUDE.md). Pair this env with `stdin: "null"`;
 * `tests/git-never-prompts.test.ts` gates both on every call site.
 */
export const GIT_NO_PROMPT_ENV: Record<string, string> = {
  // Core git: never ask on the terminal — fail instead.
  GIT_TERMINAL_PROMPT: "0",
  // Git Credential Manager (Windows/mac installs): never pop a dialog.
  GCM_INTERACTIVE: "never",
};

/** Does a git failure look like an auth challenge (GitHub anonymous rate
 *  limit, a private remote, a 401/403/429) rather than a network error? */
export function looksLikeAuthChallenge(gitStderr: string): boolean {
  return /could not read Username|Authentication failed|terminal prompts disabled|HTTP 40[13]|HTTP 429|rate limit/i
    .test(gitStderr);
}
