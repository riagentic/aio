// factory.ts — actions() / effects() convenience factory
// PascalCase definitions → { PascalCase: 'type', camelCase(...) → { type, payload } }

/** Lowercase first character: 'Increment' → 'increment' */
type LowerFirst<S extends string> = S extends `${infer C}${infer Rest}` ? `${Lowercase<C>}${Rest}` : S

// deno-lint-ignore no-explicit-any
type Creators = Record<string, (...args: any[]) => any>

type FactoryResult<T extends Creators> = {
  readonly [K in keyof T]: K
} & {
  readonly [K in keyof T as LowerFirst<K & string>]: (...args: Parameters<T[K]>) => { type: K; payload: ReturnType<T[K]> }
}

/** Lowercase first character at runtime */
function lowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1)
}

/** Creates a typed action/effect catalog — PascalCase labels + camelCase creators */
function factory<T extends Creators>(creators: T): FactoryResult<T> {
  const result: Record<string, unknown> = {}
  for (const key of Object.keys(creators)) {
    result[key] = key
    result[lowerFirst(key)] = (...args: unknown[]) => ({ type: key, payload: creators[key](...args) ?? {} })
  }
  return result as FactoryResult<T>
}

export { factory as actions, factory as effects }
