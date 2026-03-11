// Simple key-value wrapper over Deno.Kv — string keys, JSON values

/** Return type of skv() — thin KV wrapper */
export type SkvInstance = ReturnType<typeof skv>

/** Wraps Deno.Kv into a simple string-keyed get/set/del interface */
export const skv = (kv: Deno.Kv) => ({
  set: (key: string, val: unknown) => kv.set([key], val),       // persist a value
  get: <T>(key: string) => kv.get<T>([key]).then(e => e.value), // retrieve or null
  del: (key: string) => kv.delete([key]),                        // remove a key
  close: () => kv.close(),                                       // graceful shutdown

  // Multi-key: store each top-level property under [prefix, key] — bypasses 65KB/key limit.
  // Atomically writes all keys + deletes any keys present in `prevKeys` but not in `obj`.
  setMulti: (prefix: string, obj: Record<string, unknown>, prevKeys: string[] = []) => {
    let op = kv.atomic()
    for (const [k, v] of Object.entries(obj)) op = op.set([prefix, k], v)
    for (const k of prevKeys) if (!(k in obj)) op = op.delete([prefix, k])
    return op.commit()
  },

  // Reconstruct an object from all [prefix, *] entries — returns null if nothing stored.
  getMulti: async <T>(prefix: string): Promise<T | null> => {
    const result: Record<string, unknown> = {}
    let found = false
    const iter = kv.list({ prefix: [prefix] })
    for await (const entry of iter) {
      found = true
      result[entry.key[1] as string] = entry.value
    }
    return found ? result as T : null
  },
})
