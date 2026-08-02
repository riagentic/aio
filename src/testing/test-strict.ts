// test-strict.ts — the ONE entry point that puts a harness into dev-strict
// mode and sandboxes its app directories.
//
// It lives in its own module because every harness needs it and the harnesses
// import each other: it used to sit in `cell-test.ts`, so `testComponent`,
// `testServer` and `testMultiClient` could not call it without an import cycle
// — and they didn't. Three of the five harnesses therefore ran with `__aioDev`
// unset, which turned off frozen-state enforcement, the readonly hint and the
// hidden-field read guard for every test written with them: a component that
// illegally mutated committed state passed `testComponent` and threw in
// `testUI`, `testCell` and production.
//
// Doctrine, verbatim: "Tests are the STRICTEST environment, never the most
// permissive." One import, one call, at the top of every harness.

/** Arm dev-strict checks for a test harness.
 *
 *  The runtime freezes committed state in dev AND prod so an illegal in-place
 *  mutation throws at the site; a harness that leaves `__aioDev` unset makes
 *  the same mutation silently succeed, so a green test means less than
 *  production does. Idempotent; a test that specifically needs prod-lenient
 *  behaviour can set the flag false itself.
 *  @internal */
export function _armTestStrict(): void {
  (globalThis as Record<string, unknown>).__aioDev = true;
  _sandboxAppDirs();
}

// A harness must not be able to write into the user's home — not by design, and
// not by accident. App code legitimately asks `appDirs(appId)` where its files
// live (`<data>/files`, `<data>/tls`, …), and under a test that resolved to the
// developer's REAL `~/.<appId>`: one field report's server tests installed a
// fixture binary into the real install for the whole project, and the pollution
// then HID a second bug by making two tests pass against an artefact that only
// existed on that machine ("not a footgun — a loaded gun pointed at data the
// developer cares about").
//
// So the first harness use of the process pins every app directory into a temp
// sandbox, unless the runner already pinned one (aio's own suite does, in its
// `deno test` task). An explicit `registerAppDirs()` still wins per app — that is
// the escape hatch for a test that wants a specific fixture directory.
let _sandboxed = false;
function _sandboxAppDirs(): void {
  if (_sandboxed) return;
  _sandboxed = true;
  try {
    if (Deno.env.get("AIO_APPS_DIR")) return; // runner already pinned it
    const dir = Deno.makeTempDirSync({ prefix: "aio-test-apps-" });
    Deno.env.set("AIO_APPS_DIR", dir);
    globalThis.addEventListener("unload", () => {
      try {
        Deno.removeSync(dir, { recursive: true });
      } catch { /* best effort — it is a temp dir */ }
    });
  } catch { /* no env/tmp permission: leave resolution as-is */ }
}
