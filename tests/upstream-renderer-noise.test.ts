// `Invalid guestInstanceId` — an upstream throw that lit aio's error badge
// forever (field report §11, electron#53989).
//
// MEASURED on Electron 44.4.1 (the version this aio ships), in a real window
// with aio's own preferences and `will-attach-webview` hook, by attaching a
// `<webview>` and removing it:
//
//   window.onerror MESSAGE = "Uncaught Error: Invalid guestInstanceId: 2"
//   window.onerror FILE    = node:electron/js2c/isolated_bundle:1:7012
//   window.onerror ERROR   = Error: Invalid guestInstanceId: 2   ← no app frames
//   console-message        = node:electron/js2c/isolated_bundle:1
//                            Uncaught Error: Invalid guestInstanceId: 2
//
// It fires on EVERY removal — a settled guest and one removed mid-attach — and
// the stack carries no frame below Electron's isolated-world bundle, so the
// source is the only discriminator there is.
//
// The fix is an annotation, not a filter, and the tests below are mostly about
// the difference:
//
//   · it is recognised by message AND source, both anchored, so a real app
//     error that happens to read the same is never reclassified (the one thing
//     a substring filter could never promise);
//   · it still reaches the log, carrying the issue number and the sentence
//     that saves the next person the investigation;
//   · it never counts toward the dev overlay's problem badge and never opens
//     the panel — a red badge that is lit from the first `<webview>` close
//     until the window shuts is the fail-loud rule inverted.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import {
  UPSTREAM_RENDERER_NOISE,
  upstreamNoiseMatcherSource,
  upstreamRendererNoise,
} from "../src/diagnostics/upstream-noise.ts";
import {
  _overlayEntries,
  _resetDevOverlay,
  installDevOverlay,
} from "../src/browser/dev-overlay.ts";
import { setDevModeOverride } from "../src/state/dev-flag.ts";
import {
  installConsoleIntercept,
  uninstallConsoleIntercept,
} from "../src/browser/console-intercept.ts";
import { dec } from "../src/protocol/envelope.ts";
import { tmplRendererDiagnostics } from "../src/electron/electron-shared.ts";

/** Exactly what Electron 44.4.1 produced, verbatim. */
const NOISE_MSG = "Uncaught Error: Invalid guestInstanceId: 2";
const NOISE_SRC = "node:electron/js2c/isolated_bundle";

// deno-lint-ignore no-explicit-any
type D = any;

Deno.test("the measured line is recognised, in all three spellings of it", () => {
  // `window.onerror`, Chromium's console, and `error.message` spell the same
  // throw three ways. All three are the same event and all three must land.
  for (
    const m of [
      NOISE_MSG,
      "Error: Invalid guestInstanceId: 2",
      "Invalid guestInstanceId: 2",
      "  Uncaught Error: Invalid guestInstanceId: 41  ",
    ]
  ) {
    const hit = upstreamRendererNoise(m, NOISE_SRC);
    assert(hit, `not recognised: ${JSON.stringify(m)}`);
    assertEquals(hit.issue, "electron#53989");
    assertStringIncludes(hit.annotated, "electron#53989");
    assertStringIncludes(hit.annotated, "<webview>");
    // The log line keeps the verbatim text; the dedup key never does.
    assertStringIncludes(hit.annotated, m.trim());
    assertStringIncludes(hit.label, "electron#53989");
    assert(
      !/guestInstanceId: \d/.test(hit.label),
      `label must not vary per occurrence: ${hit.label}`,
    );
  }
});

Deno.test("BOTH halves are required — the message alone never reclassifies", () => {
  // The whole reason this is not a message filter. An app is free to throw
  // `Invalid guestInstanceId: 4` itself (it is a plain Error, and an app
  // wrapping <webview> would plausibly reuse the wording); swallowing that
  // would be a far worse bug than the noise this closes.
  assertEquals(upstreamRendererNoise(NOISE_MSG, "aio://app/app.js"), null);
  assertEquals(upstreamRendererNoise(NOISE_MSG, "https://x/bundle.js"), null);
  assertEquals(
    upstreamRendererNoise(NOISE_MSG, "node:electron/js2c/sandbox_bundle"),
    null,
    "a DIFFERENT Electron bundle is not this issue",
  );
  // …and the source alone never does either: Electron's own bundle throws
  // real errors too, and those must stay loud.
  assertEquals(
    upstreamRendererNoise("Uncaught TypeError: x is not a function", NOISE_SRC),
    null,
  );
  assertEquals(
    upstreamRendererNoise("Invalid guestInstanceId: abc", NOISE_SRC),
    null,
    "the id is a number; anything else is a different message",
  );
  assertEquals(
    upstreamRendererNoise("prefix Invalid guestInstanceId: 2", NOISE_SRC),
    null,
    "anchored — a message that merely CONTAINS it is not it",
  );
  // A caller with no source cannot satisfy a rule that needs two facts.
  assertEquals(upstreamRendererNoise(NOISE_MSG, undefined), null);
  assertEquals(upstreamRendererNoise(NOISE_MSG, null), null);
  assertEquals(upstreamRendererNoise(undefined, NOISE_SRC), null);
});

