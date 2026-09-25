// `aio/air` must mean the same thing on every target.
//
// The android build remaps the public specifier to a different module:
//   src/build/build-bundle.ts  → const fwEntry = doAndroid
//                                  ? "standalone-air.ts" : "browser-air.ts"
//                                … imports: { "aio": aioEntry, "aio/air": aioEntry }
// so on android `import { … } from "aio/air"` resolves to src/standalone-air.ts.
// That module carried its OWN `useLocal`, narrower than the one every other
// target ships and narrower than the docs:
//
//   docs/basics/api-reference.md — `const [v, setV] = useLocal(0)` (tuple,
//                                   preferred; `{ local, set, patch }` also works)
//   docs/ui/air-reference.md     — `useLocal(init)` → `{ local, set, patch }`
//                                   or tuple `[value, set]`
//
// Neither the tuple form nor `patch()` existed there, so the DOCUMENTED,
// PREFERRED spelling threw `useLocal(...) is not iterable` — on android only,
// at runtime, in an app whose browser and electron builds were green. The
// scaffold's own template uses the one form both copies happened to support,
// so every gate stayed green.
//
// Two rules, both enforced below:
//   1. no symbol may be exported under an `aio/air` name with a DIFFERENT
//      contract per target — a second implementation of a name is the bug;
//   2. what android does not ship is enumerated HERE, with a reason, so the
//      gap is a visible fact instead of a discovery made by a user.
import { assert, assertEquals } from "@std/assert";
import * as air from "../src/air.ts";
import * as android from "../src/standalone-air.ts";
import { _applyShellUi } from "../src/standalone-air.ts";
import * as aio from "../mod.ts";
import { stopEsbuildService } from "../src/build/esbuild-shared.ts";

// ── 1. the contract of a shared name is identical on both entries ────────

Deno.test("android aio/air: useLocal honours the documented tuple form", () => {
  // `const [value, set] = useLocal(init)` — the spelling docs call preferred.
  const [value, set] = android.useLocal("a");
  assertEquals(value, "a");
  assertEquals(typeof set, "function");
  // …and its TYPE survives `noUncheckedIndexedAccess` (this repo compiles with
  // it on, so the annotation below is the assertion). A field report suspected
  // the tuple widened to `string | undefined` there, which would have made the
  // documented spelling unusable in a strict app; it does not — a tuple has
  // fixed arity, and the flag only widens index signatures and arrays.
  const strict: string = value;
  assertEquals(strict, "a");
});

Deno.test("android aio/air: useLocal exposes patch() for object state", () => {
  const local = android.useLocal({ a: 1, b: 2 });
  assertEquals(typeof local.patch, "function");
  local.patch({ b: 3 });
  assertEquals(local.local, { a: 1, b: 3 });
});

Deno.test("android aio/air: useLocal.set accepts an updater function", () => {
  const local = android.useLocal(1);
  local.set((n) => n + 1);
  assertEquals(local.local, 2);
});

Deno.test("android aio/air: useLocal is the SAME implementation, not a copy", () => {
  // Two implementations of one public name is the defect itself — a contract
  // that agrees today drifts the next time only one of them is edited.
  assertEquals(
    android.useLocal,
    air.useLocal,
    "src/standalone-air.ts must re-export aio/air's useLocal, not define a " +
      "second one",
  );
});

// ── 2. the android surface gap is enumerated, never discovered ───────────

/** Exports of `aio/air` that the android (standalone) runtime deliberately
 *  does not ship, each because it needs something android has no equivalent
 *  of. Shrinking this list is always allowed; growing it is a decision. */
const ABSENT_ON_ANDROID: Record<string, string> = {
  // Server transport: a standalone app has no WS/IPC connection to report on.
  isConnectionDegraded: "no server transport in a standalone app",
  useConnected: "no server transport in a standalone app",
  useProjection: "built on the transport's reference-sharing projector",
  // Server-side rendering — there is no HTML shell to hydrate into. (Islands
  // and the router SHIP on android since alpha70: client-side interop and
  // history-API routing need no server; the auth UI ships resolved to the
  // anonymous branch — see standalone-air.ts.)
  renderToStream: "SSR is a server-rendered-page concern",
  // Devtools + test harness connect over the dev server / a DOM shim.
  connectAioDevTools: "devtools bridge is a dev-server concern",
  connectReduxDevTools: "devtools bridge is a dev-server concern",
  disconnectReduxDevTools: "devtools bridge is a dev-server concern",
  // (`setDocument`/`testComponent` moved to `aio/testing` in alpha70 — no
  // longer an `aio/air` export, so no longer an android gap to record.)
  useTimeTravel: "time travel streams from the server's action log",
};

