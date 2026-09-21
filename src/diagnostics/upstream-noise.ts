/**
 * @module
 * Renderer errors that belong to the RUNTIME, not to the app — recognised by
 * name, annotated, and kept off the error indicator.
 *
 * This is the fail-loud rule read from the other side. An error badge that is
 * permanently lit for something the app did not do and cannot prevent trains
 * the developer to ignore the one indicator that is supposed to mean "look at
 * me". A signal that is always on is a broken signal, exactly as much as a
 * signal that never fires.
 *
 * So: not a filter. Nothing here makes an error disappear — every entry is
 * still written to the log, still visible in the dev overlay's list, still in
 * `_overlayEntries()` for anything that scrapes the page. What changes is that
 * it is LABELLED with the upstream issue and is not counted as a problem this
 * app has.
 *
 * ## The rule every entry obeys: TWO independent facts, both required
 *
 * The message alone is never enough. `Invalid guestInstanceId: 4` is a string
 * an app could plausibly throw itself (it is a plain `Error`, and an app that
 * wraps `<webview>` might well reuse the wording), and swallowing a real app
 * error because it read like a known one is a worse bug than the noise. Every
 * entry therefore matches on the message AND on the SOURCE — the file Chromium
 * attributes the throw to — and an entry only applies when both are true.
 *
 * ## What is in here, and how it was established
 *
 * `electron#53989` — **`Invalid guestInstanceId` on every `<webview>` detach.**
 * Measured on Electron 44.4.1 (the version this aio ships), with the same
 * window preferences and the same `will-attach-webview` hook aio installs, by
 * attaching a `<webview>` to a real window and removing it:
 *
 * ```text
 * window.onerror MESSAGE   = "Uncaught Error: Invalid guestInstanceId: 2"
 * window.onerror FILE      = node:electron/js2c/isolated_bundle:1:7012
 * window.onerror ERROR     = Error: Invalid guestInstanceId: 2     (no app frames)
 * console-message          = node:electron/js2c/isolated_bundle:1
 *                            Uncaught Error: Invalid guestInstanceId: 2
 * ```
 *
 * It fires on every removal — for a settled guest and for one removed
 * mid-attach — and `error.stack` carries no frame below Electron's own
 * isolated-world bundle, so the source is the only discriminator there is. The
 * guest is already gone; the throw is Electron's teardown asking the main
 * process about an id the main process has just retired. Nothing in the app
 * failed, nothing is retried, and the app has no way to prevent it: the throw
 * happens in an isolated world the page cannot reach.
 *
 * ## When upstream fixes it
 *
 * The match is ANCHORED on both halves, so an Electron that renames the bundle
 * or changes the wording stops matching and the line becomes an ordinary loud
 * error again. That is the safe direction: a stale annotation that quietly
 * keeps swallowing a message whose meaning has changed is precisely the
 * failure this file exists to avoid.
 */

/** One runtime-owned error shape, and what to say about it. */
export type UpstreamNoiseRule = {
  /** The upstream tracker item, named in the annotation. */
  readonly issue: string;
  /** What the thing IS, with nothing variable in it. Anything that DEDUPS
   *  reads this rather than the message — see `UpstreamNoise.label`. */
  readonly title: string;
  /** The message, anchored. */
  readonly message: RegExp;
  /** The file Chromium attributes the throw to, anchored. Required — see the
   *  module comment: the message alone can be an app's own error. */
  readonly source: RegExp;
  /** One sentence a developer reads instead of investigating. */
  readonly note: string;
};

/** What a recognised line is annotated with. */
export type UpstreamNoise = {
  readonly issue: string;
  readonly note: string;
  /** The line as it should appear in a LOG: the original text, verbatim, with
   *  the annotation after it. One per occurrence, which is right for a log. */
  readonly annotated: string;
  /** The same fact with every VARIABLE part removed, for anything that
   *  collapses repeats into a count.
   *
   *  The guest id in `Invalid guestInstanceId: 2` is a counter — the next
   *  detach says `3`, and the one after that `4`. Keyed on the message, the
   *  dev overlay would therefore open a NEW row per close and, after twenty
   *  of them, push the app's real errors off its own bounded list: a
   *  diagnostic that hides diagnostics. Keyed on this, every occurrence of one
   *  upstream issue is one row with a count, which is what the overlay does
   *  with everything else. */
  readonly label: string;
};

export const UPSTREAM_RENDERER_NOISE: readonly UpstreamNoiseRule[] = [
  {
    issue: "electron#53989",
    title: "Invalid guestInstanceId on <webview> detach",
    // `Uncaught ` is how `window.onerror` and Chromium's console spell it;
    // `error.message` on its own has neither prefix. All three are the same
    // throw, so all three are accepted — and nothing else is.
    message: /^(?:Uncaught\s+)?(?:Error:\s*)?Invalid guestInstanceId: \d+$/,
    source: /^node:electron\/js2c\/isolated_bundle$/,
    note: "Electron throws this inside its own isolated-world bundle when a " +
      "<webview> is detached; the guest is already gone and nothing in this " +
      "app failed. Harmless, and the page cannot prevent it.",
  },
];

/** Is this renderer error the RUNTIME's rather than the app's? Returns the
 *  annotation, or null. Pure — both halves must match (see the module
 *  comment), so an app error that merely reads like a known one is never
 *  touched.
 *
 *  `source` is the file the throw is attributed to: `ErrorEvent.filename` in
 *  the page, `sourceId` on Electron's `console-message` details. A caller
 *  with no source at all gets null, because a rule needs both facts. */
export function upstreamRendererNoise(
  message: unknown,
  source: unknown,
): UpstreamNoise | null {
  if (typeof message !== "string" || typeof source !== "string") return null;
  const msg = message.trim();
  const src = source.trim();
  for (const rule of UPSTREAM_RENDERER_NOISE) {
    if (rule.message.test(msg) && rule.source.test(src)) {
      return {
        issue: rule.issue,
        note: rule.note,
        annotated: `${msg} — known upstream issue (${rule.issue}), not this ` +
          `app: ${rule.note}`,
        label: `${rule.title} — known upstream issue (${rule.issue}), not ` +
          `this app: ${rule.note}`,
      };
    }
  }
  return null;
}

/** The same decision as JavaScript SOURCE, for the Electron main script the
 *  build generates.
 *
 *  That script is a string this repo writes and Electron runs in another
 *  process, so it cannot import this module — and a hand-copied regex over
 *  there is the "two deciders" shape that has cost this project a release
 *  before. The literals are stringified from the array above, so there is
 *  exactly one place the rules live and the generated script cannot drift
 *  from the page's own answer.
 *
 *  Emits an expression: `(msg, src) => <annotation string> | null`. */
export function upstreamNoiseMatcherSource(): string {
  const rules = UPSTREAM_RENDERER_NOISE.map((r) =>
    `{ m: ${String(r.message)}, s: ${String(r.source)}, ` +
    `i: ${JSON.stringify(r.issue)}, n: ${JSON.stringify(r.note)} }`
  ).join(", ");
  return `((msg, src) => {
    const rules = [${rules}];
    const m = String(msg == null ? '' : msg).trim();
    const s = String(src == null ? '' : src).trim();
    for (const r of rules) {
      if (r.m.test(m) && r.s.test(s)) {
        return m + ' — known upstream issue (' + r.i + '), not this app: ' + r.n;
      }
    }
    return null;
  })`;
}
