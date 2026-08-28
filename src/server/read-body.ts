// read-body.ts — THE bounded reader for an incoming request body.
//
// Every route that reads a body wants the same thing: the text, or a refusal,
// never an unbounded allocation. Before this file there was one real reader
// (private to auth-flows.ts) and seven `await req.text()`/`req.json()` calls
// guarded — where they were guarded at all — by a check on the DECLARED
// Content-Length. A declared length bounds nothing. It is a number the client
// chose, and the two ways of getting it wrong were both live:
//
//   Number("abc") > MAX     → NaN > MAX is FALSE, so garbage passed the guard
//   declare 10, send 10 GB  → passed the guard, then buffered all of it
//
// The pairing route carried a comment saying a lying or absent length "is cut
// off by the bounded reader" — true of the route that comment was copied from,
// and that route is reachable BEFORE any credential on an exposed app, which
// is the whole point of it. An anonymous memory pump is not the shape that
// belongs there.
//
// So: the declared length stays as a cheap early-out — refusing before reading
// a byte is strictly better than refusing after — but it is no longer what
// bounds anything. The reader counts the bytes it actually receives.

/** The one cap for a state snapshot upload (`/__aio/snapshot`, dev only). */
export const SNAPSHOT_MAX_BODY = 10_000_000; // 10 MB

/** The one cap for a small JSON control payload — an action, a `{ pin }`, a
 *  UI trigger. Generous next to the few hundred bytes these carry, and small
 *  enough that a flood costs the attacker more than it costs the app. */
export const CONTROL_MAX_BODY = 1024 * 1024; // 1 MB

/** Read a request body as text, or `null` if it exceeds `limit` bytes.
 *
 *  The count is of bytes RECEIVED, so it holds whatever the headers claimed.
 *  Cancels the stream on refusal rather than draining it: the sender is over
 *  budget and there is nothing left to learn from the rest. */
export async function readBounded(
  req: Request,
  limit: number,
): Promise<string | null> {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch { /* already released by cancel */ }
  }
  const buf = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    buf.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(buf);
}

/** True when the client DECLARED a body over `limit`.
 *
 *  Only ever an early-out. A false answer means "nothing to refuse yet" — an
 *  absent, malformed or lying header all land here — and `readBounded` is what
 *  actually holds the line. Never invert this into a fail-open admission. */
export function declaresOverLimit(req: Request, limit: number): boolean {
  const raw = req.headers.get("content-length");
  if (raw === null) return false;
  const n = Number(raw);
  return Number.isFinite(n) && n > limit;
}
