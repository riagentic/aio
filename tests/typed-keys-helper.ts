// ONE way to ask "what keys does this config type declare, and which of them
// hold a function?"
//
// There were two. `tests/config-allowlist.test.ts` has extracted real typed
// keys via `deno doc --json` since the allowlist-drift class was killed; a
// later completeness test parsed the type file with a regex instead, and paid
// for it immediately — `long?: (keyof M & string)[]` is a parenthesised ARRAY,
// and `key?: (` had reported it as a function. `deno doc` answers that question
// with the compiler's own view (`tsType.kind === "fnOrConstructor"`), so the
// question is asked once, in one place.
import { assert } from "@std/assert";

// Coverage profiles from spawned deno processes go to a throwaway temp dir —
// never into the repo (an empty DENO_COVERAGE_DIR means "cwd"), never into
// the parent's coverage profile.
const _childCovDir = Deno.env.get("DENO_COVERAGE_DIR") ??
  Deno.makeTempDirSync({ prefix: "aio-child-cov-" });

export type TypedProp = { name: string; optional: boolean; isFn: boolean };

/** Every declared property of `typeName` in `file`, with its shape. */
export async function typedProps(
  file: string,
  typeName: string,
): Promise<TypedProp[]> {
  const out = await new Deno.Command(Deno.execPath(), {
    env: { DENO_COVERAGE_DIR: _childCovDir },
    args: ["doc", "--json", file],
    cwd: new URL("..", import.meta.url).pathname,
    stdout: "piped",
    stderr: "null",
  }).output();
  const doc = JSON.parse(new TextDecoder().decode(out.stdout)) as {
    nodes: Record<string, { symbols: Array<Record<string, unknown>> }>;
  };
  const symbols = Object.values(doc.nodes)[0]!.symbols;
  const sym = symbols.find((s) => s.name === typeName) as {
    declarations: Array<{ kind: string; def: Record<string, unknown> }>;
  } | undefined;
  assert(sym, `type ${typeName} not found in ${file} doc output`);

  const props: TypedProp[] = [];
  // deno-lint-ignore no-explicit-any
  const push = (p: any): void =>
    void props.push({
      name: p.name,
      optional: p.optional === true,
      isFn: p.tsType?.kind === "fnOrConstructor",
    });
  // deno-lint-ignore no-explicit-any
  const collect = (t: any): void => {
    if (!t) return;
    if (t.kind === "typeLiteral") {
      for (const p of t.value?.properties ?? t.typeLiteral?.properties ?? []) {
        push(p);
      }
    } else if (t.kind === "intersection" || t.kind === "union") {
      for (const part of t.value ?? []) collect(part);
    } else if (t.kind === "parenthesized") {
      // `A & (B | C)` — the union arrives wrapped, and without this the walk
      // stops at the parenthesis and returns only the intersection's own keys.
      // The "extracted too few keys" assertion below is what caught that, which
      // is the whole reason it is there.
      collect(t.parenthesized ?? t.value);
    }
  };
  for (const decl of sym.declarations) {
    if (decl.kind === "typeAlias") {
      collect((decl.def as { tsType?: unknown })?.tsType);
    }
    if (decl.kind === "interface") {
      // deno-lint-ignore no-explicit-any
      for (const p of (decl.def as any)?.properties ?? []) push(p);
    }
  }
  assert(
    props.length > 3,
    `extracted too few keys for ${typeName} — doc shape drifted?`,
  );
  return props;
}

/** Public (non `_`-prefixed) key names — what an app may actually write. */
export async function typedKeys(
  file: string,
  typeName: string,
): Promise<string[]> {
  return (await typedProps(file, typeName))
    .map((p) => p.name)
    .filter((n) => !n.startsWith("_"));
}
