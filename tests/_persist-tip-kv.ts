import type { SkvInstance } from "../src/server/skv.ts";
/** A plain in-memory SkvInstance with no planned-statement support, so the
 *  manager takes its direct-write path. */
export function createMemoryKv(): SkvInstance {
  const m = new Map<string, string>();
  const ok = { ok: true as const, versionstamp: "" };
  return {
    set: (k, v) => (m.set(k, JSON.stringify(v)), Promise.resolve(ok)),
    get: <T>(k: string) =>
      Promise.resolve(m.has(k) ? JSON.parse(m.get(k)!) as T : null),
    del: (k) => (m.delete(k), Promise.resolve()),
    close: () => {},
    setMulti: (p, o) => {
      for (const [k, v] of Object.entries(o)) {
        m.set(`${p}\x1f${k}`, JSON.stringify(v));
      }
      return Promise.resolve(ok);
    },
    getMulti: () => Promise.resolve(null),
  };
}
