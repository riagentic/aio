// Every PowerShell text the framework generates, checked as text.
//
// The update helper waited for the old app's processes with
// `(Get-Running).Count -gt 0`. On Windows PowerShell 5.1 a function that
// returns ONE CimInstance hands back that object, not an array, and it has no
// `.Count` — so the wait ended while exactly one process was still running
// (measured on Windows 11: `[]` for one, `0` for none, `2` for two). The rule
// that removes the class: a count is only ever taken of `@( … )`.
//
// This host has no Windows PowerShell. Where `pwsh` is installed the scripts
// are handed to the real parser; everywhere, their quotes and brackets must
// balance — the mistake a generator makes first.
import { assert, assertEquals, assertThrows } from "@std/assert";
import { _swapSpec, unpackCommand } from "../src/server/updates-apply.ts";
import { _openSpec } from "../src/server/open-external.ts";
import { pickSpec } from "../src/server/pick-path.ts";
import { detachedSpawnSpec } from "../src/am/am-cmd-process.ts";
import { _zipFallbackSpec, zipDir } from "../src/build/build-electron.ts";
import { join, resolve } from "@std/path";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

function decode(b64: string): string {
  return new TextDecoder("utf-16le").decode(
    Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)),
  );
}

/** A path with every character a quoting rule gets wrong. */
const HOSTILE = "C:\\Users\\Dan’s PC\\it's [1] & $x `y\\App";

function scripts(): Record<string, string> {
  const swap = _swapSpec("windows", {
    pid: 1,
    current: HOSTILE,
    previous: `${HOSTILE}.old-1`,
    staged: `${HOSTILE}.staged-2`,
    launcher: `${HOSTILE}\\run.bat`,
    mark: "m",
    token: "t",
    failed: "f",
    waitS: 120,
    args: [],
  }, "");
  const last = (args: string[]) => args[args.length - 1]!;
  return {
    "update swap helper": decode(
      swap.args[swap.args.indexOf("-EncodedCommand") + 1]!,
    ),
    // `SWAP_BOOTSTRAP`, pinned by tests/no-console.test.ts.
    "update swap bootstrap":
      "$s = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($env:AIO_SWAP_SCRIPT)); & ([scriptblock]::Create($s))",
    "update unpack": last(
      unpackCommand("windows", `${HOSTILE}.zip-2`, `${HOSTILE}.staged-2`).args,
    ),
    "openExternal": last(_openSpec("windows", HOSTILE).args),
    "pick file": last(
      pickSpec("windows", "powershell", "files", {
        title: "it's",
        startIn: HOSTILE,
        filters: [{ name: "Text", extensions: ["txt"] }],
      })!.args,
    ),
    "pick directory": last(
      pickSpec("windows", "powershell", "directory", { title: "it's" })!.args,
    ),
    "am start": last(
      detachedSpawnSpec("windows", ["run", "--title=Don’t"], `${HOSTILE}.log`)
        .args,
    ),
    "build zip fallback": last(
      _zipFallbackSpec(HOSTILE, `${HOSTILE}.zip`).args,
    ),
  };
}

/** Walk PowerShell text: single-quoted strings (`''` escapes), double-quoted
 *  strings (`` ` `` escapes, `""`), `#` comments, and the three bracket
 *  kinds. Throws on the first thing that does not close; returns what each
 *  single-quoted string SAYS (the value PowerShell would see). */
