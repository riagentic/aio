// The bundle-size gate — the "claim without a test" trap, closed.
//
// Five docs said the renderer is "~20 KB gzipped" and a small app "~50 KB
// gzipped". Nothing measured either, and both were wrong: the real counter app
// is 57 KB gzipped and what a page actually downloads for AIR is 55 KB, not 20.
// The numbers had been copied between pages for so long that no reader could
// have found the original measurement, because there never was one.
//
// So: ONE measurement (`scripts/bundle-size.ts`), a ceiling that only goes
// down, and — the part that keeps it honest — an assertion that the numbers
// printed in the docs are the numbers this test measured. A doc may not drift
// from the build any more; it goes red.
//
// Opt-in (`AIO_BUNDLE_SIZE=1`, and in `check:release`): it runs three real
// esbuild bundles, which is seconds, not milliseconds.
import { assert, assertEquals } from "@std/assert";
import { type BundleSizes, kb, measure } from "../scripts/bundle-size.ts";

/** Ceilings, in KB gzipped. RATCHET RULE: when a bundle shrinks, lower these
 *  to just above the new number, in the same commit. Raising one costs an
 *  argument in the commit message — "correct but bigger" is a real trade, but
 *  it is a decision somebody makes, not a drift nobody noticed.
 *
 *  Headroom is deliberately small (measured + ~8%): the point of the gate is
 *  to notice a feature that costs 10 KB on every page load, and a ceiling with
 *  30% slack notices nothing. */
const CEILING_GZ = {
  /** What a page downloads to render an aio component: AIR, the client
   *  runtime, the protocol and the offline queue.
   *
   *  Raised 60 → 62 in the alpha77 audit round. It was ALREADY over: the
   *  alpha76 tag measures 61 KB against a ceiling of 60, so this gate has
   *  been red since before that release and nobody re-ran it. The audit
   *  round then added ~1.2 KB of client-side correctness, deliberately and
   *  itemised:
   *    · `_impossibleOp` (patch-ops.ts, ~350 B) — refuses a delta the state
   *      cannot describe, so a lost broadcast round ends in a RESYNC instead
   *      of Immer splicing the op into a plausible, permanently wrong list;
   *    · the graph-error overlay (browser-shared.ts, ~150 B) — the frame's
   *      payload had no reader, and the page reloaded into the broken build;
   *    · the rest: a terminal v1-protocol refusal that actually stops the
   *      reconnect loop, and a `serverFn` that rejects on a refused write
   *      instead of waiting out its 30 s ceiling.
   *  Every one of those trades bytes for a failure that used to be silent.
   *
   *  Raised 62 → 64 in alpha77 (measured 63.5 KB gz). Five parallel hunts
   *  over the client put ~1.5 KB of correctness on the page, itemised:
   *    · a stale WebSocket `onclose` no longer tears down its successor
   *      (patches were applied twice through two live sockets), and a
   *      protocol mismatch is terminal — no subscriber reopens the loop;
   *    · `<input type="number">` keeps a half-typed decimal; `onChange` keeps
   *      firing when `onInput` is added or removed beside it; the `use`
   *      directive honours every documented shape and cleans up on unmount;
   *    · the missing-keys warning now knows which children came from an
   *      array (a WeakSet mark in `flattenChildren`) and names the parent it
   *      fired in, so it stops accusing hand-written siblings;
   *    · the sync engine drops an op the server refuses as older than the
   *      tombstone window instead of re-sending it forever.
   *  Still nothing on the page that a user did not ask for. */
  air: 64,
  /** The same, plus one cell — measured 2 KB, which is what a cell costs. */
  app: 66,
};

const RUN = Deno.env.get("AIO_BUNDLE_SIZE") === "1";

let cached: BundleSizes | null = null;
async function sizes(): Promise<BundleSizes> {
  if (!cached) cached = await measure();
  return cached;
}

/** Every live doc that could name a bundle size — the whole tree except the
 *  historical corners, where an old number is the POINT (an upgrade guide
 *  quoting the size at that release must not be rewritten to today's). */
async function liveDocPages(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (rel: string): Promise<void> => {
    for await (const e of Deno.readDir(`${root}${rel}`)) {
      const next = `${rel}/${e.name}`;
      if (e.isDirectory) {
        if (/^(upgrade|release-notes|specs|api-ref)$/.test(e.name)) continue;
        await walk(next);
      } else if (e.name.endsWith(".md")) out.push(next.slice(1));
    }
  };
  await walk("/docs");
  return out;
}

Deno.test({
  name: "bundle size: the browser bundle stays under its ceiling",
  ignore: !RUN,
  async fn() {
    const s = await sizes();
    assert(
      kb(s.airGzip) <= CEILING_GZ.air,
      `AIR + runtime is ${
        kb(s.airGzip)
      } KB gzipped, ceiling ${CEILING_GZ.air} KB.\n` +
        `  Every page load pays this. If the growth is deliberate, raise the\n` +
        `  ceiling in tests/bundle-size.test.ts and say why in the commit.`,
    );
    assert(
      kb(s.appGzip) <= CEILING_GZ.app,
      `the counter app is ${
        kb(s.appGzip)
      } KB gzipped, ceiling ${CEILING_GZ.app} KB.`,
    );
  },
});

