// The swallowed-error ratchet must be able to SEE a swallow.
//
// It could not see `.catch(() => {})` at all: the block form's regex has an
// optional `(...)` group that eats `(()`, so the required `{` landed on `=`
// and 102 promise-level swallows in src/ sat outside the budget entirely —
// concentrated in `updates-apply.ts`, `electron-runtime-fetch.ts` and
// `blobs.ts`. It is the exact class the CRDT relay recurred in: `browser-sync`
// records that every sync frame once ended in `.catch(() => {})`, which
// together meant "the CRDT layer could fail continuously while the app showed
// a clean console and stale data".
//
// A gate with no test of its own is the "verify the instrument" trap wearing a
// ratchet, so these run the scanner on text and pin both what it must catch
// and what it must not.
import { assertEquals } from "@std/assert";
import { scanSource } from "../scripts/check-silent-catch.ts";

Deno.test("silent-catch gate: it sees every spelling of a swallow", () => {
  const r = scanSource(`
    try { a(); } catch {}
    try { a(); } catch (e) { /* nothing */ }
    try { a(); } catch ({ message }) {}
    p.catch(() => {});
    p.catch((e) => {});
    p.catch(e => {});
    p.then(ok, () => {});
    void q().catch(() => {/* c */});
  `);
  assertEquals(r.blocks.length, 3, JSON.stringify(r.blocks));
  assertEquals(r.handlers.length, 5, JSON.stringify(r.handlers));
  assertEquals(r.justified, 0);
});

Deno.test("silent-catch gate: a handler that HANDLES does not count", () => {
  const r = scanSource(`
    p.catch((e) => { log.warn(String(e)); });
    p.catch(() => { retry(); });
    p.then((v) => { use(v); });
    try { a(); } catch (e) { report(e); }
  `);
  assertEquals(r.blocks, []);
  assertEquals(r.handlers, []);
});

Deno.test("silent-catch gate: `aio-ok:` justifies, a bare `aio-ok` does not", () => {
  const justified = scanSource(`
    p.catch(() => {
      // aio-ok: the socket is already closed on this path
    });
  `);
  assertEquals(justified.handlers, []);
  assertEquals(justified.justified, 1);

  // A marker with no reason is a mute button, not an acknowledgement.
  const muted = scanSource(`
    p.catch(() => {
      // aio-ok
    });
  `);
  assertEquals(muted.handlers.length, 1);
  assertEquals(muted.justified, 0);
});

Deno.test("silent-catch gate: prose about a swallow is not a swallow", () => {
  // 27 counted "silent catches" were the pattern quoted inside a string or a
  // comment. A ratchet that cannot tell code from a sentence about code rots
  // upward, so the mask is part of the contract, not an optimisation.
  const r = scanSource(`
    // Never write p.catch(() => {}) — it hides the failure.
    const advice = "use .catch(() => {}) nowhere";
    /* try { a(); } catch {} */
  `);
  assertEquals(r.blocks, []);
  assertEquals(r.handlers, []);
});

Deno.test("silent-catch gate: it reports the LINE, not just the count", () => {
  const r = scanSource("a();\nb();\np.catch(() => {});\n");
  assertEquals(r.handlers, [3]);
});
