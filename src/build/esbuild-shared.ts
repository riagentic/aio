// esbuild-shared.ts — the ONE authority for the esbuild version + JSX config
// shared by the dev transpiler and the prod bundler (B-6: a drift between the
// two means dev and prod compile with different toolchains — a parity bug the
// old copies could only warn about in comments).
//
// NOTE: src/build/build-bundle.ts must keep a LITERAL `npm:esbuild@…` import
// (a computed specifier would defeat deno's static prefetch for the build
// path). It cannot reference this constant syntactically, so
// tests/esbuild-version-pin.test.ts asserts the literal matches this value.

/** The pinned esbuild version — must equal deno.json's pin and the literal in
 *  build-bundle.ts (CI-enforced). */
export const ESBUILD_VERSION = "0.24.2";

/** Computed specifier — lazy (never statically prefetched); used by paths
 *  that must stay esbuild-free at install time (dev transpile, aiol). */
export const ESBUILD_SPEC: string = ["npm:esbuild", ESBUILD_VERSION].join("@");

/** JSX config every esbuild invocation must share (dev == prod). */
export const ESBUILD_JSX = {
  jsx: "automatic",
  jsxImportSource: "aio",
} as const;
