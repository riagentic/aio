// `am start --profile` forwards the profile as ARGV, never env-only — so a
// runtime from BEFORE profiles refuses it loudly instead of silently booting
// on the app's real data. Pinned against the actual v1.0.9-beta parser, read
// out of the repository's own history (skipped where that tag is absent).
import { assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const TAG = "v1.0.9-beta";

const tagged = (() => {
  try {
    return new Deno.Command("git", {
      args: ["-C", REPO, "rev-parse", "--verify", "--quiet", `${TAG}^{commit}`],
      stdout: "null",
      stderr: "null",
    }).outputSync().success;
  } catch {
    return false;
  }
})();

Deno.test({
  name: "a v1.0.9 runtime REFUSES the forwarded --profile=dev (unknown flag)",
  ignore: !tagged,
  async fn() {
    const dir = await tempDir("old-rt-");
    try {
      // The old tree's src/ + config, as it shipped.
      const tar = await new Deno.Command("git", {
        args: [
          "-C",
          REPO,
          "archive",
          "--format=tar",
          TAG,
          "src",
          "deno.json",
          "mod.ts",
        ],
        stdout: "piped",
      }).output();
      const x = new Deno.Command("tar", {
        args: ["-x", "-C", dir],
        stdin: "piped",
      }).spawn();
      const w = x.stdin.getWriter();
      await w.write(tar.stdout);
      await w.close();
      await x.status;
      const probe = join(dir, "probe.ts");
      await Deno.writeTextFile(
        probe,
        `import { parseCli } from "./src/server/aio-cli.ts";
try { parseCli(["--profile=dev"]); console.log("ACCEPTED"); }
catch (e) { console.log("REFUSED " + (e as Error).message); }
`,
      );
      const o = await new Deno.Command(Deno.execPath(), {
        args: ["run", "-A", "--config", join(dir, "deno.json"), probe],
        cwd: dir,
      }).output();
      const out = new TextDecoder().decode(o.stdout) +
        new TextDecoder().decode(o.stderr);
      assertStringIncludes(out, "REFUSED [aio] unknown flag: --profile=dev");
    } finally {
      await dropTempDir(dir);
    }
  },
});
