// Browser error classification — actionable fix suggestions for common dev errors.

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
    return {
      classification: isRelative ? "missing-relative-import" : "missing-import",
      label: "Import Error",
      fix: isRelative
        ? `File "${pkg}" not found. Check: (1) the file exists at that path relative to the importing module, (2) the filename and extension are spelled correctly (.tsx, not .ts), (3) the file has no transpile errors — check the terminal for esbuild output.`
        : `Add "${pkg}": "npm:${pkg}" to deno.json imports — AIO auto-aliases npm packages for the browser.`,
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
