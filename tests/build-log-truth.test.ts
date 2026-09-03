// The build log must describe the dist/ that EXISTS when it finishes.
//
// A fleet build printed `✓ dist/app.js`, `✓ dist/icon.png`,
// `✓ dist/electron.json` — and then embedded them in the binary and assembled
// a clean `dist/` holding the binaries and `manifest.json`. Every one of those
// checkmarks named a file that was gone by the last line, and two doc pages
// told readers to serve `dist/app.js`. `compiled()` already solved exactly
// this for the binary itself; the inputs were left behind.
import { assert, assertStringIncludes } from "@std/assert";
import { compiled, ok, staged } from "../src/build/build-say.ts";
import { BUILD_VERSION_ENV } from "../src/server/app-version.ts";

/** Capture stdout for one call. */
function said(fn: () => void): string {
  const lines: string[] = [];
  const o = console.log;
  console.log = (...a: unknown[]) => lines.push(a.join(" "));
  try {
    fn();
  } finally {
    console.log = o;
  }
  return lines.join("\n");
}

/** Run `fn` as the fleet runs a child build (BUILD_VERSION_ENV set). */
function underFleet<T>(fn: () => T): T {
  const prev = Deno.env.get(BUILD_VERSION_ENV);
  Deno.env.set(BUILD_VERSION_ENV, "0.1.2");
  try {
    return fn();
  } finally {
    if (prev === undefined) Deno.env.delete(BUILD_VERSION_ENV);
    else Deno.env.set(BUILD_VERSION_ENV, prev);
  }
}

Deno.test("build log: an intermediate artifact is never announced as a finished one", () => {
  const line = underFleet(() => said(() => staged("dist/app.js", "214 KB")));
  assertStringIncludes(line, "dist/app.js");
  assertStringIncludes(line, "214 KB");
  assertStringIncludes(line, "not in the final dist/");
  // The ✓ is reserved for a thing that exists — it is what a reader scans for.
  const check = said(() => ok("dist/whatever"));
  const glyph = check.trim()[0]!;
  assert(
    !line.includes(glyph),
    `a staged file must not wear the "it exists" glyph: ${line}`,
  );
  // …and the binary's own line already had this rule; it still does.
  const bin = underFleet(() => said(() => compiled("/p/app", "/p")));
  assertStringIncludes(bin, "staged");
  assert(!bin.includes(glyph), bin);
});

Deno.test("build log: a standalone build (no fleet) still says ✓ — nothing moves it", () => {
  const prev = Deno.env.get(BUILD_VERSION_ENV);
  Deno.env.delete(BUILD_VERSION_ENV);
  try {
    const line = said(() => staged("dist/app.js", "214 KB"));
    const glyph = said(() => ok("x")).trim()[0]!;
    assert(line.includes(glyph), `standalone, the file is the answer: ${line}`);
    assert(!line.includes("not in the final dist/"), line);
  } finally {
    if (prev !== undefined) Deno.env.set(BUILD_VERSION_ENV, prev);
  }
});

Deno.test("build log: every intermediate dist/ artifact goes through `staged`", async () => {
  // Structural, because the failure is one forgotten call site: a `✓` printed
  // for a file the fleet deletes reads exactly like a `✓` for one it keeps.
  const root = new URL("../", import.meta.url).pathname;
  const offenders: string[] = [];
  for (const file of ["src/build.ts", "src/build/build-bundle.ts"]) {
    const src = await Deno.readTextFile(root + file);
    src.split("\n").forEach((l, i) => {
      const m = /(?:^|[^.\w])ok\(\s*(?:`|")(?:dist\/|BUILD_STAMP)/.exec(l);
      if (m) offenders.push(`${file}:${i + 1} ${l.trim()}`);
    });
  }
  assert(
    offenders.length === 0,
    `these announce a dist/ file with ✓, which the fleet then deletes — use ` +
      `\`staged\`:\n  ${offenders.join("\n  ")}`,
  );
});
