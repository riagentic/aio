import { assertEquals } from "@std/assert";
import { buildContext } from "../aiol/context.ts";
import { checkUI } from "../aiol/checks.ts";
import { join } from "@std/path";

async function withTmpDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/** Run checkUI on a temp project and return collected issues */
async function runCheckUI(dir: string) {
  const { ctx, report } = await buildContext(dir);
  await checkUI(ctx);
  return report.issues;
}

Deno.test("aiol: flags @std/* import in feature file", async () => {
  await withTmpDir(async (dir) => {
    await Deno.mkdir(join(dir, "src"), { recursive: true });
    await Deno.writeTextFile(
      join(dir, "src", "App.tsx"),
      "export default function App() { return <div/> }",
    );
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({
        imports: { "aio": "jsr:@riagentic/aio@1.0.0" },
        unstable: ["kv"],
      }),
    );
    await Deno.writeTextFile(
      join(dir, "src", "counter.ts"),
      `
import { join } from '@std/path'
import { feature } from 'aio'
export const counter = feature('counter', {
  state: { count: 0 },
  methods: { inc: (s) => { s.count++ } }
})
`,
    );
    const issues = await runCheckUI(dir);
    assertEquals(
      issues.some((i) =>
        i.message.includes("@std/path") && i.message.includes("server-only")
      ),
      true,
    );
  });
});

Deno.test("aiol: allows import type in feature file", async () => {
  await withTmpDir(async (dir) => {
    await Deno.mkdir(join(dir, "src"), { recursive: true });
    await Deno.writeTextFile(
      join(dir, "src", "App.tsx"),
      "export default function App() { return <div/> }",
    );
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({
        imports: { "aio": "jsr:@riagentic/aio@1.0.0" },
        unstable: ["kv"],
      }),
    );
    await Deno.writeTextFile(
      join(dir, "src", "counter.ts"),
      `
import type { WalkEntry } from '@std/fs'
import { feature } from 'aio'
export const counter = feature('counter', {
  state: { count: 0 },
  methods: { inc: (s) => { s.count++ } }
})
`,
    );
    const issues = await runCheckUI(dir);
    assertEquals(issues.some((i) => i.message.includes("@std/fs")), false);
  });
});

Deno.test("aiol: flags Deno.* usage in feature file", async () => {
  await withTmpDir(async (dir) => {
    await Deno.mkdir(join(dir, "src"), { recursive: true });
    await Deno.writeTextFile(
      join(dir, "src", "App.tsx"),
      "export default function App() { return <div/> }",
    );
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({
        imports: { "aio": "jsr:@riagentic/aio@1.0.0" },
        unstable: ["kv"],
      }),
    );
    await Deno.writeTextFile(
      join(dir, "src", "counter.ts"),
      `
import { feature } from 'aio'
export const counter = feature('counter', {
  state: { text: '' },
  methods: { load: async (s) => { s.text = await Deno.readTextFile('/tmp/x') } }
})
`,
    );
    const issues = await runCheckUI(dir);
    assertEquals(
      issues.some((i) =>
        i.message.includes("Deno.") && i.message.includes("server-only")
      ),
      true,
    );
  });
});

Deno.test("aiol: flags node:* import in feature file", async () => {
  await withTmpDir(async (dir) => {
    await Deno.mkdir(join(dir, "src"), { recursive: true });
    await Deno.writeTextFile(
      join(dir, "src", "App.tsx"),
      "export default function App() { return <div/> }",
    );
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({
        imports: { "aio": "jsr:@riagentic/aio@1.0.0" },
        unstable: ["kv"],
      }),
    );
    await Deno.writeTextFile(
      join(dir, "src", "counter.ts"),
      `
import { readFileSync } from 'node:fs'
import { feature } from 'aio'
export const counter = feature('counter', {
  state: { count: 0 },
  methods: { inc: (s) => { s.count++ } }
})
`,
    );
    const issues = await runCheckUI(dir);
    assertEquals(
      issues.some((i) =>
        i.message.includes("node:fs") && i.message.includes("server-only")
      ),
      true,
    );
  });
});

Deno.test("aiol: flags bare specifier not in deno.json", async () => {
  await withTmpDir(async (dir) => {
    await Deno.mkdir(join(dir, "src"), { recursive: true });
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({
        imports: { "aio": "jsr:@riagentic/aio@1.0.0", "react": "npm:react@18" },
        unstable: ["kv"],
      }),
    );
    await Deno.writeTextFile(
      join(dir, "src", "App.tsx"),
      `
import { useFeature } from 'aio'
import { Terminal } from 'xterm'
export default function App() { return <div/> }
`,
    );
    const issues = await runCheckUI(dir);
    assertEquals(
      issues.some((i) =>
        i.message.includes("xterm") && i.message.includes("deno.json")
      ),
      true,
    );
  });
});

