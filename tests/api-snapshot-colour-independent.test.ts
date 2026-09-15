// The API gate's verdict must not depend on where it ran.
//
// `deno doc --json` colours its own JSON: a type whose `repr` contains an
// interpolation comes back as
//   "${\u001b[38;5;12mPrefix\u001b[0m}:${\u001b[0m…K…}"
// and as "${Prefix}:${K}" under NO_COLOR. It does this unconditionally — the
// escapes appear with stdout piped, with the environment cleared, with no TTY
// in sight — so NO_COLOR is the only lever there is. The digest is taken over
// that string, so for a while the SAME unchanged
// tree hashed two different ways: green in a developer's terminal, red under
// `deno task check:release` and red in CI — and red as `BREAKING`, naming four
// type aliases nobody had touched. A frozen-surface gate that cries break at
// the terminal it is run from is worse than no gate: it teaches the reader to
// regenerate the snapshot to make the noise stop, which is exactly the motion
// that would launder a real break.
//
// Two guards, tested here: the spawn pins `NO_COLOR`, and every string is
// stripped of SGR escapes before it reaches a digest.
import { assert, assertEquals } from "@std/assert";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const REPO = new URL("..", import.meta.url).pathname;
const ESC = "\u001b";

/** A template-literal type over two type parameters — the shape `deno doc`
 *  colours. Kept tiny so the doc run is a fraction of a second. */
const FIXTURE = [
  "export type Pfx = string;",
  "export type Cat<Prefix extends Pfx, K extends string> = `${Prefix}:${K}`;",
  "",
].join("\n");

async function docJson(
  dir: string,
  env: Record<string, string>,
): Promise<string> {
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["doc", "--json", "f.ts"],
    cwd: dir,
    env,
    stdout: "piped",
    stderr: "piped",
  }).output();
  assertEquals(out.code, 0, new TextDecoder().decode(out.stderr));
  return new TextDecoder().decode(out.stdout);
}

Deno.test("api gate: the same tree digests the same with and without colour", async () => {
  const dir = await tempDir("api-colour-");
  try {
    await Deno.writeTextFile(`${dir}/f.ts`, FIXTURE);

    const coloured = await docJson(dir, { FORCE_COLOR: "1" });
    const plain = await docJson(dir, { NO_COLOR: "1" });

    // Half one: record what this Deno does. Readings may differ by colour,
    // or — as of Deno 2.9 — arrive identical *with* escapes regardless of
    // FORCE_COLOR / NO_COLOR. Either is fine; half two is the load-bearing
    // guard. What is not fine is a silent other dependence with no escapes.
    if (coloured !== plain) {
      assert(
        coloured.includes(ESC) || coloured.includes("\u001b") ||
          plain.includes(ESC) || plain.includes("\u001b"),
        "readings differ without colour escapes — `deno doc --json` has some " +
          "OTHER context dependence, and the digest inherits it",
      );
    }

    // Half two, the load-bearing one: whatever `deno doc` did, the gate's own
    // normalisation must erase it. This mirrors `normalize()` in
    // scripts/api-snapshot.ts; the two are pinned together by the source
    // assertion below.
    // deno-lint-ignore no-control-regex -- ESC and the CSI range are the point
    const strip = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, "");
    const norm = (raw: string) =>
      JSON.stringify(
        JSON.parse(raw),
        (_k, v) => typeof v === "string" ? strip(v) : v,
      );
    assertEquals(
      norm(coloured),
      norm(plain),
      "the API digest still depends on whether colour was on — a snapshot " +
        "generated in a terminal will not match one checked in CI",
    );
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("api gate: both guards are actually in the script", async () => {
  const src = await Deno.readTextFile(`${REPO}scripts/api-snapshot.ts`);
  assert(
    /env:\s*\{[^}]*NO_COLOR:\s*"1"/.test(src),
    "`deno doc` is no longer spawned with NO_COLOR — the reading is back to " +
      "being context-dependent",
  );
  assert(
    /replace\(ANSI_RE, ""\)/.test(src),
    "normalize() no longer strips ANSI — remove the belt only when the " +
      "braces are proven, and this test is the proof",
  );
});
