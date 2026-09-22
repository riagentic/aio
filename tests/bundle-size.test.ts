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
  // Raised 64 → 68 for v1.0.0-beta, and itemised because the policy above
  // asks for an argument rather than a number. Measured 67; +4 KB gz over
  // alpha77's 63, all of it CLIENT-side diagnostics that answer top-of-report
  // findings:
  //   · the contrast audit (~1 KB) — aio checks the accessibility of STRUCTURE
  //     and shipped a generated colour system it never measured; a defect
  //     reached a real user through five green gates;
  //   · the #id-selector audit and the untracked-lifecycle-read warning
  //     (~1 KB together) — the `#root` contract cost one app hours of believing
  //     correct geometry code was wrong, and a read inside `afterRender`
  //     subscribing to nothing shipped three times in one codebase;
  //   · ~2 KB of message PROSE — the child-desync warning now names the class,
  //     the component and the two app shapes that cause it instead of "<span>
  //     holds the wrong node at child 0"; the console interceptor carries the
  //     caller's location; the short-call reply explains itself.
  //
  // The honest cost: production never runs any of it and still downloads it.
  // Not paid down here because dropping it needs a dev-only chunk, and a
  // chunk-aware reader in three places is the trade `feedback/refused.md`
  // already declined once — recorded in todo.md instead of decided in a hurry
  // at release time.
  //
  // Raised 68 → 72 at the 1.0.0-beta release check (measured 71). The last day of
  // the round put ~4 KB gz on the page, and this gate — flagged behind
  // AIO_BUNDLE_SIZE — was not in the per-change runs, so it is itemised here
  // from an esbuild metafile rather than remembered:
  //   · the notify client (~1.5 KB: desktop-notify.ts, tray-actions.ts, the
  //     effect and its frame) — a desktop notification a METHOD emits, shown
  //     by every renderer, and a tray click dispatched through the page's
  //     own door; the first bytes here that a user asked for by name;
  //   · useResource / onChange (~1 KB) — a held thing with a refcount and a
  //     generation guard, so a 760 MB model is opened once, not per render;
  //   · the App.tsx hot-swap (~0.5 KB) — a .tsx edit patches the page instead
  //     of reloading it, keeping a <webview> login and loaded weights;
  //   · the component profiler and the dev error overlay (~1.8 KB) — dev-only
  //     again, and the same trade as above: production downloads what it
  //     never runs, until the dev-only chunk in todo.md exists.
  //
  // Raised 72 → 83 at the 1.0.1-beta release check (measured 81; app 83).
  // Three hunt rounds put +26 KB minified on the page, itemised from an
  // esbuild metafile against the 1.0.0-beta tag — every byte a fix with a
  // red-without-it test, none a feature:
  //   · sync engine (+6.3 KB) and state-patch (+2.3 KB) — token-bucket op
  //     pacing, a lost catch-up that froze the cell, writes it did not make
  //     itself, a drop reported once;
  //   · renderer-rerender (+3.6 KB) — boundaries dispose the work a failed
  //     attempt built (subscriptions grew by one per retry), null fallbacks
  //     recover, a thrower mid-pass shows its fallback;
  //   · browser transport + send-pacer (+4.2 KB) — held calls survive a blip,
  //     a timed-out call is not re-sent, oversized frames fail at once;
  //   · cell-reactive, vdom diff/render, prop-write, contrast audit (~4 KB) —
  //     the per-user view, keyed lists, SSR/hydrate agreement.
  // Not paid down at release time; a size pass is on todo.md.
  //
  // Raised 83 → 86 on 2026-09-16 (measured 85; app 88), +3.2 KB gz:
  //   · prop-write (+0.35 KB min) — a cell-bound controlled input LOST
  //     keystrokes in Chromium when typing outpaced the round trip (19 of 40
  //     measured); the echo guard is the fix, and it runs in production;
  //   · ui-trigger (+2.4 KB gz) — `am trigger` now fires the events a real
  //     browser fires (implicit submit, focus on click, keypress/beforeinput,
  //     dblclick, pointer hover, Escape on a modal). It runs in the page, so
  //     production downloads it too — the dev-only chunk (todo.md, 9.3 KB gz
  //     measured) is where this comes back.
  //
  // Raised 86 → 87 on 2026-09-20 (measured 87; app 90), +1.1 KB gz for four
  // field-report fixes, every one of them with a red-without-it test:
  //   · ui-trigger (+0.6 KB gz) — constraint validation on implicit submit.
  //     The harness ran a submit the browser refuses (a `type="number"`
  //     holding "1.5" with the default step of 1), so a form that was dead in
  //     the app was green in every test; the refusal names the field and
  //     quotes the browser's own message, which is the half a DOM without
  //     `validationMessage` cannot supply.
  //   · renderer-rerender (+0.35 KB gz) — the render-burst tripwire's three
  //     origins. It claimed "a render is WRITING state that the same render
  //     READS" for renders driven from outside, and named no dependency; it
  //     now names the writer, the lifecycle hook, or neither, plus the signals
  //     that fired the renders.
  //   · vdom-remove / vdom-diff (+0.15 KB gz) — `_liveFirstDom`, which also
  //     stopped a node RESURRECTING (an auto-memo skip re-inserted the
  //     detached node a nested component had swapped away).
  //
  // Raised 87 → 88 on 2026-09-20 (measured 88; app 91), +0.7 KB gz for the
  // review round over those four fixes, each with a red-without-it test:
  //   · ui-trigger — the validation refusal was refusing what Chromium
  //     SUBMITS: a `preventDefault()` in a submit button's `onClick` was
  //     invisible (AIR delegates click to the mount root, so the app's
  //     handler runs after the probe's), `<fieldset disabled>` descendants
  //     were not barred, the step base is `min` rather than 0, and
  //     minlength/maxlength were applied to a value the user never edited.
  //     A harness that refuses a working form is the same defect as one that
  //     accepts a broken one.
  //   · renderer-rerender — "the renders were fired by …" read the DevTools
  //     feed, which is only drained while a DevTools handle is attached, so
  //     with nobody looking it named every dependency that had ever fired
  //     that instance. The clause now reads the burst's own signals.
  //
  // Raised 88 → 90 on 2026-09-21 (measured 90; app 92), +2 KB gz. Each half
  // measured on its own, by building the bundle with that change reverted:
  //   · prop-write (+~1 KB gz) — attribute NAMES are validated in the page
  //     writer against the same predicate the SSR writer now uses. The server
  //     wrote names the client already refused, so a prop name built from
  //     untrusted input (`{"x onload=alert(1)": 1}`) reached the document as
  //     raw HTML, where escaping the value does nothing. A script-injection
  //     fix, and one decider shared across both writers is what keeps it from
  //     drifting back apart.
  //   · console-intercept + dev-overlay + upstream-noise (+~1 KB gz) — two
  //     things a page has to carry because the Electron renderer IS this
  //     bundle (a separate renderer build would be per-target duplication,
  //     which D6 calls a bug). Electron throws `Invalid guestInstanceId`
  //     inside its own isolated bundle on every `<webview>` close, so the dev
  //     error badge was lit from the first panel close until the window shut
  //     — fail-loud inverted, and the one indicator that means "act" trained
  //     to mean nothing. And aio's CSP now withholds `'unsafe-eval'`, whose
  //     refusal names neither aio nor the opt-out; the page says it once, in
  //     aio's voice. Both are prose, and prose is what makes them worth
  //     anything; the dev-only chunk (todo.md, 9.3 KB gz measured) is where
  //     this half comes back.
  //
  // LOWERED 90 → 79 and 92 → 82 on 2026-09-21. The dev-only chunk that the
  // last four entries kept promising exists: `browser/dev-diagnostics.ts`,
  // reached through a dynamic import that `esbuild-plugin.ts` marks external,
  // so `dist/app.js` does not contain it and a production page never fetches
  // it. Measured on the counter app, before → after, from the esbuild
  // metafile: 250,996 → 218,118 raw, 94,065 → 81,765 gzipped. **12.0 KB gz
  // off every page load**, itemised by what left:
  //   · ui-trigger (16.6 KB raw) + ui-surface (5.4) + ui-remote (2.4) — the
  //     `am surface` / `am trigger` executor. Driven by exactly two frames,
  //     sent by exactly one sender (`server-trojan.ts`), and the trojan is
  //     never mounted in prod (`server-static.ts`: "control REST API —
  //     DEV-ONLY"). Unreachable on a production page, not merely unused.
  //   · dev-overlay (3.4 KB raw) — returns on `!isDevMode()` at its first line.
  //   · selector-audit (0.9) + contrast-audit (4.7, now tree-shaken to a
  //     5-byte module record) + dev-readonly-hint (0.6) — the three
  //     observe-only audits, all called inside `if (isDevMode())`.
  // `isDevMode()` reads `globalThis.__aioDev`, which only `aioDevHTML` sets —
  // and that shell serves the dev import map, never this bundle. So no page
  // that loads `app.js` could switch any of it on; the bundler simply could
  // not prove a runtime flag false. What it cost: `air/dev-hooks.ts`, +596
  // bytes raw of seam and one loud failure message.
  //
  // NOT moved, and the reason, so nobody re-litigates it from the size alone:
  // `console-intercept.ts` (2.6 KB) forwards the page's console to the server
  // log in PRODUCTION too — `am logs` reads it; `component-profile.ts` (1.4)
  // keeps counts a live `am eval '__aioProfile()'` reads off a production app;
  // `time-travel-panel.ts` (4.5) is reachable from the public
  // `useTimeTravel()`; `untracked-read.ts` (1.5) is half prod render path;
  // `devtools-tree.ts` (0.6) is behind the public `connectReduxDevTools()`.
  // Each of those would make production LESS capable than dev, which is not
  // the allowed direction.
  //
  // `bundle-dev-chunk.test.ts` is the gate that keeps them out: it greps the
  // metafile of a real build, so a static import that drags one back in is
  // red, not a slow 12 KB drift nobody notices.
  //
  // The `air` figure moved for a second reason in the same change: "AIR alone"
  // was measured with a bare esbuild, not the build's own plugin, so it was
  // bundling a graph nobody ships (90 KB gz against the 80 a page downloaded).
  // It now runs `aioBrowserPlugin()` like every other bundle here.
  air: 79,
  /** The same, plus one cell — measured 2 KB, which is what a cell costs. */
  app: 82,
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
    /** What aio's OWN server puts on the wire — brotli at the quality
     *  `http-encoding.ts` compresses at, which is q5, not the q11 the
     *  `brotli` column reports. The two are 6 KB apart, so "on the wire" is
     *  neither of the other columns and needs its own figure. */
    const wire = [kb(s.airServed), kb(s.appServed)];
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
      // …and "N KB on the wire", which nothing read. air-comparison.md said
      // the counter app was "50 KB on the wire" — 20 KB under the measured
      // 70 — and escaped every rule above twice over: the words "gz" and
      // "brotli" are not next to the number, and the claim WRAPPED across a
      // newline, so even a hand-grep for it came back empty. `\s` crosses a
      // line break; a line-oriented search does not.
      for (
        const m of text.matchAll(/~?(\d+)\s*KB\s+on\s+the\s+wire/gi)
      ) {
        const n = Number(m[1]);
        if (drift(n, wire) > TOLERANCE) {
          stale.push(
            `${page}: "${m[0].replace(/\s+/g, " ")}" — measured ${
              wire.join(" or ")
            } KB served`,
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
