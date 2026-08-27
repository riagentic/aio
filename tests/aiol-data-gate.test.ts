// The update data gate protects the cells that declare a version — and only
// those. Nothing said so.
//
// `_cellVersions` collects cells with `version > 0`; `_versionStamp` stamps only
// those; `dataCompatibility` iterates only what was stamped. A cell that never
// declared `version` is therefore invisible to the gate: a release that renames
// one of its fields is offered to every install as compatible, the merge drops
// the field, and the persist window writes the loss back. A field report found
// an app with 35 cells, 20 of them persisted, and not one `version:` line — the
// promise "an update never breaks your data" could not be kept for a single
// cell it had, and no tool anywhere said so.
//
// The rule fires ONLY for an app that configures `updates`. A cell in an app
// that never updates itself has nothing to be protected from, and warning there
// would make this the next finding people learn to scroll past.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { buildContext } from "../aiol/context.ts";
import { checkPersistence } from "../aiol/checks.ts";

const CELLS = `import { cell } from "aio";
export const vault = cell("vault", {
  state: { seeds: [] as string[] },
  methods: { add(s: { seeds: string[] }, x: string) { s.seeds.push(x); } },
});
export const prefs = cell("prefs", {
  version: 1,
  state: { theme: "dark" },
  methods: { set(s: { theme: string }, t: string) { s.theme = t; } },
});
export const tmp = cell("tmp", {
  persist: false,
  state: { n: 0 },
  methods: { inc(s: { n: number }) { s.n++; } },
});
`;

async function project(updates: boolean): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "aiol-datagate-" });
  await Deno.mkdir(join(dir, "src"), { recursive: true });
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify({
      appId: "dg",
      imports: { aio: "jsr:@riagentic/aio@1.0.0" },
    }),
  );
  await Deno.writeTextFile(join(dir, "src", "cell.ts"), CELLS);
  await Deno.writeTextFile(
    join(dir, "src", "app.ts"),
    `import { aio } from "aio";\nimport "./cell.ts";\nawait aio.run({ appId: "dg"${
      updates ? `, updates: { source: "https://r.example.com/dg" }` : ""
    } });\n`,
  );
  return dir;
}

Deno.test("aiol: an updating app is told which cells the data gate cannot protect", async () => {
  const dir = await project(true);
  try {
    const { ctx, report } = await buildContext(dir);
    checkPersistence(ctx);
    const data = report.issues.filter((i) => i.area === "data");
    assertEquals(data.length, 1, "one line for all of them, not one per cell");
    const msg = data[0]!.message;
    // The cell that persists and declares nothing.
    assert(msg.includes("vault"), msg);
    // NOT the one that declares a version…
    assert(!msg.includes("prefs"), `a versioned cell is covered: ${msg}`);
    // …and NOT the one that keeps nothing on disk.
    assert(!msg.includes("tmp"), `persist: false has no data to gate: ${msg}`);
    // The fix is in the message, including that the first stamp is free —
    // otherwise the reader reasonably fears it triggers a migration.
    assert(msg.includes("version: 1"), msg);
    assert(msg.includes("onMigrate"), msg);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("aiol: an app that does not update is not told about versions", async () => {
  const dir = await project(false);
  try {
    const { ctx, report } = await buildContext(dir);
    checkPersistence(ctx);
    assertEquals(
      report.issues.filter((i) => i.area === "data").map((i) => i.message),
      [],
      "a cell in an app that never updates itself has nothing to be protected " +
        "from — warning here is how a rule becomes noise",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
