// The two things a packaged Electron window was missing.
//
// 🔓 1 — the CSP an app configures never reached it. The policy is attached as
// an HTTP RESPONSE HEADER, and the packaged shell is returned straight from
// the Electron main process with one `Content-Type` header, never through the
// handler that would add it. So a packaged app ran with NO policy while its
// config said it had one — worse than having none, because it removes the
// reason to look. A `<meta http-equiv>` travels with the document instead, so
// it covers every way the shell can be delivered.
//
// 🔓 2 — `webviewTag` was enabled (via `childWindows`) with no
// `will-attach-webview` handler, which is the only hook that can refuse a
// guest's preferences: it fires before the guest process is spawned, while
// `did-attach-webview` is already too late. Any script in the renderer could
// create a `<webview nodeintegration>` and reach `require('fs')` — reading any
// file the user can. An app can only choose the attributes of the element IT
// creates, never of one an attacker creates, so this can only be fixed here.
//
// Both reported by a crypto wallet built on aio, where the file in question is the key
// vault.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { generateHTML } from "../src/server/server-html-gen.ts";
import { tmplWillNavigate } from "../src/electron/electron-shared.ts";
import {
  contentSecurityPolicy,
  cspNonce,
} from "../src/server/security-headers.ts";

const shell = (csp?: string, nonce?: string) =>
  generateHTML({
    title: "t",
    prod: true,
    hasCSS: false,
    importMap: "",
    ...(csp ? { csp } : {}),
    ...(nonce ? { nonce } : {}),
  });

Deno.test("a configured policy is emitted into the document", () => {
  const nonce = cspNonce();
  const policy = contentSecurityPolicy(
    { csp: "strict", cspNonce: true },
    "'self'",
    nonce,
  );
  assert(policy, "strict must produce a policy");
  const html = shell(policy, nonce);
  assertStringIncludes(html, '<meta http-equiv="Content-Security-Policy"');
  // The real directives, not a placeholder.
  assertStringIncludes(html, "default-src");
  // …and the nonce reaches the shell's own inline boot script, or the policy
  // it carries would block the page it is protecting.
  assertStringIncludes(html, `nonce-${nonce}`);
  assertStringIncludes(html, `nonce="${nonce}"`);
});

Deno.test("the policy comes FIRST, because it only covers what follows", () => {
  const html = shell("default-src 'self'");
  const meta = html.indexOf("Content-Security-Policy");
  const script = html.indexOf("<script");
  const title = html.indexOf("<title");
  assert(meta > 0 && script > 0);
  assert(meta < script, "a policy after the scripts protects nothing");
  assert(meta < title, "it belongs at the very top of <head>");
});

Deno.test("an app with no policy gets no tag at all", () => {
  // `csp: false` is a real choice, and it must not leave an empty attribute
  // that a browser reads as a policy denying everything.
  const html = shell(undefined);
  assertEquals(html.includes("Content-Security-Policy"), false);
  assertEquals(contentSecurityPolicy({ csp: false }, "'self'"), null);
});

Deno.test("the policy is escaped — it lands in an HTML attribute", () => {
  // A source list is the part of a policy that can carry the dangerous
  // characters; `report-uri` used to stand in for it here and is no longer
  // delivered by a meta at all (below).
  const html = shell(`default-src 'self' https://x/?a="y"&b=<z>`);
  assertEquals(
    html.includes(`content="default-src 'self' https://x/?a="`),
    false,
    "an unescaped quote would end the attribute and inject markup",
  );
  assertStringIncludes(html, "&quot;");
});

