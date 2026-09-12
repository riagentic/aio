/**
 * @module
 * `args:` — an optional schema for a method's arguments.
 *
 * The boundary is untyped at RUNTIME. A method's TypeScript signature protects
 * the call sites you compile; nothing protects `am dispatch`, a hand-written
 * `{ type, payload: { args } }`, a form, a URL, or an agent. aio already warns
 * when the arity is wrong — that warning exists precisely because the boundary
 * is untyped — and two field reports counted the consequence: a dozen
 * hand-written coercions in one week (report 9 §9.6, report 3 §12.7).
 *
 * ```ts
 * cell("user", {
 *   state: { age: 0 },
 *   args: { setAge: [z.number().int().min(0)] },
 *   methods: { setAge(s, age: number) { s.age = age } },
 * })
 * ```
 *
 * STANDARD SCHEMA, not a DSL of aio's own. Zod, Valibot and ArkType all
 * implement it, so this is the app's existing validator doing the job it
 * already does — and an app using none of them can pass a plain predicate.
 * Inventing a schema language here would have meant a second one to learn and
 * a second one to keep correct.
 *
 * It COERCES as well as refuses: a Standard Schema returns the parsed value,
 * and that value is what the method receives. That is the dozen hand-written
 * coercions, deleted.
 */

/** One Standard Schema issue. `path` is what lets an OBJECT schema's failures
 *  be attributed to the field that caused them — `useForm` reads the first
 *  segment as the field name. The spec allows either a bare key or a
 *  `{ key }` wrapper, and both appear in the wild. */
export type StandardSchemaIssue = {
  readonly message: string;
  readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }>;
};

/** The Standard Schema v1 surface, as much of it as this needs.
 *
 *  Structural, not an import: taking a dependency on the spec package to read
 *  one well-known property would put a package in aio's graph for a type. */
export type StandardSchemaLike = {
  readonly "~standard": {
    readonly version: number;
    readonly vendor: string;
    readonly validate: (
      value: unknown,
    ) =>
      | { value: unknown; issues?: undefined }
      | { issues: readonly StandardSchemaIssue[] }
      | Promise<unknown>;
  };
};

/** One argument's rule: a Standard Schema, or a predicate returning `true` or
 *  the reason it is not. `null` skips a position. */
export type ArgSpec =
  | StandardSchemaLike
  | ((value: unknown) => true | string)
  | null;

/** Per-method argument rules, keyed by method name. */
export type ArgSchemas = Record<string, readonly ArgSpec[]>;

/** Is this a Standard Schema? */
export function isStandardSchema(v: unknown): v is StandardSchemaLike {
  if (v === null || typeof v !== "object") return false;
  const std = (v as Record<string, unknown>)["~standard"];
  return !!std && typeof std === "object" &&
    typeof (std as Record<string, unknown>).validate === "function";
}

/** Validate (and coerce) one method's arguments.
 *
 *  Returns the arguments the method should receive — coerced where a schema
 *  parsed them. Throws with `cell:method`, the POSITION and the reason on the
 *  first failure.
 *
 *  Positions beyond the declared list are passed through untouched: declaring
 *  a rule for the first argument must not silently forbid the rest.
 *
 *  ASYNC VALIDATION IS REFUSED, by name. This runs on the dispatch path, which
 *  is synchronous for a sync method — awaiting here would make one method kind
 *  behave differently from the other, and a schema that silently did not run is
 *  worse than no schema, because the app believes the boundary is guarded. */
export function validateMethodArgs(
  cell: string,
  method: string,
  specs: readonly ArgSpec[] | undefined,
  args: readonly unknown[],
): unknown[] {
  if (!specs || specs.length === 0) return args as unknown[];
  const out = [...args];
  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i];
    if (!spec) continue;
    const where = `[${cell}:${method}] argument ${i + 1}`;
    if (typeof spec === "function") {
      const verdict = spec(out[i]);
      if (verdict !== true) {
        throw new Error(
          `${where} is invalid: ${
            typeof verdict === "string" ? verdict : "the check returned false"
          }`,
        );
      }
      continue;
    }
    if (!isStandardSchema(spec)) {
      // Neither a predicate nor a Standard Schema. Without this the next line
      // is `undefined is not a function` from inside aio, for a value the app
      // put in its own config.
      throw new Error(
        `${where}: the rule in \`args\` is neither a function nor a Standard ` +
          `Schema (got ${
            spec === null ? "null" : typeof spec
          }).\n  fix: pass a schema from Zod / Valibot / ArkType, a predicate ` +
          `\`(v) => true | "why not"\`, or \`null\` to skip this position.`,
      );
    }
    const res = spec["~standard"].validate(out[i]);
    if (res instanceof Promise) {
      throw new Error(
        `${where}: the schema validates ASYNCHRONOUSLY, and aio checks ` +
          `arguments on the dispatch path, which is synchronous for a sync ` +
          `method.\n` +
          `  fix: use the schema's sync form, or validate inside the method ` +
          `itself where you can await it. A schema that silently did not run ` +
          `would be worse than none — the app would believe the boundary is ` +
          `guarded.`,
      );
    }
    if ("issues" in res && res.issues) {
      const why = res.issues.map((x) => x.message).join("; ") ||
        "it did not match the schema";
      throw new Error(`${where} is invalid: ${why}`);
    }
    // COERCED. A schema returns the parsed value, and that is what the method
    // gets — which is the dozen hand-written coercions the reports counted.
    out[i] = (res as { value: unknown }).value;
  }
  return out;
}
