import { assertEquals } from "@std/assert";
import { checkMemoUsage } from "../aiol/checks.ts";
import type { Issue, LintContext, SourceFile } from "../aiol/types.ts";

function makeCtx(tsxFiles: SourceFile[]): LintContext & { _issues: Issue[] } {
  const issues: Issue[] = [];
  return {
    projectDir: "/tmp/test",
    denoJson: null,
    denoJsonPath: null,
    sourceFiles: tsxFiles,
    tsxFiles,
    tsFiles: [],
    testFiles: [],
    cells: [],
    appEntry: null,
    appTsx: null,
    styleCss: null,
    report: (severity, area, message, opts) => {
      issues.push({ severity, area, message, ...opts });
    },
    pass: () => {},
    _issues: issues,
  } as LintContext & { _issues: Issue[] };
}

function file(name: string, content: string): SourceFile {
  return {
    path: `/tmp/test/src/${name}`,
    relative: `src/${name}`,
    name,
    ext: ".tsx",
    content,
    lines: content.split("\n"),
  };
}

Deno.test("lint: warns on React.memo import", () => {
  const ctx = makeCtx([
    file(
      "Card.tsx",
      `import { memo } from "react";\nexport default memo(Card);`,
    ),
  ]);
  checkMemoUsage(ctx);
  assertEquals(ctx._issues.length, 1);
  assertEquals(ctx._issues[0]!.severity, "warn");
  assertEquals(ctx._issues[0]!.message.includes("aio"), true);
});

Deno.test("lint: no warning on aio memo import", () => {
  const ctx = makeCtx([
    file(
      "Card.tsx",
      `import { memo } from "aio";\nexport default memo(Card);`,
    ),
  ]);
  checkMemoUsage(ctx);
  assertEquals(ctx._issues.length, 0);
});

Deno.test("lint: warns on .map() with memo() without useProjection", () => {
  const ctx = makeCtx([
    file(
      "List.tsx",
      `
import { memo } from "aio";
const Card = memo(CardInner);
export default function List({ items }) {
  return items.map(i => <Card key={i.id} item={i} />);
}
`,
    ),
  ]);
  checkMemoUsage(ctx);
  // Should warn: .map() renders memo() component but no useProjection
  assertEquals(
    ctx._issues.some((i) => i.message.includes("useProjection")),
    true,
  );
});

Deno.test("lint: no warning when useProjection is used", () => {
  const ctx = makeCtx([
    file(
      "List.tsx",
      `
import { memo, useProjection } from "aio";
const Card = memo(CardInner);
export default function List({ items }) {
  const projected = useProjection(() => transform(items), [items]);
  return projected.map(i => <Card key={i.id} item={i} />);
}
`,
    ),
  ]);
  checkMemoUsage(ctx);
  assertEquals(
    ctx._issues.filter((i) => i.message.includes("useProjection")).length,
    0,
  );
});
