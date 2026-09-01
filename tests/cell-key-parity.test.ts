// The runtime's key set and the TYPE's keys must agree.
//
// Field report (quant, a 24/7 trading desk): "the most expensive aio bug I have
// hit, by a wide margin. Cost: 61 type errors, about half a day, and — much
// worse — EIGHT RELEASES of silently degraded type safety that nothing
// reported."
//
// `ui:` was renamed to `visible:` in alpha52 and dropped from
// `MethodsCellConfig` in alpha70, while `VALID_CELL_KEYS` kept accepting it. So
// the cells kept WORKING, the config stopped matching the public `cell()`
// overload, `cell()` fell through to its implementation signature —
// `cell(name, config: any): any` — and the cells lost their `DirectCalling`
// method types. The visible result was 59 × TS2722 on the CALL SITES, in files
// that had not changed, with nothing pointing anywhere near the cause.
//
// The class, in their words: "whenever VALID_CELL_KEYS (runtime) and
// MethodsCellConfig (type) disagree, an app gets a working runtime and a dead
// type system, and `cell()`'s `any` fallback guarantees no error points
// anywhere near the cause."
//
// This is their suggested fix #1 — the few lines that close it forever.
import { assert, assertEquals } from "@std/assert";
/** Keys `cell()` accepts that `MethodsCellConfig` does not declare.
 *
 *  EMPTY, and the state to defend — it lives here rather than in `src/` because
 *  it is this gate's allowlist and nothing in the product reads it.
 *
 *  `ui` looked like it wanted to be an entry. It is not one: it is RETIRED —
 *  refused in dev and logged-and-honoured in prod by `resolveVisibility` — and
 *  belongs in neither the type nor `VALID_CELL_KEYS`. An entry appearing here
 *  later is a decision somebody makes out loud, and it must ALSO be declared
 *  `@deprecated` in the type, or the rename is invisible where it happens.
 *
 *  What a runtime-only key costs, from the field report that paid for it: the
 *  config stops matching the public `cell()` overload, `cell()` falls back to
 *  `(name, config: any): any`, and every method type on that cell disappears —
 *  visible only as errors on unrelated call sites, for eight releases. */
const RENAMED_CELL_KEYS: ReadonlyArray<readonly [string, string]> = [];

const ROOT = new URL("..", import.meta.url).pathname;

/** Top-level keys of the `MethodsCellConfig` type literal. Parsed rather than
 *  reflected because a TypeScript type does not exist at runtime — which is
 *  exactly why the two drifted with nothing to notice. */
function typeKeys(): Set<string> {
  const src = Deno.readTextFileSync(
    `${ROOT}src/state/cell-config-types.ts`,
  );
  const i = src.indexOf("export type MethodsCellConfig");
  assert(i >= 0, "MethodsCellConfig moved — this gate must follow it");
  const open = src.indexOf("= {", i) + 2;
  let depth = 0, end = -1;
  for (let k = open; k < src.length; k++) {
    if (src[k] === "{") depth++;
    else if (src[k] === "}" && --depth === 0) {
      end = k;
      break;
    }
  }
  assert(end > 0, "could not find the end of the type literal");
  const keys = new Set<string>();
  let d = 0;
  for (const line of src.slice(open, end).split("\n")) {
    const m = /^([A-Za-z_]\w*)\??\s*:/.exec(line.trim());
    if (d === 1 && m) keys.add(m[1]!);
    for (const ch of line) {
      if (ch === "{" || ch === "[") d++;
      else if (ch === "}" || ch === "]") d--;
    }
  }
  return keys;
}

/** The runtime's accepted set, read from the same source of truth `cell()` uses. */
function runtimeKeys(): Set<string> {
  const src = Deno.readTextFileSync(`${ROOT}src/state/cell-create.ts`);
  const i = src.indexOf("const VALID_CELL_KEYS");
  assert(i >= 0, "VALID_CELL_KEYS moved — this gate must follow it");
  const block = src.slice(i, src.indexOf("]);", i));
  return new Set([...block.matchAll(/"(\w+)"/g)].map((m) => m[1]!));
}

Deno.test("cell keys: the runtime accepts exactly what the type declares", () => {
  const type = typeKeys();
  const runtime = runtimeKeys();
  assert(type.size > 10 && runtime.size > 10, "both sets must have parsed");

  // A key the runtime takes and the type does not: the app WORKS and its types
  // die. Allowed only as a declared alias, which must ALSO be typed
  // `@deprecated` so the rename lands as a squiggle on the key itself.
  const aliases = new Set(RENAMED_CELL_KEYS.map(([old]) => old));
  const runtimeOnly = [...runtime].filter((k) => !type.has(k)).sort();
  assertEquals(
    runtimeOnly.filter((k) => !aliases.has(k)),
    [],
    "a key the runtime accepts and the type has dropped makes `cell()` fall " +
      "back to `any` and silently deletes every method type. Add it to " +
      "MethodsCellConfig (as `@deprecated` if it is a rename) or stop " +
      "accepting it",
  );

  // The other direction is the ordinary kind of broken: a documented option
  // that throws "unknown option" the first time anyone uses it.
  assertEquals(
    [...type].filter((k) => !runtime.has(k)).sort(),
    [],
    "a key the type declares and the runtime refuses is an option that " +
      "type-checks and then throws at cell() time",
  );
});

Deno.test("cell keys: the alias list is EMPTY, and every entry would be real", () => {
  const type = typeKeys();
  const runtime = runtimeKeys();
  const src = Deno.readTextFileSync(`${ROOT}src/state/cell-config-types.ts`);
  // EMPTY is the correct state and the one to defend. `ui` looked like it
  // wanted to be an alias here; it is not one — it is RETIRED, refused in dev
  // and logged-and-honoured in prod by `resolveVisibility`, and it belongs in
  // neither the type nor `VALID_CELL_KEYS`. An entry appearing here later is a
  // deliberate decision, and these are the conditions it has to meet.
  assertEquals(
    RENAMED_CELL_KEYS.map(([old]) => old),
    [],
    "a runtime-only key drops `cell()` to `any` and deletes every method type",
  );
  for (const [old, now] of RENAMED_CELL_KEYS) {
    assert(runtime.has(old), `alias "${old}" is not accepted at runtime`);
    assert(
      type.has(old),
      `alias "${old}" must stay in the TYPE — that is the whole fix: without ` +
        `it, a config using it drops to \`any\``,
    );
    assert(type.has(now), `"${now}" (the current spelling) must be typed`);
    // Typed, but marked — otherwise the alias is just a second way to write it.
    const at = src.indexOf(`\n  ${old}?:`);
    assert(at > 0, `"${old}" must be a top-level key of MethodsCellConfig`);
    assert(
      src.lastIndexOf("@deprecated", at) >
        src.lastIndexOf("\n  visible?:", at) - 4000,
      `"${old}" must carry an @deprecated tag, or the rename is invisible`,
    );
  }
});
