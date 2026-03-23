// factory.ts — actions() / effects() convenience factory
// PascalCase definitions → { PascalCase: 'type', camelCase(...) → { type, payload } }
// Optional domain prefix: actions('Counter', { ... }) → 'Counter:Increment'

/** Lowercase first character: 'Increment' → 'increment' */
export type LowerFirst<S extends string> = S extends `${infer C}${infer Rest}`
  ? `${Lowercase<C>}${Rest}`
  : S;

/** Map of named creator functions */
// deno-lint-ignore no-explicit-any
export type Creators = Record<string, (...args: any[]) => any>;

/** Prefix key with domain when provided */
export type Prefixed<D extends string, K> = D extends "" ? K
  : `${D}:${K & string}`;

/** Result type from factory — PascalCase labels + camelCase creators */
export type FactoryResult<T extends Creators, D extends string = ""> =
  & {
    readonly [K in keyof T]: Prefixed<D, K>;
  }
  & {
    readonly [K in keyof T as LowerFirst<K & string>]: (
      ...args: Parameters<T[K]>
    ) => { type: Prefixed<D, K>; payload: ReturnType<T[K]> };
  };

/** Lowercase first character at runtime */
function lowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

/** Creates a typed action/effect catalog — PascalCase labels + camelCase creators */
function factory<T extends Creators>(creators: T): FactoryResult<T, "">;
/** Creates a typed action/effect catalog with domain prefix */
function factory<D extends string, T extends Creators>(
  domain: D,
  creators: T,
): FactoryResult<T, D>;
function factory(first: unknown, second?: unknown): unknown {
  const domain = typeof first === "string" ? first : "";
  const creators = (typeof first === "string" ? second : first) as Creators;
  const prefix = domain ? `${domain}:` : "";
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(creators)) {
    result[key] = `${prefix}${key}`;
    result[lowerFirst(key)] = (...args: unknown[]) => ({
      type: `${prefix}${key}`,
      payload: creators[key]!(...args) ?? {},
    });
  }
  return result;
}

export { factory as actions, factory as effects };