Deno.test("android aio/air: every absent export is a listed decision", () => {
  const surprises: string[] = [];
  for (const name of Object.keys(air)) {
    if (name in android) continue;
    if (name in ABSENT_ON_ANDROID) continue;
    surprises.push(name);
  }
  assertEquals(
    surprises,
    [],
    "these `aio/air` exports vanish on android with no recorded reason — an " +
      "app that uses them builds everywhere and fails only there:\n  " +
      surprises.join("\n  "),
  );
});

Deno.test("android aio/air: the absent list has no dead entries", () => {
  const stale = Object.keys(ABSENT_ON_ANDROID).filter((n) =>
    !(n in air) || n in android
  );
  assertEquals(
    stale,
    [],
    "listed as absent but no longer missing (or no longer on aio/air) — the " +
      "ledger has to shrink when the gap does",
  );
});

Deno.test("android aio/air: the primitives an app cannot render without are present", () => {
  // A spot-check with names, so the failure reads as the capability lost
  // rather than as a count.
  for (
    const name of [
      "signal",
      "computed",
      "effect",
      "h",
      "Fragment",
      "Show",
      "mount",
      "useForm",
      "useRef",
      "onMount",
    ]
  ) {
    assert(
      name in android,
      `android's aio/air does not export ${name} — the bundle fails to build ` +
        `the moment an app uses it`,
    );
  }
});

// ── 3. `aio` itself means the same thing there ──────────────────────────
//
// The android build remaps BOTH specifiers to this one entry:
//   imports: { "aio": aioEntry, "aio/air": aioEntry }
// so a symbol on `aio` that is missing here is an app that compiles for
// server, browser and electron and fails to BUNDLE for android — with an
// esbuild error naming a framework internal ("No matching export in
// aio/src/standalone-air.ts for import \"log\""), which reads as a broken
// install rather than a missing export. That is how `log` was found in the
// field (a remote-desktop suite): every part of a standalone app — cells, networking, session
// logic — has something to say when it goes wrong.

/** On `aio`, deliberately NOT on the android entry: each needs a Deno process,
 *  a server, or a database that a WebView bundle does not have. */
const SERVER_ONLY: Record<string, string> = {
  VERSION: "the running server's version string",
  route: "HTTP route handlers",
  serverFn: "server function boundary",
  serverFns: "server function boundary",
  authClient: "talks to /__aio/auth/* on a server",
  createAuthClient: "talks to /__aio/auth/* on a server",
  generateTotpSecret: "server-side TOTP enrolment",
  totpUri: "server-side TOTP enrolment",
  verifyTotp: "server-side TOTP verification",
  // (`table`/`pk`/`text`/`integer`/`real`/`ref` ship since round 3 — a cell
  // module declares its `db:` table beside the cell; pinned below.)
  isCellWorker: "Deno worker-thread cells",
  definePlugin:
    "plugins are resolved by aio.run() at boot — a WebView bundle has no " +
    "`plugins:` to resolve, and the module lives under src/server/ where a " +
    "browser entry may not reach it (tests/browser-entry-server-reach)",
  // (`testCell` moved to `aio/testing` in alpha70 — off `aio`, off this ledger.)
  serverImport:
    "it exists to import a `*.server.ts` module, and a standalone APK has no " +
    "Deno runtime to run one — the android build already refuses a graph that " +
    "reaches server-only code (--allow-server-only is the assertion that it " +
    "does not). Absent is a compile error at the call site; present would be a " +
    "runtime failure on one target only, which is the hazard this whole file " +
    "enumerates",
};

/** On `aio`, missing here, and NOT deliberate — the R-14 class, enumerated so
 *  it is a visible fact instead of a discovery made by a user. This list may
 *  only SHRINK: twelve of its thirteen entries were one-line re-exports of
 *  dependency-free modules (`until`/`race` appear in mod.ts's own header
 *  example, so the documented spelling of an async method did not bundle for a
 *  shipped target) and they now ship. What is left needs work, not a line. */
const KNOWN_GAPS: Record<string, string> = {
  // alpha70 closed the last one: `schedule` no longer pulls the Deno worker
  // pool (blocking.ts), so the standalone entry re-exports it.
};

Deno.test("android `aio`: every missing export is a listed decision or a listed gap", () => {
  const surprises = Object.keys(aio).filter((n) =>
    !(n in android) && !(n in SERVER_ONLY) && !(n in KNOWN_GAPS)
  );
  assertEquals(
    surprises,
    [],
    "these vanish from `aio` on android with no recorded reason — an app that " +
      "uses them builds everywhere and fails to BUNDLE only there:\n  " +
      surprises.join("\n  "),
  );
});

Deno.test("android `aio`: the ledgers have no dead entries", () => {
  const stale = [...Object.keys(SERVER_ONLY), ...Object.keys(KNOWN_GAPS)]
    .filter((n) => !(n in aio) || n in android);
  assertEquals(
    stale,
    [],
    "listed as missing but no longer so (or no longer on `aio`) — a ledger " +
      "that does not shrink when the gap does is a lie:\n  " +
      stale.join("\n  "),
  );
});

