// Browser error classification — actionable fix suggestions for common dev errors.

import {
  aioOwnSpecAdvice,
  isAioOwnSpec,
  SERVER_ONLY_SPECS,
} from "./server-only-specs.ts";

/** Does the app's ROOT component still exist on disk? Registered by the dev
 *  watcher (`createFileWatcher`), which is the one place that already knows
 *  both the base dir and the UI entry, and which runs in exactly the mode this
 *  classifier serves. Unregistered (prod, no watcher) means "cannot tell" —
 *  and the classifier then says so instead of guessing. */
let _uiRootProbe: (() => boolean) | undefined;

/** Tell the classifier how to check the root component's existence. Pass
 *  `undefined` to unregister (watcher shutdown). */
export function setUiRootProbe(probe: (() => boolean) | undefined): void {
  _uiRootProbe = probe;
}

/** `true`/`false` when a probe is registered and answers, `undefined` when
 *  nothing can tell. Never throws — a broken probe must not turn an error
 *  report into a second error. */
function uiRootExists(): boolean | undefined {
  if (!_uiRootProbe) return undefined;
  try {
    return _uiRootProbe();
  } catch {
    return undefined;
  }
}

/** Classifies browser errors and returns actionable fix suggestions */
export function classifyBrowserError(
  message: string,
): { classification: string; fix: string; label: string } {
  // "Failed to fetch dynamically imported module" — browser's generic import() error
  if (message.includes("Failed to fetch dynamically imported module")) {
    // Extract the URL that failed, if present
    const failedUrl = message.match(/module:\s*(https?:\/\/\S+)/)?.[1];
    const isAppRoot = failedUrl && /\/App\.tsx/.test(failedUrl);
    // The browser names the module IT asked for, not the one that 404'd, so an
    // App.tsx failure is genuinely ambiguous: either the root itself is gone,
    // or something it imports is. Only the root's existence separates the two
    // — and asserting "a sub-import failed" sent everyone who deleted or
    // renamed App.tsx hunting a broken import that was never there.
    const rootExists = isAppRoot ? uiRootExists() : undefined;
    return {
      classification: rootExists === false
        ? "missing-ui-root"
        : "dynamic-import-failed",
      label: "Module Load Error",
      fix: !isAppRoot
        ? `Module failed to load${
          failedUrl ? ": " + failedUrl : ""
        }. Open DevTools → Network tab to find the failing request. Check the terminal for transpile errors.`
        : rootExists === false
        ? "App.tsx does not exist — the app's root component is missing, so there is no sub-import to hunt. Restore the file (`git checkout -- src/App.tsx`), or point `ui.entry` at the file that replaced it."
        : "App.tsx, or a module it imports, failed to load. Open DevTools → Network tab and look for red (failed) requests — the red one names the file that is actually missing. Check the terminal for transpile errors.",
    };
  }
  const missingModule = message.match(
    /Failed to resolve module specifier "([^"]+)"/,
  );
  if (missingModule) {
    const pkg = missingModule[1]!;
    const isRelative = pkg.startsWith("./") || pkg.startsWith("../");
    // aio's own SERVER entries are absent from the browser import map ON
    // PURPOSE — SQLite, workers, the filesystem. This is a CATEGORY error the
    // framework can name exactly, and the generic advice below is actively
    // harmful for it: `npm:aio/server` is not a package that exists, so the
    // user edits deno.json, restarts, and lands on the same blank page.
    if (SERVER_ONLY_SPECS.has(pkg)) {
      return {
        classification: "server-only-import",
        label: "Server-Only Import",
        fix:
          `"${pkg}" is aio's SERVER entry (SQLite, workers, the filesystem). ` +
          `The browser import map omits it deliberately, so this is a ` +
          `server-only module in a CLIENT graph — NOT a missing dependency. ` +
          `There is no npm package to add and editing deno.json will not ` +
          `help. Move the import into a cell METHOD ` +
          `(\`const { createDB } = await import("${pkg}")\` — methods run ` +
          `on the server), or into a *.server.ts module imported lazily. ` +
          `\`deno task lint\` names the exact file:line.`,
      };
    }
    // An `aio/*` entry that is not in the hard set above (`aio/extras`,
    // `aio/sync`) is STILL never a missing npm package — it used to fall
    // through to the generic advice this module refuses to give.
    if (isAioOwnSpec(pkg)) {
      return {
        classification: "server-only-import",
        label: "Server-Only Import",
        fix: aioOwnSpecAdvice(pkg) +
          " `deno task lint` names the exact file:line.",
      };
    }
    return {
      classification: isRelative ? "missing-relative-import" : "missing-import",
      label: "Import Error",
      fix: isRelative
        ? `File "${pkg}" not found. Check: (1) the file exists at that path relative to the importing module, (2) the filename and extension are spelled correctly (.tsx, not .ts), (3) the file has no transpile errors — check the terminal for esbuild output.`
        : `Add "${pkg}": "npm:${pkg}" to deno.json imports — AIO auto-aliases npm packages for the browser.`,
    };
  }
  // "does not provide an export named X" — a STATIC import of a server-only
  // symbol from the isomorphic "aio" entry poisons the client module graph and
  // link-fails the whole bundle at boot. V8's
  // message names the symbol but never the app file; make it teachable + point
  // at the linter that DOES name the file.
  const missingExport = message.match(
    /module ['"]([^'"]+)['"] does not provide an export named ['"]([^'"]+)['"]/,
  );
  if (missingExport) {
    const mod = missingExport[1]!;
    const sym = missingExport[2]!;
    const serverOnly = new Set([
      "createDB",
      "DEFAULT_PRAGMAS",
      "connectCli",
      "connectCliUDS",
    ]);
    return {
      classification: "server-only-export",
      label: "Server-Only Import",
      fix: serverOnly.has(sym)
        ? `'${sym}' is server-only (SQLite/Worker) — the browser build of "${mod}" omits it, so a cell (or a module it imports) statically importing it link-fails the whole client bundle. Search your cell-shared files for \`import { ${sym} }\`, and load it lazily in a server-only path (\`const { ${sym} } = await import("aio")\`) or from a *.server.ts module. \`deno task lint:aio\` now names the exact file:line.`
        : `"${mod}" has no browser export named '${sym}'. If it's server-only, import it lazily behind a server guard or from a *.server.ts module; otherwise check the spelling. \`deno task lint:aio\` flags server-only imports in cell files.`,
    };
  }
  if (message.includes("is server-only") && message.includes("[aio]")) {
    return {
      classification: "server-only",
      label: "Server-Only Code",
      fix:
        "@std/* and node:* are server-only. Move this code to an async method or effect, or use import type for types.",
    };
  }
  if (message.includes("Deno is not defined")) {
    return {
      classification: "platform-api",
      label: "Platform API",
      fix:
        "Deno.* APIs are server-only and unavailable in browser. Move to an async method or effect.",
    };
  }
  if (message.includes("is not a function")) {
    return {
      classification: "stubbed-call",
      label: "Import Error",
      fix:
        "This function may be from a server-only module. Check the import source — @std/* and node:* are not available in browser.",
    };
  }
  if (message.includes("Cannot read properties of undefined")) {
    return {
      classification: "destructure-stub",
      label: "Import Error",
      fix:
        "Likely destructuring from a server-only module. Check the import source.",
    };
  }
  return { classification: "unknown", fix: "", label: "Runtime Error" };
}