Deno.test({
  name: "bundle size: a ceiling well above the measurement is not a gate",
  ignore: !RUN,
  async fn() {
    const s = await sizes();
    // A ceiling with slack in it stops noticing. If a bundle shrinks by more
    // than the headroom, the ratchet has a job to do.
    assert(
      kb(s.appGzip) >= CEILING_GZ.app - 8,
      `the counter app is ${kb(s.appGzip)} KB gzipped, ${
        CEILING_GZ.app - kb(s.appGzip)
      } KB under the ${CEILING_GZ.app} KB ceiling.\n` +
        `  Good — lower CEILING_GZ.app to ${
          kb(s.appGzip) + 2
        } so the win is kept.`,
    );
  },
});

Deno.test({
  name: "bundle size: one cell costs what the docs say it costs",
  ignore: !RUN,
  async fn() {
    const s = await sizes();
    const cellCost = kb(s.appGzip) - kb(s.shellGzip);
    assert(
      cellCost >= 0 && cellCost <= 6,
      `adding one cell to a rendering page cost ${cellCost} KB gzipped — the ` +
        `docs say a cell is a couple of KB. Either the number moved or the ` +
        `sentence needs rewriting.`,
    );
  },
});

Deno.test({
  name: "bundle size: the docs quote the MEASURED number, not a remembered one",
  ignore: !RUN,
  async fn() {
    const s = await sizes();
    // TWO legitimate figures: a page that renders a component (AIR + the
    // client runtime) and that page plus one cell. A doc names one or the
    // other, so a number is checked against the NEAREST — which is what makes
    // a ±2 KB tolerance affordable. The old ±4 around a single figure spanned
    // 8 KB: README's "57 KB" sat at the exact boundary and passed for a
    // release while the artifact measured 61.
    const gz = [kb(s.airGzip), kb(s.appGzip)];
    const br = [kb(s.airBrotli), kb(s.appBrotli)];
    /** KB off the nearest measured figure. */
    const drift = (n: number, from: number[]) =>
      Math.min(...from.map((m) => Math.abs(n - m)));
    /** A doc rounds; it does not remember.
     *
     *  1, not 2. The two legitimate figures are themselves 2 KB apart, so a
     *  ±2 window around the NEAREST of them accepted a 6 KB span — and
     *  README's "52 KB brotli" sat at its exact edge and passed for a release
     *  while `bench:bundle`, the command README names in the same sentence,
     *  printed 54. That is the same "boundary passes" defect the ±4 window
     *  had, one size smaller. (50audits §13.) */
    const TOLERANCE = 1;
    const root = new URL("..", import.meta.url).pathname;
    // Every page that states a bundle size states the same one. The old
    // numbers ("~20 KB gzipped", "~50 KB gzipped") were copied between these
    // files until nobody could find the original; a doc that names a size must
    // now name a size this test just produced.
    //
    // This used to be a hand-listed set of six pages, and that is exactly how
    // the bug it exists to prevent survived: docs/ui/comparison.md — a SECOND
    // React-vs-AIR table — kept saying "~20KB (gz)" through the whole release
    // that corrected every listed page, because nobody added it to the list.
    // CLAUDE.md carried the same number for the same reason (it is exempt from
    // the docs gates, which is about not tidying it into docs/, not about
    // being allowed to be wrong). A whitelist of pages is a whitelist of
    // pages that drift; every live doc is scanned now.
    const PAGES = [...(await liveDocPages(root)), "CLAUDE.md", "README.md"];
    const stale: string[] = [];
    for (const page of PAGES) {
      let text: string;
      try {
        text = await Deno.readTextFile(root + page);
      } catch {
        continue; // a page that no longer exists is the docs index's problem
      }
      for (const m of text.matchAll(/~?(\d+)\s*KB\s*\(?(?:min\+)?gz/gi)) {
        const n = Number(m[1]);
        if (drift(n, gz) > TOLERANCE) {
          stale.push(`${page}: "${m[0]}" — measured ${gz.join(" or ")} KB gz`);
        }
      }
      // …and BROTLI, which nothing checked at all. README promised "50 KB
      // brotli" beside its wrong gzip number, and the gate that "keeps this
      // sentence true" only ever read half the sentence.
      for (const m of text.matchAll(/~?(\d+)\s*KB\s*\(?brotli/gi)) {
        const n = Number(m[1]);
        if (drift(n, br) > TOLERANCE) {
          stale.push(
            `${page}: "${m[0]}" — measured ${br.join(" or ")} KB brotli`,
          );
        }
      }
      // …and a markdown row whose label starts "aio:" states a bundle size in
      // its FIRST KB column (gzip; the second is brotli and is a different
      // number). air-comparison.md §14 tells the reader this test goes red if
      // that table stops matching — it did not, because the column header says
      // "gzip" and the regex above needs the letters next to the number.
      for (
        const m of text.matchAll(
          /^\|\s*aio:[^|]*\|\s*~?(\d+)\s*KB[^|]*\|\s*~?(\d+)\s*KB/gim,
        )
      ) {
        if (drift(Number(m[1]), gz) > TOLERANCE) {
          stale.push(
            `${page}: "${m[0].trim()}" — measured ${
              gz.join(" or ")
            } KB (gzip column)`,
          );
        }
        if (drift(Number(m[2]), br) > TOLERANCE) {
          stale.push(
            `${page}: "${m[0].trim()}" — measured ${
              br.join(" or ")
            } KB (brotli column)`,
          );
        }
      }
    }
    assertEquals(
      stale,
      [],
      "a doc names a bundle size that is not the measured one:\n  " +
        stale.join("\n  ") +
        "\n  Run `deno task bench:bundle` and write down what it says.",
    );
  },
});