Deno.test("aiol: allows bare specifier that IS in deno.json", async () => {
  await withTmpDir(async (dir) => {
    await Deno.mkdir(join(dir, "src"), { recursive: true });
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({
        imports: {
          "aio": "jsr:@riagentic/aio@1.0.0",
          "react": "npm:react@18",
          "xterm": "npm:xterm@5",
        },
        unstable: ["kv"],
      }),
    );
    await Deno.writeTextFile(
      join(dir, "src", "App.tsx"),
      `
import { Terminal } from 'xterm'
export default function App() { return <div/> }
`,
    );
    const issues = await runCheckUI(dir);
    assertEquals(issues.some((i) => i.message.includes("xterm")), false);
  });
});

Deno.test("aiol: flags static dynamic import of server-only file", async () => {
  await withTmpDir(async (dir) => {
    await Deno.mkdir(join(dir, "src"), { recursive: true });
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({
        imports: { "aio": "jsr:@riagentic/aio@1.0.0" },
        unstable: ["kv"],
      }),
    );
    await Deno.writeTextFile(
      join(dir, "src", "App.tsx"),
      "export default function App() { return <div/> }",
    );
    await Deno.writeTextFile(
      join(dir, "src", "counter.ts"),
      `
import { feature } from 'aio'
const load = () => import('./helpers.ts')
export const counter = feature('counter', { state: { count: 0 }, methods: { inc: (s) => { s.count++ } } })
`,
    );
    await Deno.writeTextFile(
      join(dir, "src", "helpers.ts"),
      `
import { readFile } from '@std/fs'
export const load = () => readFile('/tmp/x')
`,
    );
    const issues = await runCheckUI(dir);
    assertEquals(
      issues.some((i) =>
        i.severity === "warn" && i.message.includes("static dynamic import") &&
        i.message.includes("helpers.ts")
      ),
      true,
    );
  });
});

Deno.test("aiol: does NOT flag dynamic import of browser-safe file", async () => {
  await withTmpDir(async (dir) => {
    await Deno.mkdir(join(dir, "src"), { recursive: true });
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({
        imports: { "aio": "jsr:@riagentic/aio@1.0.0" },
        unstable: ["kv"],
      }),
    );
    await Deno.writeTextFile(
      join(dir, "src", "App.tsx"),
      "export default function App() { return <div/> }",
    );
    await Deno.writeTextFile(
      join(dir, "src", "counter.ts"),
      `
import { feature } from 'aio'
const load = () => import('./ui-utils.ts')
export const counter = feature('counter', { state: { count: 0 }, methods: { inc: (s) => { s.count++ } } })
`,
    );
    await Deno.writeTextFile(
      join(dir, "src", "ui-utils.ts"),
      `
export function formatNumber(n: number) { return n.toLocaleString() }
`,
    );
    const issues = await runCheckUI(dir);
    assertEquals(
      issues.some((i) => i.message.includes("static dynamic import")),
      false,
    );
  });
});

Deno.test("aiol: flags transitive @std/* import 2 levels deep", async () => {
  await withTmpDir(async (dir) => {
    await Deno.mkdir(join(dir, "src", "features"), { recursive: true });
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({
        imports: { "aio": "jsr:@riagentic/aio@1.0.0", "react": "npm:react@18" },
        unstable: ["kv"],
      }),
    );
    // App.tsx imports feature index
    await Deno.writeTextFile(
      join(dir, "src", "App.tsx"),
      `
import { counter } from './features/counter.ts'
export default function App() { return <div/> }
`,
    );
    // Feature index imports helpers (no direct @std)
    await Deno.writeTextFile(
      join(dir, "src", "features", "counter.ts"),
      `
import { feature } from 'aio'
import { loadData } from './helpers.ts'
export const counter = feature('counter', { state: { count: 0 }, methods: { inc: (s) => { s.count++ } } })
`,
    );
    // Helpers has @std import
    await Deno.writeTextFile(
      join(dir, "src", "features", "helpers.ts"),
      `
import { join } from '@std/path'
export function loadData() { return join('a', 'b') }
`,
    );
    const issues = await runCheckUI(dir);
    assertEquals(
      issues.some((i) =>
        i.message.includes("@std/path") && i.message.includes("transitive")
      ),
      true,
    );
  });
});
