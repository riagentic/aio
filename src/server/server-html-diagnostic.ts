// Static diagnostic HTML page for import graph errors.
// Zero JS imports — only inline JS for live reload WS.

import { htmlOpen } from "./server-html-gen.ts";
import { BLOCKING_CATEGORIES, type GraphError } from "./graph-validator.ts";
import { escHtml } from "./server-html-constants.ts";

/** Generates a static diagnostic HTML page when the import graph has errors.
 *  Zero JS imports — cannot fail to load. Only inline JS for live reload WS. */
export function generateDiagnosticHTML(
  errors: GraphError[],
  title: string,
): string {
  // Split fatals from standing warnings: burying the one real error under a
  // pile of never-fatal ones turns a ten-second fix into archaeology.
  const fatal = errors.filter((e) => BLOCKING_CATEGORIES.has(e.category));
  const warnings = errors.filter((e) => !BLOCKING_CATEGORIES.has(e.category));
  const shown = fatal.length > 0 ? fatal : errors;

  const render = (list: GraphError[]) =>
    list.map((e) => {
      const loc = e.line != null
        ? `:${e.line}${e.col != null ? `:${e.col}` : ""}`
        : "";
      const fileLabel = e.file
        ? `<div style="color:#569cd6;margin-bottom:.35rem">${
          escHtml(e.file)
        }${loc}</div>`
        : "";
      const lineSnippet = e.lineText
        ? `<div style="background:#0d1117;padding:.5rem .85rem;border-radius:4px;border-left:3px solid #ff6b6b;margin-bottom:.5rem"><span style="color:#555">${
          e.line != null ? e.line + " | " : ""
        }</span><span style="color:#ddd">${escHtml(e.lineText)}</span></div>`
        : "";
      const fixBox = e.fix
        ? `<div style="margin-top:.5rem;padding:.6rem .9rem;background:#1a2332;border:1px solid #2a4a6a;border-radius:6px"><div style="color:#569cd6;font-weight:700;margin-bottom:.3rem;font-size:11px">FIX</div><div style="color:#98c379">${
          escHtml(e.fix)
        }</div></div>`
        : "";
      return `<div style="margin-bottom:1.5rem">${fileLabel}<div style="color:#f1fa8c;margin-bottom:.5rem">${
        escHtml(e.message)
      }</div>${lineSnippet}${fixBox}</div>`;
    }).join("");

  const errorBlocks = render(shown);
  const warningBlock = fatal.length > 0 && warnings.length > 0
    ? `<details style="margin-top:1.5rem"><summary style="color:#8a8a8a;cursor:pointer;font-size:12px">${warnings.length} standing warning${
      warnings.length !== 1 ? "s" : ""
    } &#8212; not blocking, unchanged by this error</summary><div style="opacity:.75;margin-top:.75rem">${
      render(warnings)
    }</div></details>`
    : "";

  return `<!DOCTYPE html>
${htmlOpen()}
<head>
  <meta charset="UTF-8">
  <title>${escHtml(title)} — Module Errors</title>
</head>
<body style="margin:0;padding:1.75rem 2rem;min-height:100vh;background:#141414;font:13px/1.7 monospace;box-sizing:border-box">
  <div style="max-width:920px">
    <div style="color:#ff6b6b;font-size:1.1rem;font-weight:700;margin-bottom:1.25rem;padding-bottom:.75rem;border-bottom:1px solid #2a2a2a">&#10006; ${shown.length} module error${
    shown.length !== 1 ? "s" : ""
  } &#8212; fix to continue</div>
    ${errorBlocks}
    ${warningBlock}
    <div style="margin-top:1.5rem;padding-top:.75rem;border-top:1px solid #2a2a2a;color:#555;font-size:11px">Save any file to re-validate &#183; Auto-reloads when fixed &#183; ${
    new Date().toLocaleTimeString()
  }</div>
  </div>
  <script>
    var proto = location.protocol === 'https:' ? 'wss:': 'ws:';
    var tk = new URLSearchParams(location.search).get('token');
    var wsUrl = proto + '//' + location.host + '/ws' + (tk ? '?token=' + encodeURIComponent(tk): '');
    var ws = new WebSocket(wsUrl);
    ws.onmessage = function(ev) {
      var f; try { f = JSON.parse(ev.data); } catch (_) { return; }
      if (!f || f.v !== 2) return;
      // graph-error suppresses the reload on purpose — the build is red.
      if (f.t === 'graph-error') {
        var errs = Array.isArray(f.d) ? f.d : [];
        for (var i = 0; i < errs.length; i++) console.error('[aio:graph] ' + (errs[i].file || '?') + (errs[i].line ? ':' + errs[i].line : '') + ' — ' + (errs[i].message || ''));
        if (!errs.length) console.error('[aio:graph] the import graph is invalid — not reloading');
        return;
      }
      if (f.t === 'reload' || f.t === 'graph-clear') location.reload();
    };
    ws.onclose = function() { setTimeout(function() { location.reload(); }, 2000); };
  </script>
</body>
</html>`;
}