// ── …and it may only carry what a document CAN deliver ───────────────────
//
// `frame-ancestors`, `report-uri` and `sandbox` are ignored when they arrive
// in a `<meta http-equiv>` — the spec says so and Chromium says so OUT LOUD,
// once per document:
//
//   The Content Security Policy directive 'frame-ancestors' is ignored when
//   delivered via a <meta> element. (aio://app/:5)
//
// The default policy ("basic") always carries `frame-ancestors`, so every
// packaged window logged that error at launch — measured by the artifact E2E,
// which asserts a renderer with no errors and went red on it. Two costs, and
// the second is the one that matters: an error line in a shipped app that
// nobody can act on, and a policy that READS as if the packaged window were
// frame-protected by the document. It is not, and it does not need to be — a
// BrowserWindow has no embedder — but the HEADER still carries the directive
// wherever the shell is served over HTTP, which is where it can work.
Deno.test("the meta carries no directive a document cannot deliver", () => {
  const policy = contentSecurityPolicy({ csp: "basic" }, "'self'")!;
  assertStringIncludes(policy, "frame-ancestors", "the header keeps it");
  const html = shell(policy);
  assertStringIncludes(html, '<meta http-equiv="Content-Security-Policy"');
  for (const dead of ["frame-ancestors", "report-uri", "sandbox"]) {
    assertEquals(
      html.includes(dead),
      false,
      `the packaged shell's meta carries ${dead}, which Chromium ignores ` +
        `and reports as an error in every launch`,
    );
  }
  // …and what a meta CAN deliver is untouched.
  assertStringIncludes(html, "base-uri");
  assertStringIncludes(html, "object-src");
  assertStringIncludes(html, "form-action");
});

Deno.test("a policy that is ONLY header-only directives emits no tag", () => {
  // An empty `content=""` is a policy that denies nothing and looks like one
  // that denies everything — the worst of both.
  const html = shell("frame-ancestors 'none'; report-uri /r");
  assertEquals(html.includes("Content-Security-Policy"), false);
});

Deno.test("a webview guest cannot ask for Node", () => {
  const src = tmplWillNavigate("_appOrigin");
  assertStringIncludes(src, "will-attach-webview");
  // Every preference is FORCED, not defaulted — the guest's attributes are
  // attacker-chosen, so nothing may be left to them.
  for (
    const forced of [
      "webPreferences.nodeIntegration = false",
      "webPreferences.nodeIntegrationInSubFrames = false",
      "webPreferences.contextIsolation = true",
      "webPreferences.webSecurity = true",
    ]
  ) {
    assertStringIncludes(src, forced);
  }
  // The element's own attributes are overridden too: setting the preference
  // alone left `nodeintegration="on"` to be re-read.
  for (
    const attr of [
      "params.nodeintegration = 'off'",
      "params.disablewebsecurity = 'off'",
    ]
  ) {
    assertStringIncludes(src, attr);
  }
  // A preload is allowed only from inside the app dir, resolved through
  // realpath so a symlink cannot point out — and dropped when in doubt.
  assertStringIncludes(src, "realpathSync");
  // …stripped with a plain prefix check, not a regex: an escaped /^file:\/\//
  // literal emits a trailing // into the generated script, which is a LINE
  // COMMENT that swallows the rest of the call. The parse test below is what
  // caught it; this names the safe form so it stays.
  assertStringIncludes(src, "startsWith('file://')");
  assertStringIncludes(src, "delete webPreferences.preload");
  // It must run BEFORE the guest exists. did-attach is too late to matter.
  assert(
    src.indexOf("will-attach-webview") < src.indexOf("did-attach-webview"),
    "the veto must be installed before the popup policy that needs a guest",
  );
});

Deno.test("the generated main script is still valid JavaScript", () => {
  // The veto is inserted into a TEMPLATE STRING that becomes Electron's main
  // script. A stray backtick there is a syntax error in a file no type-checker
  // reads — it would only surface as a window that never opens. (It happened
  // once while writing this: a backtick in the explanation.)
  // The template is a FRAGMENT that names its scope (`_appOrigin`, `win`,
  // `fs`, `path`), so it is parsed with those declared around it — exactly as
  // the generated main script has them.
  const src = tmplWillNavigate("_appOrigin");
  const parsed = new Function(
    `const _appOrigin="aio://app", win={webContents:{on(){}}},` +
      `fs={realpathSync:(x)=>x}, path={sep:"/"}, BASE_DIR="/app";` +
      src,
  );
  assertEquals(typeof parsed, "function");
  // And it must be the whole fragment, not a prefix that happened to parse:
  // the swallowed-paren bug left a SHORTER but still-valid script.
  assert(src.length > 2000, `fragment suspiciously short: ${src.length}`);
  assertStringIncludes(src, "will-attach-webview");
});

