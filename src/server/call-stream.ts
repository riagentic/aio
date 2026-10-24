// Streamed results — a method sends its caller pieces of the answer while it
// runs (tokens of a chat reply, progress of a render), then returns as usual.
//
//   methods: {
//     async chat(s, prompt: string) {
//       let all = "";
//       for await (const t of model(prompt)) { emitChunk(t); all += t; }
//       return all;                       // the call's result, as always
//     },
//   }
//
// The caller asks for a stream (`peer().stream(…)`); a caller that did not
// gets only the result and `emitChunk` answers false. Each call carries its
// OWN sink through the async context — two streamed calls on one connection
// never see each other's chunks — and the sink closes when the call settles.
import { AsyncLocalStorage } from "node:async_hooks";
import { enc } from "../protocol/envelope.ts";
import { serializeReturn } from "../protocol/return-value.ts";
import { overUtf8, utf8Size } from "../protocol/utf8-size.ts";
import { bytes } from "../diagnostics/fmt.ts";

/** Where the current call's chunks go — absent for a call nobody streams.
 *  Answers whether the chunk was sent. */
export type ChunkSink = (value: unknown) => boolean;

const _als = new AsyncLocalStorage<ChunkSink | undefined>();

/** Run `fn` (one call's dispatch) with `sink` as its chunk destination — or
 *  explicitly with none, so a plain call never inherits an outer stream. */
export function runStreamed<T>(sink: ChunkSink | undefined, fn: () => T): T {
  return _als.run(sink, fn);
}

/** Send one piece of the current call's result to its caller, now. True when
 *  it was sent; false when nobody is streaming this call (the caller wants
 *  only the result, it was a server-origin call, or the call has settled) —
 *  never an error for that, so one method serves both kinds of caller.
 *  The value travels as JSON, one frame per chunk, at most `CHUNK_MAX_BYTES`
 *  (a bigger one THROWS — bytes go through the blob store, the id as the
 *  chunk). False also when the caller is not reading fast enough: a chunk is
 *  dropped rather than queued without bound — the result is never dropped.
 *  @experimental */
export function emitChunk(value: unknown): boolean {
  const sink = _als.getStore();
  if (sink) return sink(value);
  // The limit holds for EVERY caller: a method tested with plain calls must
  // not first throw when a caller streams it.
  chunkFrame("", value, "emitChunk");
  return false;
}

/** Run one streamed call: `dispatch` under a sink that writes through
 *  `send` (one frame; false when the transport refused) and CLOSES when the
 *  call settles — a chunk emitted after the answer (a stray timer, a detached
 *  promise) is not sent, so it can never arrive after the result. */
export function runCallStreamed<T>(
  send: (value: unknown) => boolean,
  dispatch: () => T,
): T {
  let open = true;
  const result = _als.run(
    (value) => open ? send(value) : (chunkFrame("", value, "emitChunk"), false),
    dispatch,
  );
  Promise.resolve(result).then(() => open = false, () => open = false);
  return result;
}

/** Did this network action ask for its chunks (`stream: true` beside a
 *  `cid`)? The flag is TRANSPORT, not action: removed here, before dispatch,
 *  so no reducer, journal or hook ever sees it. */
export function takeStreamFlag(action: Record<string, unknown>): boolean {
  const asked = action.stream === true && typeof action.cid === "string" &&
    action.cid.length > 0;
  delete action.stream;
  return asked;
}

/** The largest chunk frame, the same on every transport: far under every
 *  frame ceiling, so a chunk can never take the state frames' door down. */
export const CHUNK_MAX_BYTES = 1024 * 1024;

/** THE chunk frame for call `cid` (action `type`), both transports. Throws
 *  past `CHUNK_MAX_BYTES` — into the method that emitted it, loudly. */
export function chunkFrame(cid: string, value: unknown, type: string): string {
  const frame = enc("chunk", {
    cid,
    value: serializeReturn(value, type, "chunk").value,
  });
  if (overUtf8(frame, CHUNK_MAX_BYTES)) {
    throw new RangeError(
      `emitChunk (${type}): a ${bytes(utf8Size(frame))} chunk is over the ` +
        `${bytes(CHUNK_MAX_BYTES)} limit — put bytes in app.blobs and emit ` +
        `the id`,
    );
  }
  return frame;
}
