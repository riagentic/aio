// aiol rule 25d — a cell method called from a timer.
//
// `docs/state/methods.md` says it plainly: "never write
// `setTimeout(() => cell.other(), 0)` — it escapes the action log, time-travel,
// and cancellation." A field report shipped exactly that in FIVE `onInit`s,
// each with an `aiol-ok` comment arguing it was necessary. It was not.
//
// The prohibition alone did not hold because it lives in one file, and the page
// a reader lands on for "start work at boot" had no worked example. That is
// fixed too; this is the half that refuses.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { buildContext } from "../aiol/context.ts";
import { checkTimerDispatch } from "../aiol/checks.ts";

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
    await checkTimerDispatch(ctx);
    return report.issues;
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const CELL = `import { cell } from "aio";
export const projects = cell("projects", {
  state: { list: [] as string[] },
  methods: { scan(s: { list: string[] }) { s.list = []; } },
});
`;

Deno.test("aiol: setTimeout(() => cell.method()) is an error naming three doors", async () => {
  const found = await issues({
    "src/cell.ts": CELL + `
export function boot() {
  setTimeout(() => projects.scan(), 0);
}
`,
  });
  assertEquals(found.length, 1, JSON.stringify(found));
  const i = found[0]!;
  assertEquals(i.severity, "error");
  assert(i.message.includes("projects.scan()"), i.message);
  assert(i.message.includes("action log"), i.message);
  // All three alternatives, because the reporter had a real need and reached
  // for the timer only because nothing else was in front of them.
  assert(i.message.includes("app.dispatch"), "the onInit door");
  assert(i.message.includes("onStart"), "the boot-once door");
  assert(i.message.includes("schedules:"), "the repeating door");
});

Deno.test("aiol: `void` and setInterval are the same mistake", async () => {
  for (
    const call of [
      `setTimeout(() => void projects.scan(), 0);`,
      `setInterval(() => projects.scan(), 5000);`,
    ]
  ) {
    const found = await issues({
      "src/cell.ts": CELL + `export function boot() { ${call} }\n`,
    });
    assertEquals(found.length, 1, `${call} → ${JSON.stringify(found)}`);
  }
});

Deno.test("aiol: a timer calling a PLAIN function is ordinary code", async () => {
  // Narrow on purpose. Only a CELL METHOD escapes the log by this route, and a
  // rule that flagged every `setTimeout` would be turned off within a day.
  assertEquals(
    await issues({
      "src/cell.ts": CELL + `
const helper = { refresh() {} };
export function boot() { setTimeout(() => helper.refresh(), 0); }
`,
    }),
    [],
  );
});

Deno.test("aiol: aiol-ok suppresses it, for the case that earns it", async () => {
  assertEquals(
    await issues({
      "src/cell.ts": CELL + `
export function boot() {
  // aiol-ok: deliberately outside the log — see ADR-7
  setTimeout(() => projects.scan(), 0);
}
`,
    }),
    [],
  );
});
