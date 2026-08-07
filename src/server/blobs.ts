// blobs.ts — the binary-tier primitive (`app.blobs`).
//
// A content-addressed byte store under `appDirs(appId).files/blobs/` — tier ③
// of docs/persistence/big-data.md made first-class. Bytes NEVER enter cell
// state, the persist flush, or the wire: the WS/UDS envelope carries blob IDS
// only, and the bytes travel over HTTP (`/__aio/blobs/<id>`, Range-capable,
// immutably cacheable — the id IS the content hash) or plain file streams.
//
// Layout, one directory:
//   <data>/files/blobs/<sha256-hex>        the bytes (the id names them)
//   <data>/files/blobs/<sha256-hex>.json   optional metadata ({ name })
//   <data>/files/blobs/.tmp-<uuid>         in-flight put (renamed or removed)
//
// `put()` STREAMS: chunks are hashed and written to a temp file as they
// arrive, then the temp file is fsynced and renamed to its hash — a blob is
// either fully present under its correct id or absent; a crash leaves only a
// `.tmp-*` file (swept on the next put). The whole blob is never buffered, so
// a multi-GB upload costs one chunk of memory. Same bytes → same id → one
// file (dedup by construction).

import { join } from "@std/path";
import { createHash } from "node:crypto";
import { appDirs } from "./app-dirs.ts";

/** What the store knows about one blob. */
export type BlobInfo = {
  /** sha256 hex of the content — the id IS the address. */
  id: string;
  /** Size in bytes. */
  size: number;
  /** Optional display name recorded at put() time (metadata only — it never
   *  affects the id; two puts of the same bytes are ONE blob). */
  name?: string;
};

/** Content-addressed binary store — `app.blobs`, or `openBlobStore(appId)`
 *  headlessly. All paths derive from ONE directory inside the app's backup
 *  unit (`<data>/files/blobs`). */
export interface BlobStore {
  /** Store bytes (buffer or stream) → `{ id, size, name? }`. Streaming input
   *  is hashed and spooled to a temp file chunk by chunk — never buffered
   *  whole — then renamed to its content hash. Re-putting identical bytes
   *  returns the same id and keeps ONE file. */
  put(
    data: Uint8Array | ReadableStream<Uint8Array>,
    opts?: { name?: string },
  ): Promise<BlobInfo>;
  /** Stream a blob's bytes. `start`/`end` select a byte window
   *  (end EXCLUSIVE, like `Array.slice`) — the seam HTTP Range serving uses.
   *  Throws (loudly, naming the id) when the blob does not exist. */
  stream(
    id: string,
    opts?: { start?: number; end?: number },
  ): Promise<ReadableStream<Uint8Array>>;
  /** Metadata for one blob, or null when absent. */
  info(id: string): Promise<BlobInfo | null>;
  /** The HTTP path this blob is served at (`/__aio/blobs/<id>`) — subject to
   *  the app's auth gate exactly like every other app resource. */
  url(id: string): string;
  /** Remove a blob (+ its metadata). True when something was deleted. */
  delete(id: string): Promise<boolean>;
  /** Every stored blob (unordered). */
  list(): Promise<BlobInfo[]>;
  /** The directory blobs live in — inside `appDirs(appId).files`, i.e. inside
   *  THE backup unit. */
  dir: string;
}

/** The one URL namespace blob bytes are served under. */
export const BLOB_URL_PREFIX = "/__aio/blobs/";

/** A valid blob id — 64 lowercase hex chars (sha256). ONE decider: the store
 *  methods and the HTTP route both validate with this, so a crafted "id" can
 *  never become a path segment. */
export const BLOB_ID_RE = /^[0-9a-f]{64}$/;

function assertBlobId(id: string): void {
  if (!BLOB_ID_RE.test(id)) {
    throw new Error(
      `blobs: invalid blob id ${
        JSON.stringify(id)
      } — an id is the sha256 hex ` +
        `of the content (64 lowercase hex chars), as returned by blobs.put()`,
    );
  }
}

const metaPath = (dir: string, id: string) => join(dir, `${id}.json`);

async function readName(dir: string, id: string): Promise<string | undefined> {
  try {
    const meta = JSON.parse(await Deno.readTextFile(metaPath(dir, id))) as {
      name?: unknown;
    };
    return typeof meta.name === "string" ? meta.name : undefined;
  } catch {
    return undefined; // no metadata — the blob is still fully valid
  }
}

/** Sweep `.tmp-*` leftovers older than an hour — a crashed put() must not
 *  leak disk forever. Best-effort by design (a locked file must not fail an
 *  unrelated put). */
async function sweepStaleTmp(dir: string): Promise<void> {
  try {
    for await (const e of Deno.readDir(dir)) {
      if (!e.isFile || !e.name.startsWith(".tmp-")) continue;
      try {
        const st = await Deno.stat(join(dir, e.name));
        const age = Date.now() - (st.mtime?.getTime() ?? 0);
        if (age > 3600_000) await Deno.remove(join(dir, e.name));
      } catch { /* raced with its own put — leave it */ }
    }
  } catch { /* dir vanished — nothing to sweep */ }
}