function balance(src: string): string[] {
  const open: string[] = [];
  const said: string[] = [];
  const pair: Record<string, string> = { ")": "(", "}": "{", "]": "[" };
  // Typographic quotes end a single-quoted string exactly like U+0027.
  const single = "'\u2018\u2019\u201A\u201B";
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (single.includes(c)) {
      let value = "";
      for (i++;; i++) {
        if (i >= src.length) throw new Error("unterminated '…' string");
        if (!single.includes(src[i]!)) value += src[i];
        else if (single.includes(src[i + 1] ?? "")) value += src[++i];
        else break;
      }
      said.push(value);
    } else if (c === '"') {
      for (i++;; i++) {
        if (i >= src.length) throw new Error('unterminated "…" string');
        if (src[i] === "`") i++;
        else if (src[i] === "$" && src[i + 1] === "(") {
          throw new Error("$( … ) inside a string: teach this walker first");
        } else if (src[i] === '"') {
          if (src[i + 1] === '"') i++;
          else break;
        }
      }
    } else if (c === "`") i++;
    else if (c === "#" && (i === 0 || /[\s;({]/.test(src[i - 1]!))) {
      while (i < src.length && src[i] !== "\n") i++;
    } else if ("({[".includes(c)) open.push(c);
    else if (c in pair) {
      const was = open.pop();
      if (was !== pair[c]) {
        throw new Error(
          `"${c}" at ${i} closes "${was ?? "nothing"}": …${
            src.slice(Math.max(0, i - 60), i + 1)
          }`,
        );
      }
    }
  }
  if (open.length > 0) throw new Error(`unclosed ${open.join(" ")}`);
  return said;
}

Deno.test("generated PowerShell: every script's quotes and brackets balance", () => {
  const all = scripts();
  assertEquals(Object.keys(all).length, 8);
  const said: Record<string, string[]> = {};
  for (const [name, text] of Object.entries(all)) {
    try {
      said[name] = balance(text);
    } catch (e) {
      throw new Error(`${name}: ${e instanceof Error ? e.message : e}`);
    }
  }
  // A value written into a single-quoted string must come out as itself —
  // a quote that is not doubled can still leave the text balanced, with the
  // path cut in pieces and the rest run as code.
  const holds = (name: string, value: string) =>
    assert(
      said[name]!.includes(value),
      `${name}: ${value} is not one string — it reads ${
        JSON.stringify(said[name])
      }`,
    );
  holds("update unpack", `${HOSTILE}.zip-2`);
  holds("update unpack", `${HOSTILE}.staged-2`);
  holds("pick file", "it's");
  holds("pick file", HOSTILE.slice(0, HOSTILE.lastIndexOf("\\")));
  holds("pick directory", "it's");
  holds("am start", `${HOSTILE}.log`);
  holds("am start", `${HOSTILE}.log.err`);
  // The walker itself: each mistake it exists for is one it reports.
  for (
    const bad of [
      "if ($a) { 'x' ",
      "f('it's')",
      'Write-Output "a',
      "@(1, 2]",
      "$p = 'C:\\Dan’s PC'; g",
    ]
  ) {
    assertThrows(() => balance(bad), Error, undefined, bad);
  }
  balance("f('it''s') # an unclosed ( in a comment\n$x = \"a `\" b\"");
});

Deno.test("generated PowerShell: a count is only ever taken of an array", () => {
  let counts = 0;
  const all = Object.entries(scripts());
  assertEquals(all.length, 8);
  for (const [name, text] of all) {
    const arrays = new Set(
      [...text.matchAll(/(\$\w+) = @\(/g)].map((m) => m[1]!),
    );
    for (const m of text.matchAll(/(\$[\w:]+|\))\.(Count|Length)\b/g)) {
      const at = m.index!;
      const line = text.slice(text.lastIndexOf("\n", at) + 1).split("\n")[0]!;
      // .NET members that are a number on one object are fine.
      if (m[2] === "Length" && /\$(cur|launch)\.Length/.test(m[0])) continue;
      counts++;
      if (m[1] === ")") {
        // The group this `)` closes must be `@( … )`.
        let depth = 0, i = at;
        for (; i >= 0; i--) {
          if (text[i] === ")") depth++;
          else if (text[i] === "(" && --depth === 0) break;
        }
        assertEquals(
          text[i - 1],
          "@",
          `${name}: a count of a bare expression — one object has no ` +
            `.Count on PowerShell 5.1: ${line.trim()}`,
        );
      } else {
        assert(
          arrays.has(m[1]!),
          `${name}: ${m[1]} is counted but never assigned from @( … ): ` +
            line.trim(),
        );
      }
    }
  }
  // The helper's wait, its stop loop and its holder list (asked three
  // times: any, more than the bound, how many more).
  assertEquals(counts, 5);
});

Deno.test("generated PowerShell: a path is never a wildcard pattern, and no value is compared against $null on the left", () => {
  const swap = scripts()["update swap helper"]!;
  // `-Path` (and a bare positional path) expands `[1]` as a pattern.
  assertEquals(
    swap.split("\n").filter((l) =>
      !l.trim().startsWith("#") &&
      /\b(Test-Path|Remove-Item|Get-Item|Get-ChildItem|Get-Content)\b/.test(
        l,
      ) && !/-LiteralPath|Env:/.test(l)
    ),
    [],
  );
  const all = Object.entries(scripts());
  assertEquals(all.length, 8);
  for (const [name, text] of all) {
    assertEquals(
      [...text.matchAll(/\S+\s+-(eq|ne)\s+\$null\b/g)].map((m) => m[0]),
      [],
      `${name}: with a collection on the left, "-eq $null" filters instead ` +
        `of testing — write "$null -eq …"`,
    );
  }
});

// The fallback that packs a build where there is no `zip` wrote both paths
// into the script inside double quotes, and gave them to a cmdlet that reads
// a path as a pattern: a project folder with `[1]`, `$` or a backtick in its
// name packed nothing, or something else.
Deno.test("generated PowerShell: the zip fallback never has a path in its text", () => {
  const spec = _zipFallbackSpec(HOSTILE, "out dir/it's [1].zip");
  assertEquals(spec.env, {
    AIO_ZIP_DIR: resolve(HOSTILE),
    AIO_ZIP_OUT: resolve("out dir/it's [1].zip"),
  });
  const text = spec.args[spec.args.length - 1]!;
  assertEquals(balance(text), [], "a quoted value in the script");
  // Neither a cmdlet that takes a pattern, nor a string a path could end.
  assertEquals(/Compress-Archive|-Path\b|"/.test(text), false, text);
  assert(
    text.includes(
      "::CreateFromDirectory($env:AIO_ZIP_DIR, $env:AIO_ZIP_OUT)",
    ),
    text,
  );
});

Deno.test({
  name:
    "generated PowerShell: with no zip, the fallback is run with both paths in its environment",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const dir = await tempDir("aio-ps-zip-");
    const path = Deno.env.get("PATH");
    try {
      // A PATH with one program: a stand-in `powershell` that says what it
      // was given. No `zip` is on it.
      const bin = join(dir, "bin"), app = join(dir, "it's [1] app");
      await Deno.mkdir(bin);
      await Deno.mkdir(app);
      await Deno.writeTextFile(join(app, "f"), "x");
      await Deno.writeTextFile(
        join(bin, "powershell"),
        `#!/bin/sh\nprintf '%s\\n%s\\n' "$AIO_ZIP_DIR" "$AIO_ZIP_OUT" > '${dir}/seen'\n`,
      );
      await Deno.chmod(join(bin, "powershell"), 0o755);
      const out = join(dir, "out [2].zip");
      Deno.env.set("PATH", bin);
      assertEquals(await zipDir(app, out), true);
      assertEquals(
        await Deno.readTextFile(join(dir, "seen")),
        `${app}\n${out}\n`,
      );
    } finally {
      if (path !== undefined) Deno.env.set("PATH", path);
      await dropTempDir(dir);
    }
  },
});

Deno.test({
  name: "generated PowerShell: every script parses (needs pwsh on PATH)",
  ignore: !(await hasPwsh()),
  fn: async () => {
    const dir = await tempDir("aio-ps-parse-");
    try {
      const all = Object.entries(scripts());
      assertEquals(all.length, 8);
      for (const [name, text] of all) {
        const file = `${dir}/s.ps1`;
        await Deno.writeTextFile(file, text);
        const out = await new Deno.Command("pwsh", {
          args: [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "$null = [scriptblock]::Create([IO.File]::ReadAllText($env:AIO_PS_FILE))",
          ],
          env: { AIO_PS_FILE: file },
          stdout: "null",
          stderr: "piped",
        }).output();
        assertEquals(
          out.success,
          true,
          `${name}: ${new TextDecoder().decode(out.stderr)}`,
        );
      }
    } finally {
      await dropTempDir(dir);
    }
  },
});

async function hasPwsh(): Promise<boolean> {
  try {
    return (await new Deno.Command("pwsh", {
      args: ["-NoProfile", "-Command", "exit 0"],
      stdout: "null",
      stderr: "null",
    }).output()).success;
  } catch {
    return false; // not installed — the text checks above still run
  }
}
