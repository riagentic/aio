// factory.ts — actions() / effects() convenience factory
// PascalCase definitions → { PascalCase: 'type', camelCase(...) → { type, payload } }
// Optional domain prefix: actions('Counter', { ... }) → 'Counter:Increment'

/** Lowercase first character: 'Increment' → 'increment' */
type LowerFirst<S extends string> = S extends `${infer C}${infer Rest}` ? `${Lowercase<C>}${Rest}` : S

// deno-lint-ignore no-explicit-any
type Creators = Record<string, (...args: any[]) => any>

/** Prefix key with domain when provided */
type Prefixed<D extends string, K> = D extends '' ? K : `${D}:${K & string}`

type FactoryResult<T extends Creators, D extends string = ''> = {
  readonly [K in keyof T]: Prefixed<D, K>
} & {
  readonly [K in keyof T as LowerFirst<K & string>]: (...args: Parameters<T[K]>) => { type: Prefixed<D, K>; payload: ReturnType<T[K]> }
}

/**
 * Discriminated union from action/effect catalog.
 *
 * @example
 * ```ts
 * const A = actions('Counter', {
 *   Increment: (by: number) => ({ by }),
 *   Reset: () => ({}),
 * })
 * type Action = UnionOfAction<typeof A>
 * // => { type: 'Counter:Increment'; payload: { by: number } } | { type: 'Counter:Reset'; payload: {} }
 * ```
 */
// deno-lint-ignore no-explicit-any
export type UnionOfAction<T extends Record<string, (...args: any[]) => any>> = {
  [K in keyof T]: T[K] extends (...args: infer _A) => infer R ? { type: K; payload: R } : never
}[keyof T]

/** Lowercase first character at runtime */
function lowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1)
}

/** Creates a typed action/effect catalog — PascalCase labels + camelCase creators */
function factory<T extends Creators>(creators: T): FactoryResult<T, ''>
function factory<D extends string, T extends Creators>(domain: D, creators: T): FactoryResult<T, D>
function factory(first: unknown, second?: unknown): unknown {
  const domain = typeof first === 'string' ? first : ''
  const creators = (typeof first === 'string' ? second : first) as Creators
  const prefix = domain ? `${domain}:` : ''
  const result: Record<string, unknown> = {}
  for (const key of Object.keys(creators)) {
    result[key] = `${prefix}${key}`
    result[lowerFirst(key)] = (...args: unknown[]) => ({ type: `${prefix}${key}`, payload: creators[key](...args) ?? {} })
  }
  return result
}

export { factory as actions, factory as effects }