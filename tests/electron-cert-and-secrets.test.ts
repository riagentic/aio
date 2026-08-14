// The Electron main process is a GENERATED program, so its security decisions
// are asserted on the generated text (it cannot run in CI).
//
// Two of them were wrong in every build:
//
//   • the certificate-error handler judged the APP's own URL instead of the
//     URL that failed — a constant `true` for every local launch, so any bad
//     certificate from any host (an intercepting proxy answering the page's
//     fetch to a third-party API) was silently trusted;
//   • the recents file, which stores each app's paired KEY and its `?token=`
//     URL, was written at the default 0644 inside a 0755 userData directory —
//     readable by every local user, while the server keeps the same secret
//     0600 inside a 0700 directory.
import { assert, assertStringIncludes } from "@std/assert";
import { electronMainScriptUDS } from "../src/electron/electron-uds.ts";
import { electronClientScript } from "../src/electron/electron-client-script.ts";

const APP_URL = "https://127.0.0.1:8443";

Deno.test("electron UDS main: a cert error is judged by the URL that FAILED", () => {
  const s = electronMainScriptUDS(APP_URL, "/tmp/x.sock", {
    baseDir: "/app",
    title: "t",
    meta: {},
  });
  assertStringIncludes(s, "certificate-error");
  assertStringIncludes(
    s,
    "(event, _wc, failedUrl, _err, _cert, cb)",
    "the failing URL must be bound, not ignored",
  );
  assert(
    /new URL\(failedUrl\)\.origin === new URL\("https:\/\/127\.0\.0\.1:8443"\)\.origin/
      .test(s),
    "trust is same-origin with this app, and nothing wider",
  );
  assertStringIncludes(s, "cb(false)");
  assert(
    !s.includes("u.hostname === 'localhost'"),
    "judging the app's own hostname says nothing about the failing request",
  );
});

Deno.test("electron client: the recents file (app keys + token URLs) is owner-only", () => {
  const s = electronClientScript();
  // Every write of the file carries the mode, and re-asserts it for a file
  // that already existed (`mode` is only applied at creation).
  const writes = [...s.matchAll(/fs\.writeFileSync\(recentsPath\(\)[^\n]*/g)]
    .map((m) => m[0]);
  assert(writes.length >= 2, `both writers found — got ${writes.length}`);
  for (const w of writes) {
    assertStringIncludes(w, "mode: 0o600");
  }
  assert(
    s.includes("fs.chmodSync(recentsPath(), 0o600)"),
    "an EXISTING file keeps its old mode unless it is chmod'ed",
  );
});
