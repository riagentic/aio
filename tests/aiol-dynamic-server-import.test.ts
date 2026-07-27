// risoto 2026-07-26: `const { createDB } = await import("aio")` — the lazy
// server-only pattern the docs recommend — was invisible to the static
// alpha37 migration rule and to --safe-fix, so it failed only at RUNTIME
// ("createDB is not a function"; risoto's NFT cache silently stopped
// persisting). checkUpgrade now flags the dynamic spelling and
// fixDynamicServerEntryImport rewrites it, without touching dynamic
// imports of browser-safe symbols.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { buildContext } from "../aiol/context.ts";
import { checkUpgrade } from "../aiol/checks.ts";
import { fixDynamicServerEntryImport } from "../aiol/fixes.ts";
import { join } from "@std/path";

async function upgradeIssues(dir: string, files: Record<string, string>) {
  await Deno.mkdir(join(dir, "src"), { recursive: true });
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify({ imports: { "aio": "jsr:@riagentic/aio@1.0.0" } }),
  );
  for (const [name, body] of Object.entries(files)) {
    await Deno.writeTextFile(join(dir, "src", name), body);
  }
  const { ctx, report } = await buildContext(dir);
  await checkUpgrade(ctx);
  return report.issues.filter((i) => i.area === "upgrade");
}

async function withTmpDir(fn: (dir: string) => Promise<void>) {
  const dir = await Deno.makeTempDir();
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("checkUpgrade: dynamic import('aio') of createDB is flagged", async () => {
  await withTmpDir(async (dir) => {
    const issues = await upgradeIssues(dir, {
      "cache.ts": `
export async function open() {
  const { createDB } = await import("aio");
  return createDB("x.sqlite");
}
`,
    });
    assertEquals(issues.length, 1, "one dynamic-import issue");
    assertStringIncludes(issues[0]!.message, "aio/server");
    assertStringIncludes(issues[0]!.message, "RUNTIME");
    assert(issues[0]!.safeFix, "carries a safe fix");
  });
});

Deno.test("checkUpgrade: dynamic import('aio') of browser-safe symbols is NOT flagged", async () => {
  await withTmpDir(async (dir) => {
    const issues = await upgradeIssues(dir, {
      "lazy.ts": `
export async function lazy() {
  const { cell } = await import("aio");
  return cell;
}
`,
    });
    assertEquals(issues.length, 0, "browser-safe lazy import stays legal");
  });
});

Deno.test("fixDynamicServerEntryImport rewrites only the offending statements", async () => {
  await withTmpDir(async (dir) => {
    const path = join(dir, "cache.ts");
    await Deno.writeTextFile(
      path,
      `const { createDB } = await import("aio");
const { cell } = await import("aio");
const db2 = (await import("aio")).createDB;
`,
    );
    const changed = await fixDynamicServerEntryImport(path)();
    assert(changed, "reported a change");
    const out = await Deno.readTextFile(path);
    assertStringIncludes(
      out,
      'const { createDB } = await import("aio/server");',
    );
    assertStringIncludes(
      out,
      'const { cell } = await import("aio");',
      "browser-safe dynamic import untouched",
    );
    assertStringIncludes(out, '(await import("aio/server")).createDB');
  });
});
