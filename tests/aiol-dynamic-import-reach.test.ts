// Only a `*.server.ts` dynamic import is external to the browser bundle
// (docs/build/imports.md). A literal `import("./y.ts")` is FOLLOWED by
// esbuild, so a server-only `y.ts` lands in the bundle — and that holds one
// hop away from a cell as much as in it (field report (a desktop agent app) §2). aiol's
// advice also said "`await import(...)` runs on the server", which is the
// exact misreading that ships `y.ts`; every fix now names the suffix.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { buildContext } from "../aiol/context.ts";
import { checkUI } from "../aiol/checks.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

async function issuesFor(files: Record<string, string>) {
  const dir = await tempDir("aio-aiol-reach-");
  try {
    await Deno.mkdir(join(dir, "src"), { recursive: true });
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({ imports: { "aio": "jsr:@riagentic/aio@1.0.0" } }),
    );
    const all: Record<string, string> = {
      "App.tsx": "export default function App() { return <div/> }",
      "counter.ts": `
import { cell } from 'aio'
import { openNotes } from './lib.ts'
export const counter = cell('counter', {
  state: { text: '' },
  methods: { async open(s) { s.text = await openNotes() } },
})
`,
      "lib.ts": `
export async function openNotes() {
  const io = await import("./notes-io.ts")
  return io.read()
}
`,
      ...files,
    };
    for (const [name, body] of Object.entries(all)) {
      await Deno.writeTextFile(join(dir, "src", name), body);
    }
    const { ctx, report } = await buildContext(dir);
    await checkUI(ctx);
    return report.issues;
  } finally {
    await dropTempDir(dir);
  }
}

const dynIssue = (issues: { message: string }[]) =>
  issues.filter((i) => i.message.includes("static dynamic import"));

Deno.test("aiol: import() of a Deno-using file one hop from a cell is flagged, fix names the .server.ts rename", async () => {
  const issues = await issuesFor({
    "notes-io.ts": `export const read = () => Deno.readTextFile("notes.md")\n`,
  });
  const hits = dynIssue(issues);
  assertEquals(hits.length, 1, JSON.stringify(issues, null, 2));
  const hit = hits[0] as { message: string; file?: string; fix?: string };
  assertEquals(hit.file, "src/lib.ts");
  assertStringIncludes(hit.message, "Deno.*");
  assertStringIncludes(hit.fix ?? "", "Rename it to notes-io.server.ts");
});

Deno.test("aiol: import() of a file with a static jsr:@std import, reached through a multi-line import, is flagged", async () => {
  const issues = await issuesFor({
    "counter.ts": `
import { cell } from 'aio'
import {
  openNotes,
} from './lib.ts'
export const counter = cell('counter', {
  state: { text: '' },
  methods: { async open(s) { s.text = await openNotes() } },
})
`,
    "notes-io.ts":
      `import { exists } from "jsr:@std/fs"\nexport const read = () => exists("x")\n`,
  });
  const hits = dynIssue(issues);
  assertEquals(hits.length, 1, JSON.stringify(issues, null, 2));
  assertStringIncludes(hits[0]!.message, "jsr:@std/fs");
});

Deno.test("aiol: import() of a *.server.ts file or a browser-safe file is NOT flagged", async () => {
  const safe = await issuesFor({
    "notes-io.ts": `export const read = () => "plain"\n`,
  });
  assertEquals(dynIssue(safe), []);
  const server = await issuesFor({
    "lib.ts": `
export async function openNotes() {
  const io = await import("./notes-io.server.ts")
  return io.read()
}
`,
    "notes-io.server.ts":
      `export const read = () => Deno.readTextFile("notes.md")\n`,
  });
  assertEquals(dynIssue(server), []);
});

Deno.test("aiol: import() in a module NO cell or component reaches is NOT flagged", async () => {
  const issues = await issuesFor({
    "counter.ts": `
import { cell } from 'aio'
export const counter = cell('counter', { state: { n: 0 }, methods: { inc(s) { s.n++ } } })
`,
    "notes-io.ts": `export const read = () => Deno.readTextFile("notes.md")\n`,
  });
  assertEquals(dynIssue(issues), []);
});

Deno.test("aiol: every server-only-import fix names the .server.ts suffix, never says runs on the server", async () => {
  const issues = await issuesFor({
    "App.tsx": `
import { join } from '@std/path'
import '@std/dotenv/load'
export default function App() { return <div>{join('a', 'b')}</div> }
`,
    "counter.ts": `
import { cell } from 'aio'
import { basename } from '@std/path'
export const counter = cell('counter', { state: { n: 0 }, methods: { inc(s) { s.n++ } } })
`,
  });
  const serverOnly = (issues as { message: string; fix?: string }[]).filter(
    (i) => i.message.includes("server-only") && i.message.includes("@std/"),
  );
  assert(serverOnly.length >= 3, JSON.stringify(issues, null, 2));
  for (const i of serverOnly) {
    assertStringIncludes(i.fix ?? "", ".server.ts", i.message);
    assert(!/runs on the server/.test(i.fix ?? ""), i.fix);
  }
});
