// A `//` comment above a cell method silently disabled four documented ERROR
// rules.
//
// `_members()` finds a method by its lead-in — the `,` or `{` before it,
// followed by whitespace. `codeText` blanks a comment's CONTENT and leaves its
// `//` delimiter standing, so `,\n  //  …\n  method(` had two slashes where
// whitespace was required, and the member was simply not found.
//
// Four rules that `docs/testing/linter.md` documents as ERRORS, each with a
// stated "Exact criterion" that says nothing about comments, then reported
// nothing for that method:
//
//   • a sync method reading a `visible`-hidden field  (linter.md:134)
//   • a live draft escaping the method                (linter.md:188)
//   • I/O in a sync method                            (linter.md:198)
//   • a sync replay effect
//
// Measured on two projects differing by ONE comment line: the plain version
// reported the error, the commented one reported []. A JSDoc block did the
// same, and so did a trailing `// bump` on the PREVIOUS line. Every real cell
// has doc comments — so in a commented codebase `fetch()` in a reducer, an
// escaping draft, and a sync read of a hidden secret all lint clean while the
// page advertises three enforced gates.
import { assert, assertEquals } from "@std/assert";
import { childCoverageDir, tempDir } from "../src/testing/temp-dir.ts";

const AIOL = new URL("../aiol/mod.ts", import.meta.url).pathname;
const AIO = new URL("../mod.ts", import.meta.url).pathname;
const _cov = childCoverageDir();

/** Lint a throwaway project through the REAL linter — the thing a reader runs.
 *  Returns its combined output. */
async function lint(cellSrc: string): Promise<string> {
  const dir = await tempDir("aiol-comment-");
  try {
    await Deno.mkdir(`${dir}/src`, { recursive: true });
    await Deno.writeTextFile(
      `${dir}/deno.json`,
      JSON.stringify({ name: "probe", imports: { aio: AIO } }),
    );
    await Deno.writeTextFile(`${dir}/src/cell.ts`, cellSrc);
    const out = await new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", AIOL, "."],
      cwd: dir,
      env: { ...Deno.env.toObject(), DENO_COVERAGE_DIR: _cov },
      stdout: "piped",
      stderr: "piped",
    }).output();
    return new TextDecoder().decode(out.stdout) +
      new TextDecoder().decode(out.stderr);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

/** A sync cell whose method reads a `visible`-hidden field — the shape
 *  `linter.md` documents as an error. `lead` goes between the previous member
 *  and this one. */
const cellWith = (lead: string) =>
  `import { cell } from "aio";
export const probe = cell("probe", {
  state: { seed: "s3cret", out: 0 },
  sync: true,
  visible: { exclude: ["seed"] },
  methods: {
    other(s: { out: number }) {
      s.out = 1;
    },${lead}
    reader(s: { seed: string; out: number }) {
      s.out = s.seed.length;
    },
  },
});
`;

Deno.test("aiol: a comment above a method does not hide it from the rules", async () => {
  const leads: [string, string][] = [
    ["none", ""],
    ["line comment", "\n    // compute the length"],
    ["jsdoc", "\n    /** Compute the length. */"],
    ["trailing on the previous line", " // bump"],
    ["two comments", "\n    // one\n    // two"],
  ];
  assertEquals(leads.length, 5, "every comment shape is checked");
  for (const [name, lead] of leads) {
    const out = await lint(cellWith(lead));
    assert(
      /reads `s\.seed`/.test(out),
      `${name}: the rule reported nothing — a comment must not switch an ` +
        `ERROR gate off:\n${out.slice(0, 400)}`,
    );
  }
});

Deno.test("aiol: a method that does NOT read a hidden field is still clean", async () => {
  // The control — a lead-in loose enough to match anything would report the
  // error for every method and make the rule noise.
  const out = await lint(`import { cell } from "aio";
export const probe = cell("probe", {
  state: { seed: "s3cret", out: 0 },
  sync: true,
  visible: { exclude: ["seed"] },
  methods: {
    // a comment here too
    safe(s: { out: number }) {
      s.out = 1;
    },
  },
});
`);
  assertEquals(
    /reads `s\.seed`/.test(out),
    false,
    `a method that reads nothing hidden must not be flagged:\n${
      out.slice(0, 400)
    }`,
  );
});
