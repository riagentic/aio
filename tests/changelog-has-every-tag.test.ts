// Every shipped tag keeps its CHANGELOG entry.
//
// The commit that staged 1.0.0-beta rewrote alpha77's heading and intro into
// 1.0.0-beta's, so a tagged, shipped release had no entry at all and 1.0.0-beta claimed
// its three hundred lines as its own. Nothing noticed: the release gates read
// the CURRENT version's entry only, and `git diff` showed 17 lines removed
// against 950 added. A tag is a promise the repo keeps; the entry is the half
// people read. From alpha65 on (the same floor `check:docs` uses for upgrade
// guides) every `v*` tag must have its own `## <tag> — …` heading.
import { assert } from "@std/assert";

const FLOOR = 65;

Deno.test("CHANGELOG: every tagged release from alpha65 on has its own heading", async () => {
  const out = await new Deno.Command("git", {
    args: ["tag", "-l", "v*"],
    stdout: "piped",
    stderr: "piped",
  }).output();
  assert(out.success, new TextDecoder().decode(out.stderr));
  const tags = new TextDecoder().decode(out.stdout).split("\n").filter((t) => {
    // Every release shape this repo has shipped or will: `v1.0.0-alphaNN`,
    // the beta line `vX.Y.Z-beta` (no digit — the patch is the counter), an
    // `-rc`, and a final `vX.Y.Z`. Only the alphas have a floor.
    const m = /^v(\d+)\.(\d+)\.(\d+)(?:-(alpha|beta|rc)(\d*))?$/.exec(t);
    // Pre-1.0 tags predate the CHANGELOG discipline; the floor is a 1.x one.
    return !!m && Number(m[1]) >= 1 &&
      (m[4] !== "alpha" || Number(m[5]) >= FLOOR);
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
