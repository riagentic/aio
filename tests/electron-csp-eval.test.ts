// The "Insecure Content-Security-Policy" warning every packaged app printed.
//
// What it actually is: Electron's renderer-side security check is one line —
// `if (!mainFrame._isEvalAllowed()) return;` — followed by the warning. It is
// armed whenever the running executable is still called `electron`
// (`/electron`, `\electron.exe`, `MacOS/Electron`), which is exactly what an
// aio app runs: the stock binary out of the shared runtime cache. So the
// promise in the message ("this warning will not show up once the app is
// packaged") is false here, and the warning followed every app into
// production.
//
// 1.0.7-beta had already put the configured policy into the packaged document
// as a `<meta http-equiv>` — and the warning stayed, because the default
// policy said nothing about scripts and `eval` therefore still ran. Measured
// on a real Electron 44.4.1 window loading the real generated shell over
// `aio://`:
//
//   before   [renderer] Electron Security Warning (Insecure CSP) …
//            EVAL: allowed   WASM: allowed   INLINE: allowed
//   after    (no warning)
//            EVAL: blocked   WASM: allowed   INLINE: allowed
//
// The fix is therefore the CAUSE, not the message: `"basic"` now carries
// `script-src * data: blob: 'unsafe-inline' 'wasm-unsafe-eval'`, which names
// every source a page could already reach and withholds one capability.
// `ELECTRON_DISABLE_SECURITY_WARNINGS` would have hidden the line and left the
// eval, so it is not used anywhere in this repo — and this file proves that
// too.
//
// The pure half runs everywhere. The live half needs Electron and a display
// (ELECTRON_E2E=1).
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { udsProdHTML } from "../src/electron/electron-shared.ts";
import {
  contentSecurityPolicy,
  cspNonce,
  metaDeliverableCsp,
} from "../src/server/security-headers.ts";
import { testDisplayEnv } from "../src/testing/test-display.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

/** The policy a packaged window gets with no `security` block at all — the
 *  same two calls `aio-lifecycle.ts` makes before it templates the shell. */
function packagedPolicy(): { csp: string; nonce: string } {
  const nonce = cspNonce();
  const csp = contentSecurityPolicy(undefined, "'none'", nonce);
  assert(csp, "a default app must still get a policy");
  return { csp, nonce };
}

Deno.test("the default packaged shell carries a script-src that stops eval", () => {
  const { csp, nonce } = packagedPolicy();
  // What the DOCUMENT can deliver is what matters: `frame-ancestors` and
  // friends are dropped from a meta policy, and if `script-src` were ever
  // added to that ignore list the warning would come straight back while the
  // header-level assertions stayed green.
  const meta = metaDeliverableCsp(csp);
  assert(meta, "the packaged shell has no other delivery than the meta tag");
  assertStringIncludes(meta, "script-src ");
  assert(
    !meta.includes("'unsafe-eval'"),
    `Electron's check is "does eval run"; this policy still lets it: ${meta}`,
  );
  // …and it has to survive the generator, in the tag, ahead of the scripts it
  // governs.
  const html = udsProdHTML("t", false, { csp, nonce });
  assertStringIncludes(
    html,
    '<meta http-equiv="Content-Security-Policy"',
  );
  const tagEnd = html.indexOf(">", html.indexOf("Content-Security-Policy"));
  const tag = html.slice(0, tagEnd);
  assertStringIncludes(tag, "script-src ");
  assert(
    tagEnd < html.indexOf("<script"),
    "a policy is only honoured for what follows it",
  );
});

Deno.test("nothing in aio suppresses Electron's security warnings", async () => {
  // The other way to make the warning go away is to set
  // ELECTRON_DISABLE_SECURITY_WARNINGS (or `window.ELECTRON_DISABLE_…`) when
  // spawning. That silences ALL of Electron's checks — the webview ones, the
  // insecure-resources one — forever, for every app, and would hide the next
  // real finding. Fail loud, never silent: this must never appear in src/.
  const hits: string[] = [];
  for await (const entry of walk("src")) {
    const text = await Deno.readTextFile(entry);
    if (text.includes("ELECTRON_DISABLE_SECURITY_WARNINGS")) hits.push(entry);
  }
  assertEquals(
    hits,
    [],
    "suppressing the warning hides the finding instead of fixing it — the " +
      "CSP in security-headers.ts is the fix",
  );
});

async function* walk(dir: string): AsyncGenerator<string> {
  for await (const e of Deno.readDir(dir)) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory) yield* walk(p);
    else if (p.endsWith(".ts") || p.endsWith(".tsx")) yield p;
  }
}

// ── the live half ────────────────────────────────────────────────────

