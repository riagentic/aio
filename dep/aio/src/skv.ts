// Simple key-value wrapper over Deno.Kv — string keys, JSON values

/** Return type of skv() — thin KV wrapper */
export type SkvInstance = ReturnType<typeof skv>

/** Wraps Deno.Kv into a simple string-keyed get/set/del interface */
export const skv = (kv: Deno.Kv) => ({
  set: (key: string, val: unknown) => kv.set([key], val),       // persist a value
  get: <T>(key: string) => kv.get<T>([key]).then(e => e.value), // retrieve or null
  del: (key: string) => kv.delete([key]),                        // remove a key
  close: () => kv.close(),                                       // graceful shutdown
})