function makeStore(dir: string): BlobStore {
  let ensured = false;
  async function ensureDir(): Promise<void> {
    if (ensured) return;
    await Deno.mkdir(dir, { recursive: true });
    ensured = true;
    void sweepStaleTmp(dir);
  }

  async function put(
    data: Uint8Array | ReadableStream<Uint8Array>,
    opts?: { name?: string },
  ): Promise<BlobInfo> {
    await ensureDir();
    const tmp = join(dir, `.tmp-${crypto.randomUUID()}`);
    const hash = createHash("sha256");
    let size = 0;
    const file = await Deno.open(tmp, { write: true, createNew: true });
    try {
      const write = async (chunk: Uint8Array) => {
        if (!(chunk instanceof Uint8Array)) {
          throw new Error(
            `blobs: put() stream must yield Uint8Array chunks — got ` +
              `${typeof chunk}. Wrap text in new TextEncoder().encode(...).`,
          );
        }
        hash.update(chunk);
        size += chunk.byteLength;
        let off = 0;
        while (off < chunk.byteLength) {
          off += await file.write(chunk.subarray(off));
        }
      };
      if (data instanceof Uint8Array) {
        await write(data);
      } else {
        for await (const chunk of data) await write(chunk);
      }
      // The rename must never be persisted ahead of the bytes it names — a
      // power cut would otherwise leave a blob whose content does not match
      // its hash, which is the one lie a content-addressed store cannot tell.
      await file.sync();
    } catch (e) {
      file.close();
      await Deno.remove(tmp).catch(() => {});
      throw e;
    }
    file.close();

    const id = hash.digest("hex");
    const path = join(dir, id);
    let existed = false;
    try {
      await Deno.stat(path);
      existed = true;
    } catch { /* new blob */ }
    if (existed) {
      // Dedup: the bytes are already here under their hash — one file.
      await Deno.remove(tmp).catch(() => {});
    } else {
      try {
        await Deno.rename(tmp, path);
      } catch (e) {
        // Windows refuses rename-onto-existing: a concurrent put of the SAME
        // content won the race — that is dedup, not failure.
        try {
          await Deno.stat(path);
          await Deno.remove(tmp).catch(() => {});
        } catch {
          await Deno.remove(tmp).catch(() => {});
          throw e;
        }
      }
    }
    // Metadata: first name wins (the blob identity is its content — a second
    // put with a different name must not rewrite what the first recorded).
    let name = await readName(dir, id);
    if (name === undefined && opts?.name !== undefined) {
      name = opts.name;
      await Deno.writeTextFile(metaPath(dir, id), JSON.stringify({ name }))
        .catch(() => {/* metadata is best-effort; the bytes are landed */});
    }
    return { id, size, ...(name !== undefined ? { name } : {}) };
  }

  async function info(id: string): Promise<BlobInfo | null> {
    assertBlobId(id);
    try {
      const st = await Deno.stat(join(dir, id));
      const name = await readName(dir, id);
      return { id, size: st.size, ...(name !== undefined ? { name } : {}) };
    } catch {
      return null;
    }
  }

  async function stream(
    id: string,
    opts?: { start?: number; end?: number },
  ): Promise<ReadableStream<Uint8Array>> {
    assertBlobId(id);
    let file: Deno.FsFile;
    try {
      file = await Deno.open(join(dir, id), { read: true });
    } catch {
      throw new Error(
        `blobs: no blob ${id} in ${dir} — it was never put(), or was deleted`,
      );
    }
    const start = opts?.start ?? 0;
    let remaining = opts?.end !== undefined ? opts.end - start : Infinity;
    if (start > 0) await file.seek(start, Deno.SeekMode.Start);
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (remaining <= 0) {
          controller.close();
          file.close();
          return;
        }
        const buf = new Uint8Array(Math.min(64 * 1024, remaining));
        let n: number | null;
        try {
          n = await file.read(buf);
        } catch (e) {
          file.close();
          controller.error(e);
          return;
        }
        if (n === null) {
          controller.close();
          file.close();
          return;
        }
        remaining -= n;
        controller.enqueue(buf.subarray(0, n));
      },
      cancel() {
        file.close();
      },
    });
  }

  return {
    dir,
    put,
    info,
    stream,
    url: (id: string) => {
      assertBlobId(id);
      return BLOB_URL_PREFIX + id;
    },
    delete: async (id: string) => {
      assertBlobId(id);
      let removed = false;
      try {
        await Deno.remove(join(dir, id));
        removed = true;
      } catch { /* absent */ }
      await Deno.remove(metaPath(dir, id)).catch(() => {});
      return removed;
    },
    list: async () => {
      const out: BlobInfo[] = [];
      try {
        for await (const e of Deno.readDir(dir)) {
          if (!e.isFile || !BLOB_ID_RE.test(e.name)) continue;
          const st = await Deno.stat(join(dir, e.name)).catch(() => null);
          if (!st) continue;
          const name = await readName(dir, e.name);
          out.push({
            id: e.name,
            size: st.size,
            ...(name !== undefined ? { name } : {}),
          });
        }
      } catch { /* store never written — empty */ }
      return out;
    },
  };
}

// One store object per resolved directory — `app.blobs` and a headless
// `openBlobStore(appId)` in the same process must be the SAME store, for the
// same reason app-dirs registers its resolution: two resolvers is how the
// key file was once written in one place and read from another.
const _stores = new Map<string, BlobStore>();

/** Open (or get) the content-addressed blob store for `appId` — the same
 *  store `aio.run()` exposes as `app.blobs`. `configuredDir` overrides the
 *  app home exactly like `appDir` in aio.run(); inside a booted app the
 *  registered dirs win, so every caller agrees on ONE directory. Creates
 *  nothing until the first `put()`. */
export function openBlobStore(
  appId: string,
  configuredDir?: string,
): BlobStore {
  const dir = join(appDirs(appId, configuredDir).files, "blobs");
  let store = _stores.get(dir);
  if (!store) {
    store = makeStore(dir);
    _stores.set(dir, store);
  }
  return store;
}

/** Test-only: forget memoized stores so a fixture dir resolves fresh.
 *  @internal */
export function _resetBlobStores(): void {
  _stores.clear();
}