// ── the refusal has to SAY so ──────────────────────────────────────────
//
// The guard above is right, and its silence cost a day. A refused preload
// does NOT fail the attach: the guest loads, renders, and simply has no
// bridge — so the symptom is "the embedded page works but cannot see the
// app", with no line anywhere, on either side, naming a rule. There is
// nothing to grep for. The `catch {}` made it worse by discarding the ENOENT
// that would have explained it.
//
// These RUN the fragment rather than grepping it. A source-text assertion
// cannot tell a warning that fires from one that is written down: the
// generated script is evaluated with the scope the real main script has,
// exactly as the parse test above does it.

type Handler = (...a: unknown[]) => unknown;

function attachHandlers(
  baseDir: string,
  realpath: (p: string) => string,
): { handlers: Record<string, Handler>; warnings: string[] } {
  const handlers: Record<string, Handler> = {};
  const warnings: string[] = [];
  const win = {
    webContents: {
      on(ev: string, fn: Handler) {
        handlers[ev] = fn;
      },
      setWindowOpenHandler() {},
    },
  };
  new Function(
    "win",
    "fs",
    "path",
    "console",
    "BASE_DIR",
    "_appOrigin",
    "require",
    tmplWillNavigate("_appOrigin"),
  )(
    win,
    { realpathSync: realpath, existsSync: () => true },
    { sep: "/" },
    { warn: (m: unknown) => warnings.push(String(m)), error() {}, log() {} },
    baseDir,
    "aio://app",
    () => ({ shell: { openExternal() {} } }),
  );
  return { handlers, warnings };
}

const ENOENT = (p: string) => {
  throw new Error("ENOENT: no such file or directory, lstat '" + p + "'");
};

Deno.test("a refused webview preload says so, and names the reason", () => {
  const { handlers, warnings } = attachHandlers(
    "/app",
    (p) => p === "/app" ? "/app" : ENOENT(p),
  );
  const webPreferences: Record<string, unknown> = {
    preload: "/elsewhere/bridge.js",
  };
  const params: Record<string, unknown> = {};
  handlers["will-attach-webview"]!(null, webPreferences, params);

  // Still refused — the warning is additional, never a replacement.
  assertEquals(webPreferences.preload, undefined);
  assertEquals(params.preload, undefined);

  assertEquals(warnings.length, 1);
  const w = warnings[0]!;
  assertStringIncludes(w, "/elsewhere/bridge.js"); // WHAT was refused
  assertStringIncludes(w, "/app"); // the root it had to resolve inside
  assertStringIncludes(w, "ENOENT"); // the reason, not a discarded catch
  assertStringIncludes(w, "NO bridge"); // and what the guest will do instead
});

Deno.test("a preload resolving OUTSIDE the app directory names where it went", () => {
  const { handlers, warnings } = attachHandlers(
    "/app",
    (p) => p === "/app/link.js" ? "/etc/evil.js" : p,
  );
  const webPreferences: Record<string, unknown> = { preload: "/app/link.js" };
  handlers["will-attach-webview"]!(null, webPreferences, {});

  assertEquals(webPreferences.preload, undefined);
  assertEquals(warnings.length, 1);
  assertStringIncludes(warnings[0]!, "/etc/evil.js"); // the symlink's target
  assertStringIncludes(warnings[0]!, "outside");
});

Deno.test("an ACCEPTED preload, and a guest asking for none, say NOTHING", () => {
  // A warning that fires on the correct case is the same defect as one that
  // never fires: it teaches the reader to skip the line.
  const good = attachHandlers("/app", (p) => p);
  const wp: Record<string, unknown> = { preload: "/app/bridge.js" };
  good.handlers["will-attach-webview"]!(null, wp, {});
  assertEquals(wp.preload, "/app/bridge.js"); // accepted, realpath'd
  assertEquals(good.warnings, []);

  const none = attachHandlers("/app", (p) => p);
  none.handlers["will-attach-webview"]!(null, {}, {});
  assertEquals(none.warnings, []);
});
