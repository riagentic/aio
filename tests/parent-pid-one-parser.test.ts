// `AIO_PARENT_PID` had three parsers: `parentPidOf` (decimal digits only) and
// two `Number()` copies (the lock's dev-supervisor pid, the dev restart's
// hand-over) that also took `0x10`, `1e3`, `+42`. One parser now: every read
// in src/server goes through `parentPidOf` (src/electron keeps its own,
// commented twin — that folder may not import server).
import { assert, assertEquals } from "@std/assert";
import { walk } from "@std/fs";
import { fromFileUrl } from "@std/path";
import { parentPidOf } from "../src/server/process-liveness.ts";

const SERVER = fromFileUrl(new URL("../src/server/", import.meta.url));
const READ = /(?:env|Deno\.env\.get)\("AIO_PARENT_PID"\)/;

Deno.test("AIO_PARENT_PID: every server read goes through parentPidOf", async () => {
  const bad: string[] = [];
  let reads = 0;
  for await (const f of walk(SERVER, { exts: [".ts"] })) {
    const src = await Deno.readTextFile(f.path);
    src.split("\n").forEach((line, i) => {
      if (!READ.test(line) || line.trimStart().startsWith("//")) return;
      reads++;
      const v = /const (\w+) = /.exec(line)?.[1];
      const ok = line.includes("parentPidOf(") ||
        (v !== undefined && src.includes(`parentPidOf(${v})`));
      if (!ok) bad.push(`${f.name}:${i + 1}: ${line.trim()}`);
    });
  }
  assert(reads >= 3, `walk found only ${reads} reads — the gate reads nothing`);
  assert(bad.length === 0, `own AIO_PARENT_PID parsing:\n${bad.join("\n")}`);
});

Deno.test("parentPidOf: decimal digits only — the spellings Number() also took are unset", () => {
  assertEquals(parentPidOf("4242"), 4242);
  for (const bad of ["0x10", "1e3", "+42", "0b101", "0", "-1", "", undefined]) {
    assertEquals(parentPidOf(bad), undefined, String(bad));
  }
});
