// Every shipped tag keeps its CHANGELOG entry.
//
// The commit that staged beta1 rewrote alpha77's heading and intro into
// beta1's, so a tagged, shipped release had no entry at all and beta1 claimed
// its three hundred lines as its own. Nothing noticed: the release gates read
// the CURRENT version's entry only, and `git diff` showed 17 lines removed
// against 950 added. A tag is a promise the repo keeps; the entry is the half
// people read. From alpha65 on (the same floor `check:docs` uses for upgrade
// guides) every `v1.0.0-*` tag must have its own `## <tag> — …` heading.
import { assert } from "@std/assert";

const FLOOR = 65;

Deno.test("CHANGELOG: every tagged release from alpha65 on has its own heading", async () => {
  const out = await new Deno.Command("git", {
    args: ["tag", "-l", "v1.0.0-*"],
    stdout: "piped",
    stderr: "piped",
  }).output();
  assert(out.success, new TextDecoder().decode(out.stderr));
  const tags = new TextDecoder().decode(out.stdout).split("\n").filter((t) => {
    const m = /^v1\.0\.0-(alpha|beta|rc)(\d+)$/.exec(t);
    return !!m && (m[1] !== "alpha" || Number(m[2]) >= FLOOR);
  });
  // A tag list that read nothing would make this green for the wrong reason.
  assert(tags.length >= 10, `only ${tags.length} tags read — proved nothing`);
  const changelog = await Deno.readTextFile("CHANGELOG.md");
  const missing = tags.filter((t) =>
    !new RegExp(`^## ${t.replace(/\./g, "\\.")} — `, "m").test(changelog)
  );
  assert(
    missing.length === 0,
    `tagged releases with no CHANGELOG entry (a release commit rewrote the ` +
      `previous heading instead of adding one?): ${missing.join(", ")}`,
  );
});
