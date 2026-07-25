// The static half of the worker peer-read guard (risoto's line in the sand:
// "worker: true + a peer-cell read should fail loudly at BOOT instead of
// quietly reading nothing"). The runtime throw is the guarantee; this reports
// the same mistake with file:line before anything runs.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { buildContext } from "../aiol/context.ts";
import { checkWorkerPeerReads } from "../aiol/checks.ts";

async function issues(files: Record<string, string>) {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(dir, "src"), { recursive: true });
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({ imports: { aio: "jsr:@riagentic/aio@1.0.0" } }),
    );
    for (const [rel, src] of Object.entries(files)) {
      await Deno.writeTextFile(join(dir, rel), src);
    }
    const { ctx, report } = await buildContext(dir);
    await checkWorkerPeerReads(ctx);
    return report.issues;
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const ACCOUNTS = `import { cell } from "aio";
export const accounts = cell("accounts", {
  state: { list: [] as string[], active: "" },
  methods: { add(s: { list: string[] }, a: string) { s.list.push(a); } },
});
`;

Deno.test("aiol: a worker cell reading a peer cell is an ERROR, named and located", async () => {
  const found = await issues({
    "src/accounts.ts": ACCOUNTS,
    "src/heavy.ts": `import { cell } from "aio";
import { accounts } from "./accounts.ts";
export const heavy = cell("heavy", {
  worker: true,
  state: { out: "" },
  methods: {
    run(s: { out: string }) {
      s.out = accounts.active;   // ← the trap: reads an unbooted peer copy
    },
  },
});
`,
  });
  assertEquals(found.length, 1, JSON.stringify(found));
  assertEquals(found[0]!.severity, "error");
  assert(found[0]!.message.includes("accounts.active"), found[0]!.message);
  assert(found[0]!.message.includes("worker: true"), found[0]!.message);
  assert(found[0]!.message.includes("designated-thread"), "names the idiom");
});

Deno.test("aiol: the designated-heavy-cell idiom passes clean", async () => {
  const clean = await issues({
    "src/accounts.ts": ACCOUNTS,
    "src/heavy.ts": `import { cell } from "aio";
export const heavy = cell("heavy", {
  worker: true,
  state: { out: "" },
  methods: {
    // Values arrive as ARGUMENTS — nothing peeks at another cell.
    run(s: { out: string }, active: string) { s.out = active; },
  },
});
`,
  });
  assertEquals(clean, []);
});

Deno.test("aiol: a NON-worker cell reading a peer is untouched", async () => {
  const clean = await issues({
    "src/accounts.ts": ACCOUNTS,
    "src/view.ts": `import { cell } from "aio";
import { accounts } from "./accounts.ts";
export const view = cell("view", {
  state: { label: "" },
  methods: { sync(s: { label: string }) { s.label = accounts.active; } },
});
`,
  });
  assertEquals(clean, [], "cross-cell reads are normal on the main isolate");
});
