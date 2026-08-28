// The docs must teach `am surface` / `am trigger` WITHOUT a client index.
//
// `am` already defaults to the newest UI client when no index is given
// (chooseUiClient); an explicit index is the server's per-connection COUNTER,
// not a position — and in dev, index 0 is usually the reload socket, which has
// no UI. Every guide used to print `am surface 0` / `am trigger 0 …`, so the
// first thing a reader copied was the one form that fails.
import { assertEquals } from "@std/assert";
import { walk } from "https://deno.land/std@0.208.0/fs/walk.ts";

const ROOT = new URL("../", import.meta.url).pathname;
const BAD = /\bam (surface|trigger) 0\b/;

async function offenders(): Promise<string[]> {
  const hits: string[] = [];
  const files = ["CLAUDE.md", "README.md"];
  for await (
    const e of walk(`${ROOT}docs`, { exts: [".md"], includeDirs: false })
  ) files.push(e.path.replace(ROOT, ""));
  for (const rel of files) {
    const lines = (await Deno.readTextFile(ROOT + rel)).split("\n");
    lines.forEach((l, i) => {
      if (BAD.test(l)) hits.push(`${rel}:${i + 1}: ${l.trim()}`);
    });
  }
  return hits;
}

Deno.test("docs never teach `am surface 0` / `am trigger 0` — the index is a counter, not a position", async () => {
  assertEquals(
    await offenders(),
    [],
    "drop the index (am drives the newest UI client) — see docs/clients/app-manager.md 'Which client?'",
  );
});

Deno.test("the regex catches the taught spellings (self-check)", () => {
  assertEquals(BAD.test("am surface 0 --json"), true);
  assertEquals(BAD.test('deno task am trigger 0 "App:X" click'), true);
  assertEquals(BAD.test("am surface --json"), false);
  assertEquals(BAD.test("am surface 03"), false);
});
