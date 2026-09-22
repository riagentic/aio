#!/usr/bin/env -S deno run --allow-read --allow-run
// check-report-dirs.ts — a field report may never become a tracked file.
//
// `feedback/` and `review/` hold reports from real apps built on aio. They
// name the app, describe its internals, and — when the report is a security
// audit — say exactly where that app's secrets were reachable and what the
// fields holding them are called. The standing rule is that a PRIVATE app is
// referred to by type only ("a crypto wallet"), never by name, in any tracked
// file or commit message.
//
// WHY THIS EXISTS RATHER THAN A HABIT. `feedback/` was gitignored from the
// start and held. `review/` was not, and nothing noticed: one file
// — a key-security audit of a private wallet, naming its seed-ciphertext and
// passphrase-verifier fields — sat in a PUBLIC repository for a month and
// shipped inside the published package on every release in that window,
// because `deno publish` has its own exclude list and `*.md` did not cover a
// nested one.
//
// A rule that depends on remembering is a rule that has already failed once.
// Both halves are checked here:
//
//   • nothing under either directory is TRACKED, and
//   • both are still named in `.gitignore`, so the first half cannot be
//     quietly defeated by deleting a line.
//
// Deliberately NOT a name scan. A blocklist of app names would have to hold
// the names to look for, in a tracked file, which is the leak it is meant to
// prevent. The directory is the boundary: reports live there, and nothing
// there is ever committed.

/** The two directories whose contents are reports, never source. */
export const REPORT_DIRS = ["feedback/", "review/"] as const;

export type Verdict = {
  ok: boolean;
  /** Tracked paths that must not be tracked. */
  tracked: string[];
  /** Report dirs missing from `.gitignore`. */
  unignored: string[];
};

/** The whole decision, as a pure function of what git and `.gitignore` say —
 *  so the gate can be tested on text instead of only on this repo. A gate
 *  with no test of its own is the "verify the instrument" trap wearing a
 *  ratchet, and this one was written the day a silent gap was found. */
export function verdict(
  trackedPaths: readonly string[],
  gitignore: string,
): Verdict {
  const tracked = trackedPaths
    .map((p) => p.trim())
    .filter((p) => p !== "" && REPORT_DIRS.some((d) => p.startsWith(d)));
  const lines = gitignore.split("\n").map((l) => l.trim());
  const unignored = REPORT_DIRS.filter((d) => !lines.includes(d));
  return {
    ok: tracked.length === 0 && unignored.length === 0,
    tracked,
    unignored,
  };
}

async function gitLsFiles(root: string): Promise<string[]> {
  const p = await new Deno.Command("git", {
    args: ["ls-files", ...REPORT_DIRS],
    cwd: root,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!p.success) {
    throw new Error(
      `git ls-files failed: ${new TextDecoder().decode(p.stderr).trim()}`,
    );
  }
  return new TextDecoder().decode(p.stdout).split("\n");
}

if (import.meta.main) {
  const root = new URL("../", import.meta.url).pathname;
  const v = verdict(
    await gitLsFiles(root),
    await Deno.readTextFile(`${root}.gitignore`),
  );

  if (v.tracked.length > 0) {
    console.error(
      `✗ ${v.tracked.length} field report${
        v.tracked.length === 1 ? " is" : "s are"
      } TRACKED by git:\n` +
        v.tracked.map((p) => `      ${p}`).join("\n") +
        `\n  A report names a real app and its internals. Tracked means it is\n` +
        `  pushed, and — because \`deno publish\` has its own exclude list —\n` +
        `  very likely shipped in the package too.\n` +
        `      git rm --cached <path>      # keep the file, untrack it\n` +
        `  Then check whether it already reached the remote.`,
    );
  }
  if (v.unignored.length > 0) {
    console.error(
      `✗ not ignored: ${v.unignored.join(", ")}\n` +
        `  Each report directory must be named in .gitignore, or the check\n` +
        `  above is one \`git add\` away from being defeated.`,
    );
  }
  if (!v.ok) Deno.exit(1);
  console.log(
    `✓ report dirs: ${REPORT_DIRS.join(" + ")} ignored, nothing tracked`,
  );
}
