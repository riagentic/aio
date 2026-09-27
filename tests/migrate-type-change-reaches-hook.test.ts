// A version bump + `onMigrate` is the documented way to change a field's TYPE
// (cookbook #10; the dev shape-drift refusal says "bump the cell's version and
// add onMigrate"). The restore merge replaces a stored value of the old type
// with the declared default, so a hook that sees only its first argument
// cannot convert it: v1 `label: "hello"` → v2 `label: { t: "" }`.
//
// The first argument keeps its documented contract — merged with defaults —
// because hooks are written to it: handing the stored value there instead
// turned `s.tags.length ? s.tags : ["d"]` into `[]` (v1 `tags: ""`) and made a
// throwing hook run twice. The stored value is the THIRD argument, and a
// retyped field the hook never read from it is named in a warning.
import { assertEquals, assertMatch, assertThrows } from "@std/assert";
import { applyCellMigrations } from "../src/state/cell-migrate.ts";
import { deepMerge } from "../src/state/deep-merge.ts";

const declared = { label: { t: "" }, tags: [] as string[] };

type Hook = (
  s: Record<string, unknown>,
  from: number,
  stored?: Record<string, unknown>,
) => Record<string, unknown>;

function migrate(onMigrate: Hook, stored: Record<string, unknown>) {
  const warns: string[] = [];
  const log = {
    debug() {},
    info() {},
    warn: (m: string) => warns.push(m),
    error() {},
    // deno-lint-ignore no-explicit-any
  } as any;
  const state: Record<string, unknown> = {
    prefs: deepMerge(declared, stored), // what the restore hands over
  };
  applyCellMigrations(
    state,
    new Map([["prefs", { version: 2, initialState: declared, onMigrate }]]),
    { prefs: 1 },
    log,
    { prefs: stored },
    { prefs: declared },
  );
  return { state: state.prefs, warns };
}

Deno.test("onMigrate's first argument is merged with defaults, as documented", () => {
  let runs = 0;
  const { state, warns } = migrate((s) => {
    runs++;
    const tags = s.tags as string[];
    return { ...s, tags: tags.length ? [...tags, "new"] : ["d"] };
  }, { label: "hello", tags: "" });
  assertEquals(state, { label: { t: "" }, tags: ["d"] });
  assertEquals(runs, 1);
  // …and the stored values it never looked at are named, not lost in silence.
  assertMatch(
    warns.join("\n"),
    /never read the stored value\(s\) of label, tags/,
  );
});

Deno.test("onMigrate's third argument is the slice as stored — a retyped value converts", () => {
  const { state, warns } = migrate((s, _from, stored) => ({
    ...s,
    label: typeof stored?.label === "string" ? { t: stored.label } : s.label,
    tags: typeof stored?.tags === "string" ? stored.tags.split(",") : s.tags,
  }), { label: "hello", tags: "a,b" });
  assertEquals(state, { label: { t: "hello" }, tags: ["a", "b"] });
  assertEquals(warns, []);
});

Deno.test("a throwing onMigrate runs ONCE and refuses the boot", () => {
  let runs = 0;
  assertThrows(() =>
    migrate(() => {
      runs++;
      throw new Error("boom");
    }, { label: "hello", tags: "a,b" })
  );
  assertEquals(runs, 1);
});