Deno.test("every rule names an issue and carries both anchored halves", () => {
  assert(UPSTREAM_RENDERER_NOISE.length > 0, "the list is the evidence");
  for (const r of UPSTREAM_RENDERER_NOISE) {
    assert(/^[a-z]+#\d+$/.test(r.issue), `not a tracker item: ${r.issue}`);
    assert(r.note.length > 40, `a rule with no explanation is a filter`);
    // A title with a number in it is a title that changes per occurrence,
    // which is the bug the `label` field exists to prevent.
    assert(r.title.length > 10, `${r.issue} has no title`);
    assert(
      !/\d/.test(r.title),
      `${r.issue}: a title must not vary: ${r.title}`,
    );
    // Unanchored halves are how a targeted annotation becomes a blanket one.
    for (const re of [r.message, r.source]) {
      assert(re.source.startsWith("^"), `${r.issue}: ${re} is not anchored`);
      assert(re.source.endsWith("$"), `${r.issue}: ${re} is not anchored`);
    }
  }
});

Deno.test("the Electron main script asks the SAME question, not a copy of it", () => {
  // The generated script runs in another process and cannot import the
  // module, so the literals are stringified from it. This is the gate on that:
  // the generated matcher must agree with the TS one on every case, or the
  // two deciders have drifted — the shape that has cost this project a
  // release before.
  const src = upstreamNoiseMatcherSource();
  const matcher = new Function(`return ${src}`)() as (
    m: unknown,
    s: unknown,
  ) => string | null;
  const cases: [unknown, unknown][] = [
    [NOISE_MSG, NOISE_SRC],
    ["Invalid guestInstanceId: 7", NOISE_SRC],
    [NOISE_MSG, "aio://app/app.js"],
    ["Invalid guestInstanceId: abc", NOISE_SRC],
    ["Uncaught TypeError: x is not a function", NOISE_SRC],
    [null, null],
    [undefined, NOISE_SRC],
  ];
  for (const [m, s] of cases) {
    const ts = upstreamRendererNoise(m, s);
    assertEquals(
      matcher(m, s),
      ts ? ts.annotated : null,
      `generated matcher disagrees for ${JSON.stringify([m, s])}`,
    );
  }
});

Deno.test("the generated main script routes the known line to info, not error", () => {
  const script = tmplRendererDiagnostics(true);
  // It must still be valid JavaScript — this template is a string nothing
  // type-checks, and a syntax error here is a window that never opens.
  new Function("win", "ipcMain", "process", "setTimeout", script);
  assertStringIncludes(script, "_aioUpstreamNoise");
  // The annotation is consulted BEFORE the level is decided, or the error is
  // already counted by the time anyone looks at it.
  const known = script.indexOf("_aioUpstreamNoise(msg, src)");
  const loud = script.indexOf("_rlog(lv === 'error' ? 'error' : 'warn'");
  assert(known > 0 && loud > 0 && known < loud, "the check must come first");
  assertStringIncludes(script, "_rlog('info', _known");
});

Deno.test("console-intercept: the known line is forwarded at info, an app error at error", () => {
  const sent: string[] = [];
  const level = (raw: string) =>
    (dec(raw) as { d: { level: string; msg: string } }).d;
  try {
    installConsoleIntercept((m) => {
      sent.push(m);
    });
    const handler = (ev: Record<string, unknown>) =>
      globalThis.dispatchEvent(
        Object.assign(new Event("error"), ev) as unknown as Event,
      );
    // The upstream throw: annotated, at info — so `errors=N` never ticks.
    handler({ message: NOISE_MSG, filename: NOISE_SRC, error: null });
    // An app error with the SAME wording from the app's own bundle: loud.
    handler({ message: NOISE_MSG, filename: "aio://app/app.js", error: null });
    assertEquals(sent.length, 2, `got ${sent.length}: ${sent.join(" | ")}`);
    const quiet = level(sent[0]!);
    assertEquals(quiet.level, "info");
    assertStringIncludes(quiet.msg, "electron#53989");
    assertStringIncludes(quiet.msg, "[uncaught]");
    const loud = level(sent[1]!);
    assertEquals(loud.level, "error", "an app error keeps its level");
    assert(!loud.msg.includes("electron#53989"), loud.msg);
  } finally {
    uninstallConsoleIntercept();
  }
});

async function withPage(fn: (doc: D) => void | Promise<void>) {
  const win = new Window({ url: "https://localhost" });
  const prevDoc = (globalThis as D).document;
  const prevAdd = (globalThis as D).addEventListener;
  (globalThis as D).document = win.document;
  (globalThis as D).addEventListener = win.addEventListener.bind(win);
  try {
    await fn(win.document as D);
  } finally {
    _resetDevOverlay();
    setDevModeOverride(null);
    (globalThis as D).document = prevDoc;
    (globalThis as D).addEventListener = prevAdd;
    delete (globalThis as D)._aioDiag;
    await closeWindow(win);
  }
}

/** Raise an `error` event on the page the way Chromium does. */
function raise(win: D, ev: Record<string, unknown>) {
  const e = new win.defaultView.ErrorEvent("error", ev);
  win.defaultView.dispatchEvent(e);
}

Deno.test("the overlay LISTS the upstream throw and does not light the badge", async () => {
  await withPage((doc) => {
    setDevModeOverride(true);
    installDevOverlay();
    // EVERY panel close, and each one carries a DIFFERENT guest id — that is
    // what the real runtime does (ids 2 and 3 in the measurement above). A row
    // per close would fill the overlay's 20-entry list and push the app's own
    // errors out of it: a diagnostic that hides diagnostics.
    for (const id of [2, 3, 4, 5]) {
      raise(doc, {
        message: `Uncaught Error: Invalid guestInstanceId: ${id}`,
        filename: NOISE_SRC,
        lineno: 1,
        colno: 7012 + id,
      });
    }

    const entries = _overlayEntries();
    assertEquals(entries.length, 1, "collapsed into ONE row, with a count");
    assertEquals(entries[0]!.severity, "notice");
    assertEquals(entries[0]!.count, 4);
    assertStringIncludes(entries[0]!.title, "electron#53989");
    assert(
      !/guestInstanceId: \d/.test(entries[0]!.title),
      `the row must not carry the varying id: ${entries[0]!.title}`,
    );

    // NOT COUNTED, and not on screen: no badge text, nothing to train anyone
    // to ignore. The row is still there for anyone who looks.
    const root = doc.getElementById("aio-dev-overlay");
    assertEquals(
      (root?.textContent ?? "").trim(),
      "",
      "a notice alone must not put a problem badge on the page",
    );
    assertEquals(root?.style.getPropertyValue("display"), "none");
  });
});

Deno.test("a REAL app error still lights it — and then the notice is visible", async () => {
  await withPage((doc) => {
    setDevModeOverride(true);
    installDevOverlay();
    raise(doc, {
      message: NOISE_MSG,
      filename: NOISE_SRC,
      lineno: 1,
      colno: 1,
    });
    raise(doc, {
      message: "Uncaught TypeError: todos.map is not a function",
      filename: "aio://app/app.js",
      lineno: 12,
      colno: 3,
    });
    const root = doc.getElementById("aio-dev-overlay");
    const text = root?.textContent ?? "";
    // ONE problem — the app's. The notice is not added to the count.
    assertStringIncludes(text, "aio: 1 problem");
    assert(!text.includes("2 problems"), text);
    assertStringIncludes(text, "todos.map is not a function");
    // …and the annotated upstream line is right there, explained, now that
    // there is a reason for the panel to be open.
    assertStringIncludes(text, "electron#53989");
    assertStringIncludes(text, "<webview>");
    const sev = _overlayEntries().map((e) => e.severity).sort();
    assertEquals(sev, ["error", "notice"]);
  });
});

Deno.test("a notice never opens the panel by itself", async () => {
  await withPage((doc) => {
    setDevModeOverride(true);
    installDevOverlay();
    raise(doc, {
      message: NOISE_MSG,
      filename: NOISE_SRC,
      lineno: 1,
      colno: 1,
    });
    // The panel opening on its own is an interruption. An upstream throw the
    // page cannot prevent has not earned one.
    assertEquals(
      (doc.getElementById("aio-dev-overlay")?.textContent ?? "").includes(
        "[-]",
      ),
      false,
    );
  });
});
