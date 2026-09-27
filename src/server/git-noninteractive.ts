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

/** The variables that make git address a repo OTHER than the one its cwd is
 *  in: git's own `git rev-parse --local-env-vars` list (what git itself clears
 *  before it runs in a submodule), plus `GIT_NAMESPACE` and
 *  `GIT_QUARANTINE_PATH`. `tests/am-git-env.test.ts` pins it as a superset of
 *  the installed git's list. */
export const GIT_REPO_ENV_VARS: readonly string[] = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CONFIG",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
  "GIT_OBJECT_DIRECTORY",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_GRAFT_FILE",
  "GIT_INDEX_FILE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_REPLACE_REF_BASE",
  "GIT_PREFIX",
  "GIT_SHALLOW_FILE",
  "GIT_COMMON_DIR",
  "GIT_NAMESPACE",
  "GIT_QUARANTINE_PATH",
];

/** Spawn options for a git that must address the repo its cwd/args name —
 *  never one the INHERITED environment names. Inside a hook (a post-receive
 *  deploy) git exports `GIT_DIR`, `GIT_WORK_TREE`, …, and a child git obeys
 *  them over its cwd: `rev-parse HEAD` in a fresh clone answered the hook's
 *  repo. `Deno.Command`'s `env` only MERGES over the parent's and cannot
 *  unset, so the inherited environment is copied minus
 *  {@linkcode GIT_REPO_ENV_VARS} and passed with `clearEnv: true`, plus
 *  {@linkcode GIT_NO_PROMPT_ENV} and `extra`. Spread into the options:
 *  `new Deno.Command("git", { …, ...gitOwnRepoEnv() })`. Case-insensitive on
 *  the names: Windows environment keys are. */
export function gitOwnRepoEnv(
  extra: Record<string, string> = {},
): { clearEnv: true; env: Record<string, string> } {
  const drop = new Set(GIT_REPO_ENV_VARS);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(Deno.env.toObject())) {
    if (!drop.has(k.toUpperCase())) env[k] = v;
  }
  return { clearEnv: true, env: { ...env, ...GIT_NO_PROMPT_ENV, ...extra } };
}

/** Does a git failure look like an auth challenge (GitHub anonymous rate
 *  limit, a private remote, a 401/403/429) rather than a network error? */
export function looksLikeAuthChallenge(gitStderr: string): boolean {
  return /could not read Username|Authentication failed|terminal prompts disabled|HTTP 40[13]|HTTP 429|rate limit/i
    .test(gitStderr);
}
