// Shared { type, payload } constructor — used by both server (mod.ts) and browser (browser.ts)
export function msg<T extends string>(type: T): { type: T; payload: Record<string, never> }
export function msg<T extends string, P>(type: T, payload: P): { type: T; payload: P }
export function msg(type: string, payload?: unknown) {
  return { type, payload: payload ?? {} }
}