const ELECTRON_BIN = "node_modules/.bin/electron";

function shouldSkip(): string | null {
  try {
    Deno.statSync(ELECTRON_BIN);
  } catch {
    return "Electron not installed — run: deno task install:electron";
  }
  if (!Deno.env.get("DISPLAY") && !Deno.env.get("WAYLAND_DISPLAY")) {
    return "no display (set DISPLAY or WAYLAND_DISPLAY)";
  }
  if (!Deno.env.get("ELECTRON_E2E")) {
    return "E2E disabled — set ELECTRON_E2E=1 to run";
  }
  return null;
}

/** An Electron main that serves the REAL generated shell over the REAL
 *  `aio://` scheme and reports what the renderer could still do. Written as a
 *  probe rather than reusing the app's main script on purpose: the question is
 *  about the policy in the document, and a probe that answers it in four lines
 *  cannot drift into answering a different one. */
const PROBE_MAIN = `
const { app, protocol, BrowserWindow } = require('electron');
const fs = require('fs');
const html = fs.readFileSync(process.argv[2]);
const APPJS = [
  "try { new Function('return 1')(); console.log('EVAL: allowed') }",
  "catch (e) { console.log('EVAL: blocked') }",
  "try { await WebAssembly.instantiate(new Uint8Array([0,97,115,109,1,0,0,0]));",
  "  console.log('WASM: allowed') } catch (e) { console.log('WASM: blocked') }",
  "const s = document.createElement('script');",
  "s.textContent = 'window.__inline = 1'; document.head.appendChild(s);",
  "console.log('INLINE: ' + (window.__inline === 1 ? 'allowed' : 'blocked'));",
  "console.log('MODULE: loaded');",
].join('\\n');
protocol.registerSchemesAsPrivileged([{ scheme: 'aio', privileges: {
  standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
app.whenReady().then(() => {
  protocol.handle('aio', (req) => {
    const p = new URL(req.url).pathname;
    if (p.endsWith('.js')) {
      return new Response(APPJS, { headers: { 'content-type': 'text/javascript' } });
    }
    return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  });
  const w = new BrowserWindow({ show: false, webPreferences: {
    sandbox: true, contextIsolation: true, nodeIntegration: false } });
  w.webContents.on('console-message', (...a) => {
    const e = a[0];
    const m = (e && typeof e === 'object' && 'message' in e) ? e.message : a[1];
    console.error('[probe] ' + String(m).split('\\n')[0]);
  });
  w.loadURL('aio://app/');
  setTimeout(() => { console.error('[probe] END'); app.exit(0); }, 6000);
});
`;

Deno.test({
  name: "a real Electron renderer over aio:// logs no Insecure-CSP warning",
  ignore: shouldSkip() !== null,
  // A REAL Electron process. Chromium leaves its own timers and sockets
  // behind on exit, none of them this test's to close, and the point of the
  // case is that the warning is measured in a real renderer rather than
  // reasoned about from a generated string.
  // aio-ok: Chromium's own timers, in a real Electron process.
  sanitizeOps: false,
  // aio-ok: same process — see above.
  sanitizeResources: false,
  fn: async () => {
    const dir = await tempDir("aio-csp-probe-");
    try {
      const { csp, nonce } = packagedPolicy();
      await Deno.writeTextFile(
        `${dir}/shell.html`,
        udsProdHTML("Probe", false, { csp, nonce }),
      );
      await Deno.writeTextFile(`${dir}/main.js`, PROBE_MAIN);
      await Deno.writeTextFile(
        `${dir}/package.json`,
        JSON.stringify({ name: "aio-csp-probe", main: "main.js" }),
      );
      const cmd = new Deno.Command(ELECTRON_BIN, {
        args: [dir, `${dir}/shell.html`],
        env: { ...testDisplayEnv() },
        stdout: "piped",
        stderr: "piped",
      });
      const out = await cmd.output();
      const log = new TextDecoder().decode(out.stdout) +
        new TextDecoder().decode(out.stderr);
      assertStringIncludes(log, "MODULE: loaded"); // the probe really ran
      assert(
        !log.includes("Insecure Content-Security-Policy"),
        `Electron still warns — the policy in the document does not stop ` +
          `eval:\n${log}`,
      );
      // …and the warning is absent for the RIGHT reason, not because the
      // renderer never got that far.
      assertStringIncludes(log, "EVAL: blocked");
      // Everything a working app already had is still there. A `script-src`
      // that silenced Electron by also breaking WASM or inline scripts would
      // be a worse bug than the warning.
      assertStringIncludes(log, "WASM: allowed");
      assertStringIncludes(log, "INLINE: allowed");
    } finally {
      await dropTempDir(dir);
    }
  },
});