Deno.test("android `aio`: the db schema builders are present, and are THE same objects", async () => {
  for (const n of ["table", "pk", "text", "integer", "real", "ref"] as const) {
    assertEquals(android[n], aio[n], `standalone must re-export aio's ${n}`);
  }
  // …and a cell module declaring a table BUNDLES against the android entry
  // (esbuild refused it: "No matching export … for import \"table\"").
  const esbuild = await import("esbuild");
  const entry = new URL("../src/standalone-air.ts", import.meta.url).pathname;
  try {
    const out = await esbuild.build({
      stdin: {
        contents:
          `import { table, pk, text } from "aio"; console.log(table({ id: pk(), t: text() }));`,
        resolveDir: new URL("../src/", import.meta.url).pathname,
        loader: "ts",
      },
      bundle: true,
      write: false,
      format: "esm",
      logLevel: "silent",
      packages: "external",
      plugins: [{
        name: "aio-android",
        setup(b) {
          b.onResolve({ filter: /^aio$/ }, () => ({ path: entry }));
        },
      }],
    });
    assertEquals(out.errors, []);
  } finally {
    // Waits for the service child to EXIT, not just be told to — under load a
    // bare `stop()` left it closing during the next test (leak sanitizer).
    await stopEsbuildService(() => esbuild.stop());
  }
});

Deno.test("android `aio`: log is present, and is THE logger", () => {
  // The one closed in the field: `import { log } from \"aio\"` compiled for
  // three targets and failed to bundle for the fourth.
  assertEquals(android.log, aio.log, "standalone must re-export aio's log");
});

// ── 4. `ui.theme` reaches the packaged APK ───────────────────────────────
//
// The android shell is generated at BUILD time, before `aio.run()` exists, so
// `ui.theme` could not travel with it: alpha63 made the look opt-in, `am
// create` wrote `theme: "auto"` into every new app, and a scaffolded android
// app was themed in dev and unstyled in its own APK — cards with no card, rows
// that do not lay out. The shell now carries the full sheet DISABLED and the
// standalone runtime (which does receive the config) enables it at boot.
import { androidLocalHTML } from "../src/server/server-html-gen.ts";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";

function shellDoc(opts: { appCss?: boolean } = {}) {
  const win = new Window();
  win.document.write(
    androidLocalHTML("probe", opts.appCss ?? false, { themeName: "probe" }),
  );
  return { doc: win.document, close: () => closeWindow(win) };
}

Deno.test("android shell: the default look ships disabled, not applied", async () => {
  const { doc, close } = shellDoc();
  try {
    const deferred = doc.querySelector("style[data-aio-theme-deferred]");
    assert(deferred, "the packaged shell must carry the sheet");
    assertEquals(
      deferred!.getAttribute("media"),
      "not all",
      "…and it must be inert until the app asks for it",
    );
  } finally {
    await close();
  }
});

Deno.test('android runtime: ui.theme "auto" enables it; nothing else does', async () => {
  // deno-lint-ignore no-explicit-any
  const g = globalThis as any;
  const prevDoc = g.document;
  const opened: Array<() => Promise<void>> = [];
  try {
    for (
      // `"none"` REMOVES the sheet rather than leaving it disabled: the word
      // means "no aio CSS on the page at all… not even the two-rule box-model
      // baseline", and a packaged shell emits that baseline before it can know
      // the answer. Leaving an inert sheet behind was harmless; leaving the
      // always-on baseline was not, and both go the same way.
      const [theme, want] of [
        [undefined, "not all"],
        ["tokens", "not all"],
        ["none", "gone"],
        ["auto", null],
        ["full", null],
      ] as [string | undefined, string | null][]
    ) {
      const { doc, close } = shellDoc();
      opened.push(close);
      g.document = doc;
      _applyShellUi({ theme });
      const sheet = doc.querySelector("style[data-aio-theme-deferred]");
      assertEquals(
        sheet === null ? "gone" : sheet.getAttribute("media"),
        want,
        `ui.theme: ${theme}`,
      );
    }
    // "auto" still steps aside for an app that ships its own stylesheet.
    const { doc: styled, close: closeStyled } = shellDoc({ appCss: true });
    opened.push(closeStyled);
    g.document = styled;
    _applyShellUi({ theme: "auto" });
    assertEquals(
      styled.querySelector("style[data-aio-theme-deferred]")!.getAttribute(
        "media",
      ),
      "not all",
      "auto + style.css → the app owns the stage, on android too",
    );
    // ui.lang travels the same way.
    const { doc: langDoc, close: closeLang } = shellDoc();
    opened.push(closeLang);
    g.document = langDoc;
    _applyShellUi({ lang: "pt-BR" });
    assertEquals(langDoc.documentElement.lang, "pt-BR");
  } finally {
    for (const close of opened) await close();
    g.document = prevDoc;
  }
});
