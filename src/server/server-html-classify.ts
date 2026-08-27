// Browser error classification — actionable fix suggestions for common dev errors.

/** aio's own server-side entries. THE list also lives in graph-validator.ts
 *  (`SERVER_ONLY_SPECS`) and lint.ts; all three name the same fact. */
const AIO_SERVER_SPECS = new Set(["aio/server"]);

/** Classifies browser errors and returns actionable fix suggestions */
export function classifyBrowserError(
  message: string,
): { classification: string; fix: string; label: string } {
  // "Failed to fetch dynamically imported module" — browser's generic import() error
  if (message.includes("Failed to fetch dynamically imported module")) {
    // Extract the URL that failed, if present
    const failedUrl = message.match(/module:\s*(https?:\/\/\S+)/)?.[1];
    const isAppRoot = failedUrl && /\/App\.tsx/.test(failedUrl);
    return {
      classification: "dynamic-import-failed",
      label: "Module Load Error",
      fix: isAppRoot
        ? "A sub-import inside App.tsx failed to load. Open DevTools → Network tab and look for red (failed) requests to find the broken import. Check the terminal for transpile errors."
        : `Module failed to load${
          failedUrl ? ": " + failedUrl : ""
        }. Open DevTools → Network tab to find the failing request. Check the terminal for transpile errors.`,
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
    if (AIO_SERVER_SPECS.has(pkg)) {
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
