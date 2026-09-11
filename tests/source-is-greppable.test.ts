// A raw control byte in a source file makes that file INVISIBLE to grep.
//
// `tests/ui-markdown.test.ts` carried two NUL bytes inside comments and one in
// a character class. All three were legal TypeScript, all its tests passed —
// and `grep -n "Window" tests/ui-markdown.test.ts` printed NOTHING. grep sees a
// NUL in the first buffer, decides the file is binary, and says so only on
// stderr under `-r` (not at all for a named file). `file` calls all six such
// files in this repo `data`.
//
// That is not a theoretical hazard. In one session it hid the same file from
// two separate sweeps of mine: the one that routed every `happyDOM.close()`
// through `closeWindow()`, and the one that checked the routing had worked.
// Both reported a clean repo. The file was in neither result, and it was the
// only offender left.
//
// Four of the six were in `src/` — `skv-sqlite.ts`'s persisted key separator
// among them. Any future `grep -rn` over `src/` silently skipped them.
//
// Every one of the six was a separator or a test datum, and every one is
// byte-identical written as an escape (`"\x1f"`, `"\x00"`). So the rule costs
// nothing and buys back every grep-based sweep, in CI and by hand:
//
//   No tracked source file contains a raw C0 control byte other than tab,
//   LF and CR. Spell it `\x00` / `\u0000` and the file stays text.
import { assertEquals } from "@std/assert";

const ROOTS = [
  "src",
  "tests",
  "amui",
  "aiol",
  "scripts",
  "examples",
  "docs",
] as const;
const EXTS = /\.(tsx?|jsx?|json|md|css|html)$/;

/** Raw C0 controls, minus the three that legitimately appear in text. */
const isBad = (b: number) =>
  b < 0x09 || (b > 0x0d && b < 0x20) || b === 0x0b ||
  b === 0x0c;

async function* files(dir: string): AsyncGenerator<string> {
  for await (const e of Deno.readDir(dir)) {
    const path = `${dir}/${e.name}`;
    if (e.isDirectory) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      yield* files(path);
    } else if (e.isFile && EXTS.test(e.name)) yield path;
  }
}

async function scan(): Promise<string[]> {
  const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
  const bad: string[] = [];
  for (const r of ROOTS) {
    let dir: string;
    try {
      dir = `${root}/${r}`;
      await Deno.stat(dir);
    } catch {
      continue;
    }
    for await (const f of files(dir)) {
      const bytes = await Deno.readFile(f);
      const hit = bytes.findIndex(isBad);
      if (hit >= 0) {
        const line = bytes.slice(0, hit).reduce(
          (n, b) => b === 0x0a ? n + 1 : n,
          1,
        );
        bad.push(
          `${f.slice(root.length + 1)}:${line} — 0x${
            bytes[hit]!.toString(16).padStart(2, "0")
          }`,
        );
      }
    }
  }
  return bad.sort();
}

Deno.test("no source file carries a raw control byte", async () => {
  const bad = await scan();
  assertEquals(
    bad,
    [],
    `these files are invisible to grep — write the byte as an escape ` +
      `(\`"\\x00"\`, \`"\\x1f"\`), which is the identical string at runtime:\n` +
      bad.map((b) => `  ${b}`).join("\n"),
  );
});

Deno.test("the detector actually detects, and the scan actually scans", async () => {
  // The predicate, on the bytes it must and must not catch.
  for (const b of [0x00, 0x01, 0x1f, 0x08, 0x0b, 0x0c, 0x1b]) {
    assertEquals(isBad(b), true, `0x${b.toString(16)} must be caught`);
  }
  for (const b of [0x09, 0x0a, 0x0d, 0x20, 0x41, 0x7f, 0xc3]) {
    assertEquals(isBad(b), false, `0x${b.toString(16)} must be allowed`);
  }

  // And a planted offender is found end to end, so a scan that walks nothing
  // cannot pass as a clean repo — the exact way the raw bytes hid in the first
  // place.
  const { dropTempDir, tempDir } = await import("../src/testing/temp-dir.ts");
  const dir = await tempDir("greppable-");
  try {
    await Deno.writeTextFile(`${dir}/ok.ts`, "const a = 1;\n");
    await Deno.writeFile(
      `${dir}/bad.ts`,
      new TextEncoder().encode('const SEP = "\x1f";\n'),
    );
    const seen: string[] = [];
    for await (const f of files(dir)) {
      const bytes = await Deno.readFile(f);
      if (bytes.findIndex(isBad) >= 0) seen.push(f.split("/").pop()!);
    }
    assertEquals(seen, ["bad.ts"], "the walk did not find the planted file");
  } finally {
    await dropTempDir(dir);
  }
});
