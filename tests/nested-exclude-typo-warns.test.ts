// docs/auth/secrets-and-observability.md: a filter key that matches no state
// field is refused, "because a filter that silently matches nothing is a
// silent leak" — and nested `exclude` paths are supported. Only the HEAD of a
// dot-path was checked: `"accounts.encSeckey"` (typo) excluded nothing, and the
// secret went to disk / to every client without a word.
import { assert, assertEquals } from "@std/assert";
import { warnUnmatchedNestedExcludes } from "../src/state/cell-helpers.ts";

const collect = (
  state: Record<string, unknown>,
  visible: unknown,
  persist: unknown,
): string[] => {
  const out: string[] = [];
  warnUnmatchedNestedExcludes(
    "wallet",
    state,
    // deno-lint-ignore no-explicit-any
    visible as any,
    // deno-lint-ignore no-explicit-any
    persist as any,
    (m) => out.push(m),
  );
  return out;
};

Deno.test("a nested exclude path whose inner segment matches nothing in a closed declared shape warns, per side", () => {
  const state = { accounts: { encSecKey: "", pub: "" } };
  const w = collect(
    state,
    { exclude: ["accounts.encSeckey"] },
    { exclude: ["accounts.encSeckey"] },
  );
  assertEquals(w.length, 2, w.join("\n"));
  assert(w[0]!.includes('visible.exclude names "accounts.encSeckey"'), w[0]);
  assert(w[0]!.includes("sent to every client"), w[0]);
  assert(w[1]!.includes('persist.exclude names "accounts.encSeckey"'), w[1]);
  assert(w[1]!.includes("written to the database"), w[1]);
  // The correct spelling is silent.
  assertEquals(
    collect(state, { exclude: ["accounts.encSecKey"] }, {
      exclude: ["accounts.encSecKey"],
    }),
    [],
  );
});

Deno.test("a nested exclude under a shape that can hold undeclared fields is never judged", () => {
  // Array elements, a record (`{}`), a nullable object: any field may appear.
  const state = {
    rows: [] as { secret: string }[],
    byId: {} as Record<string, { secret: string }>,
    profile: null as { token: string } | null,
    // A record layer is skipped by the exclude walk: `deep.secret` matches
    // `deep.<any>.secret`.
    deep: { a: { secret: "" } },
  };
  assertEquals(
    collect(state, {
      exclude: ["rows.secret", "byId.secret", "profile.token", "deep.secret"],
    }, undefined),
    [],
  );
});

Deno.test("a nested exclude that names a top-level key literally called 'a.b' is not warned", () => {
  assertEquals(
    collect({ "a.b": 0, a: { c: 0 } }, undefined, { exclude: ["a.b"] }),
    [],
  );
});

Deno.test("a nested exclude naming an optional field the declaration omits is silent, a near-miss still warns", () => {
  // `type S = { settings: { theme: string; apiKey?: string } }` — the key is
  // written later by a method, and the runtime filter excludes it then.
  const state = { settings: { theme: "dark" } };
  assertEquals(collect(state, undefined, { exclude: ["settings.apiKey"] }), []);
  assertEquals(collect(state, { exclude: ["settings.apiKey"] }, undefined), []);
  const w = collect(state, undefined, { exclude: ["settings.theem"] });
  assertEquals(w.length, 1, w.join("\n"));
  assert(w[0]!.includes('did you mean "theme"'), w[0]);
});
