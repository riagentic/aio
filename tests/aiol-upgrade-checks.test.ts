// aiol checkUpgrade — deprecated spellings are found AND mechanically fixed.
// aio keeps renamed options working for the rest of the major, so these are
// never emergencies; they're the "upgrade tax" apps complained about, and the
// point is that `aiol --safe-fix` pays it for you.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { buildContext } from "../aiol/context.ts";
import { checkUpgrade } from "../aiol/checks.ts";

async function withProject(
  files: Record<string, string>,
  denoJson: Record<string, unknown>,
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(dir, "src"), { recursive: true });
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({
        imports: { "aio": "jsr:@riagentic/aio@1.0.0" },
        ...denoJson,
      }),
    );
    for (const [rel, content] of Object.entries(files)) {
      await Deno.writeTextFile(join(dir, rel), content);
    }
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

async function upgradeIssues(dir: string) {
  const { ctx, report } = await buildContext(dir);
  await checkUpgrade(ctx);
  return report.issues.filter((i) => i.area === "upgrade");
}

const APP =
  `import { aio } from "aio";\nawait aio.run({ appId: "x", cells: [] });\n`;

Deno.test("aiol upgrade: call({ timeout }) is flagged and rewritten to timeoutMs", async () => {
  await withProject(
    {
      "src/app.ts": APP,
      "src/cell.ts": `
import { call, cell } from "aio";
export const c = cell("c", {
  state: { n: 0 },
  methods: {
    async pull(s) {
      s.n = await call({ timeout: 5000, retries: 2 }, () => fetchN());
    },
  },
});
`,
    },
    {},
    async (dir) => {
      const issues = await upgradeIssues(dir);
      const hit = issues.filter((i) => i.message.includes("timeoutMs"));
      assertEquals(hit.length, 1, "the deprecated alias is reported once");
      assert(hit[0]!.safeFix, "and it is auto-fixable");

      assertEquals(await hit[0]!.safeFix!(dir), true, "the fix applies");
      const after = await Deno.readTextFile(join(dir, "src", "cell.ts"));
      assert(after.includes("timeoutMs: 5000"), after);
      assert(!/\btimeout:/.test(after), "no deprecated spelling left");
      assert(after.includes("retries: 2"), "other options untouched");
      assertEquals(
        (await upgradeIssues(dir)).length,
        0,
        "and the project lints clean afterwards",
      );
    },
  );
});

Deno.test("aiol upgrade: a `timeout:` outside call() is left alone", async () => {
  await withProject(
    {
      "src/app.ts": APP,
      "src/cell.ts": `
import { cell } from "aio";
// timeout: the old name (a comment, not code)
export const c = cell("c", {
  state: { opts: { timeout: 30 } },
  methods: { set(s: { opts: { timeout: number } }) { s.opts.timeout = 60; } },
});
`,
    },
    {},
    async (dir) => {
      assertEquals(
        await upgradeIssues(dir),
        [],
        "an app's own `timeout` field is not aio's call() option",
      );
    },
  );
});

Deno.test("aiol upgrade: renamed TLS flags in a task are flagged and rewritten", async () => {
  await withProject(
    { "src/app.ts": APP },
    {
      tasks: {
        dev: "deno run -A src/app.ts",
        serve:
          "deno run -A src/app.ts --expose --cert=/etc/c.pem --key=/etc/k.pem",
      },
    },
    async (dir) => {
      const issues = await upgradeIssues(dir);
      const hit = issues.filter((i) => i.message.includes("--tls-cert"));
      assertEquals(hit.length, 1);
      assertEquals(await hit[0]!.safeFix!(dir), true);
      const dj = JSON.parse(await Deno.readTextFile(join(dir, "deno.json")));
      assertEquals(
        dj.tasks.serve,
        "deno run -A src/app.ts --expose --tls-cert=/etc/c.pem --tls-key=/etc/k.pem",
      );
      assertEquals(
        dj.tasks.dev,
        "deno run -A src/app.ts",
        "other tasks intact",
      );
    },
  );
});

Deno.test("aiol upgrade: --headless on a RUN task is flagged, on a build task it isn't", async () => {
  // The real bug this catches: a generated systemd unit passed --headless at
  // runtime, where it is ignored — the service started a client and crash-looped.
  await withProject(
    { "src/app.ts": APP },
    {
      tasks: {
        "compile:service": "deno run -A src/build.ts --compile --headless",
        "serve": "deno run -A src/app.ts --headless --port=8000",
      },
    },
    async (dir) => {
      const issues = await upgradeIssues(dir);
      const hit = issues.filter((i) =>
        i.message.includes("--client=server-only")
      );
      assertEquals(hit.length, 1, "only the run task is a problem");
      assertEquals(await hit[0]!.safeFix!(dir), true);
      const dj = JSON.parse(await Deno.readTextFile(join(dir, "deno.json")));
      assertEquals(
        dj.tasks.serve,
        "deno run -A src/app.ts --client=server-only --port=8000",
      );
      assertEquals(
        dj.tasks["compile:service"],
        "deno run -A src/build.ts --compile --headless",
        "a BUILD task keeps --headless — it is a valid build flag",
      );
    },
  );
});

Deno.test("aiol upgrade: a modern project reports nothing", async () => {
  await withProject(
    {
      "src/app.ts": APP,
      "src/cell.ts": `
import { call, cell } from "aio";
export const c = cell("c", {
  state: { n: 0 },
  methods: { async pull(s) { s.n = await call({ timeoutMs: 5000 }, () => fetchN()); } },
});
`,
    },
    {
      tasks: {
        serve:
          "deno run -A src/app.ts --client=server-only --tls-cert=/etc/c.pem",
      },
    },
    async (dir) => {
      assertEquals(await upgradeIssues(dir), []);
    },
  );
});

Deno.test('aiol upgrade: a server-only symbol imported from "aio" is flagged and split', async () => {
  // alpha37 moved createDB/connectCli to the `aio/server` entry. The old form
  // was the classic blank-screen: it link-fails only when a real browser links
  // the graph, long after every server-side check passed.
  await withProject(
    {
      "src/app.ts": APP,
      "src/store.server.ts": `import { cell, createDB } from "aio";
export const db = createDB(":memory:");
export const c = cell("c", { state: { n: 0 }, methods: {} });
`,
    },
    {},
    async (dir) => {
      const issues = await upgradeIssues(dir);
      const hit = issues.filter((i) => i.message.includes("aio/server"));
      assertEquals(hit.length, 1, JSON.stringify(issues));
      assertEquals(await hit[0]!.safeFix!(dir), true);

      const after = await Deno.readTextFile(
        join(dir, "src", "store.server.ts"),
      );
      assert(
        after.includes('import { createDB } from "aio/server";'),
        `server symbol moved: ${after}`,
      );
      assert(
        after.includes('import { cell } from "aio";'),
        `the rest stays on "aio": ${after}`,
      );
      assertEquals(
        (await upgradeIssues(dir)).filter((i) =>
          i.message.includes("aio/server")
        ),
        [],
        "and the project lints clean afterwards",
      );
    },
  );
});

Deno.test("aiol upgrade: an app already on aio/server is untouched", async () => {
  await withProject(
    {
      "src/app.ts": APP,
      "src/store.server.ts":
        `import { createDB } from "aio/server";\nexport const db = createDB(":memory:");\n`,
    },
    {},
    async (dir) => {
      assertEquals(
        (await upgradeIssues(dir)).filter((i) =>
          i.message.includes("aio/server")
        ),
        [],
      );
    },
  );
});
