// Every wall has a door (feedback/frustration.md F5).
//
// An error that says WHAT went wrong but not what to DO is a wall: "check
// for missing dependencies", "guard against already-cleaned resources". The
// reader knows they are stuck and nothing else. Each tip an emitted error
// code can print must name a door — a command or config key (in backticks),
// a `--flag`, or a docs/ page — and a named page must exist. The four
// reserved codes (never emitted; tests/error-code-emission.test.ts) are out.
import { assert, assertEquals } from "@std/assert";
import {
  type AioErrorCode,
  type AioErrorContext,
  createAioError,
  generateTip,
  PERSIST_WRITTEN_ANYWAY,
} from "../src/diagnostics/error.ts";

const REPO = new URL("../", import.meta.url).pathname;
const DOOR = /`[^`]+`|docs\/[\w./-]+\.md|(^|\s)--[a-z]/;

const src = Deno.readTextFileSync(`${REPO}src/diagnostics/error.ts`);
const union = src.slice(
  src.indexOf("export type AioErrorCode"),
  src.indexOf("// ── Reserved"),
);
const EMITTED = [...union.matchAll(/\|\s*"([A-Z_]+)"/g)].map((m) =>
  m[1] as AioErrorCode
);

/** Each code in the shapes that take a different branch of its tip. */
const SHAPES: { why: string; raw: unknown; ctx: AioErrorContext }[] = [
  { why: "plain", raw: "it failed", ctx: { cellName: "c", actionType: "c:m" } },
  {
    why: "proxy",
    raw: "proxy ownKeys trap",
    ctx: { cellName: "c", actionType: "c:__setItems" },
  },
  { why: "runner", raw: "x", ctx: { cellName: "c", effectType: "c:__exec" } },
  { why: "no action", raw: "x", ctx: { cellName: "c", effectType: "fx" } },
  { why: "disk", raw: "database or disk is full", ctx: { cellName: "c" } },
  {
    why: "written anyway",
    raw: Object.assign(new Error("kept"), { name: PERSIST_WRITTEN_ANYWAY }),
    ctx: { cellName: "c" },
  },
  {
    why: "frozen",
    raw: new TypeError("Cannot assign to read only property 'n' of object"),
    ctx: { cellName: "c", actionType: "c:m" },
  },
];

Deno.test("every emitted error code has a tip that names a door", () => {
  assert(EMITTED.length >= 20, `parsed ${EMITTED.length} codes`);
  const walls: string[] = [];
  const missingDocs = new Set<string>();
  let checked = 0;
  for (const code of EMITTED) {
    for (const { why, raw, ctx } of SHAPES) {
      const tip = generateTip(createAioError(code, raw, ctx));
      checked++;
      if (!tip || !DOOR.test(tip)) {
        walls.push(`${code} (${why}): ${tip ?? "no tip at all"}`);
      }
      for (const [doc] of (tip ?? "").matchAll(/docs\/[\w./-]+\.md/g)) {
        try {
          Deno.statSync(REPO + doc);
        } catch {
          missingDocs.add(`${code}: ${doc}`);
        }
      }
    }
  }
  assertEquals(checked, EMITTED.length * SHAPES.length);
  assertEquals(
    walls,
    [],
    "a tip with no door — name a command/key in backticks, a --flag, or a " +
      "docs/ page:\n  " + walls.join("\n  "),
  );
  assertEquals([...missingDocs], [], "a tip names a doc that does not exist");
});

Deno.test("the door check itself: a vague tip is a wall, a named one is not", () => {
  assert(!DOOR.test("Tip: check for missing dependencies."));
  assert(!DOOR.test("Tip: try re-running with more memory-limit"));
  assert(DOOR.test("Tip: run `am timeline`."));
  assert(DOOR.test("Tip: see docs/state/lifecycle.md."));
  assert(DOOR.test("Tip: restart with --cdp."));
});
