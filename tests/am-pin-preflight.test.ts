// Moving a pin FORWARD is the ladder: allowed to be work, never allowed to be
// a surprise.
//
// The failure this prevents: `am pin --latest` succeeds, the app builds, and
// dies at boot on a config key the new version dropped — with the tool having
// just told the author the move was fine. So the pin does not change until the
// app's own source has been read for spellings the target no longer accepts.
//
// The mirror case matters as much: moving BACKWARD to a version that still runs
// the old spelling must stay silent. A check that fires when the answer is "yes
// this works" trains people to pass --force by reflex.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { preflight } from "../src/am/am-cmd-pin.ts";
import { REMOVALS } from "../src/state/removals.ts";

const machine = REMOVALS.find((r) => r.key === "machine")!;

async function app(files: Record<string, string>): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "aio-preflight-" });
  for (const [rel, body] of Object.entries(files)) {
    const path = join(dir, rel);
    await Deno.mkdir(join(path, ".."), { recursive: true });
    await Deno.writeTextFile(path, body);
  }
  return dir;
}

const LEGACY = `import { cell } from "aio";
export const app = cell("demo", {
  state: { n: 0 },
  machine: { initial: "idle", states: { idle: {} } },
  methods: { bump(s: { n: number }) { s.n++ } },
});
`;

const MODERN = `import { cell } from "aio";
export const app = cell("demo", {
  state: { n: 0, status: "idle" },
  methods: { bump(s: { n: number }) { s.n++ } },
});
`;

Deno.test("preflight: a forward move that would break the app is reported", async () => {
  const dir = await app({ "src/cell.ts": LEGACY });
  try {
    const blocking = await preflight(dir, "v1.0.0-alpha42");
    assertEquals(blocking.length, 1);
    assertEquals(blocking[0]!.hit.removal.key, "machine");
    assertEquals(
      blocking[0]!.where,
      "src/cell.ts:4",
      "the author needs file:line, not just a key name",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("preflight: moving BACK to a version that still runs it is silent", async () => {
  const dir = await app({ "src/cell.ts": LEGACY });
  try {
    assertEquals(await preflight(dir, machine.lastGood), []);
    assertEquals(await preflight(dir, "v1.0.0-alpha20"), []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("preflight: an unorderable target (main, path pin) counts as the tip", async () => {
  const dir = await app({ "src/cell.ts": LEGACY });
  try {
    // `main` is ahead of every release by definition — guessing "probably
    // fine" here is exactly the silent breakage this exists to stop.
    assertEquals((await preflight(dir, "main")).length, 1);
    assertEquals((await preflight(dir, "main-95edafac4617")).length, 1);
    assertEquals((await preflight(dir, "path:/tmp/aio")).length, 1);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("preflight: a modern app moves forward clean", async () => {
  const dir = await app({ "src/cell.ts": MODERN });
  try {
    assertEquals(await preflight(dir, "v1.0.0-alpha42"), []);
    assertEquals(await preflight(dir, "main"), []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("preflight: reads the app, never the framework or build output", async () => {
  // dep/aio IS the framework — full of the word `machine:` in tests and docs.
  // Scanning it would make every upgrade look catastrophic.
  const dir = await app({
    "src/cell.ts": MODERN,
    "dep/aio/src/legacy.ts": LEGACY,
    "node_modules/pkg/cell.ts": LEGACY,
    "dist/bundle.ts": LEGACY,
    "coverage/x.ts": LEGACY,
  });
  try {
    assertEquals(await preflight(dir, "main"), []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("preflight: a file with nothing retired in it produces no finding", async () => {
  // alpha70: EVERY source file is scanned (a retired import or key can live
  // anywhere, not only next to a cell() call — that gap shipped a broken
  // pin), so the pin is what the scan reports, not which files it opens:
  // a file free of retired spellings is silent.
  const dir = await app({
    "src/config.ts": `export const opts = { arch: "x86_64" };\n`,
  });
  try {
    assertEquals(await preflight(dir, "main"), []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("preflight: every cell-config removal can be detected in real source", async () => {
  // Row-driven: a future removal is covered the day its row lands.
  for (const r of REMOVALS.filter((x) => x.kind === "cell-config")) {
    const dir = await app({
      "src/cell.ts": `import { cell } from "aio";
export const app = cell("demo", {
  state: { n: 0 },
  ${r.key}: {},
});
`,
    });
    try {
      const blocking = await preflight(dir, "main");
      assertEquals(
        blocking.map((b) => b.hit.removal.key),
        [r.key],
        `preflight missed '${r.key}:'`,
      );
      assertStringIncludes(blocking[0]!.where, "src/cell.ts:");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  }
});

Deno.test("preflight: a removed key inside a nested object is still found", async () => {
  const dir = await app({
    "src/cell.ts": `import { cell } from "aio";
export const app = cell("demo", { state: { n: 0 }, machine: { initial: "a" } });
`,
  });
  try {
    const blocking = await preflight(dir, "main");
    assertEquals(blocking.length, 1);
    assert(blocking[0]!.where.endsWith(":2"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// cc §5.2: `am pin ~/code/gen/aio` was refused for an app whose only `machine:`
// was a key in a UI scope-label map (`src/ui/RunViews.tsx:35`), in a file that
// also calls `cell(`. The guard matched the text anywhere in the file, and
// `--force` was the only way past a check that is otherwise exactly right to
// have. A cell-config key is a key of the object handed to `cell(...)`, and
// nowhere else.
Deno.test("preflight: a `machine:` key OUTSIDE the cell config is not a hit", async () => {
  const dir = await app({
    "src/ui/RunViews.tsx": `import { cell } from "aio";
export const views = cell("views", {
  state: { open: "list" },
  methods: { show(s: { open: string }, v: string) { s.open = v; } },
});
const SCOPE_LABELS: Record<string, { machine: { label: string } }> = {
  run: { machine: { label: "Machine" } },
  container: { machine: { label: "Container" } },
};
export default function RunViews() { return <div>{SCOPE_LABELS.run.machine.label}</div>; }
`,
  });
  try {
    const blocking = await preflight(dir, "v1.0.0-alpha76");
    assertEquals(
      blocking.filter((b) => b.hit.removal.key === "machine").length,
      0,
      `a scope-label map is not a cell config: ${JSON.stringify(blocking)}`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("preflight: the same key INSIDE the cell config still hits", async () => {
  const dir = await app({ "src/cell/app.ts": LEGACY });
  try {
    const blocking = await preflight(dir, "v1.0.0-alpha76");
    assertEquals(blocking.some((b) => b.hit.removal.key === "machine"), true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ── the config half of the preflight reads the file Deno reads ──────────────
//
// The source walk above saw every `.ts`; the deno.json check beside it did a
// raw `JSON.parse` of `deno.json` and nothing else. So a `deno.jsonc` app —
// or a `deno.json` with one `//` comment, which Deno accepts — got NO config
// preflight: a removed top-level key (`target`) was silently not seen, the
// pin moved, and the app died at boot on the framework the tool had just
// called fine. `cmdPin` accepted both names at its door; the check behind the
// door read only one. `readDenoJson` is THE reader now.
const target = REMOVALS.find((r) =>
  r.key === "target" && r.kind === "deno-json"
)!;

const LEGACY_CONFIG = `{
  // the pre-alpha70 spelling of the client key
  "target": "browser",
}
`;

Deno.test("preflight: a deno.jsonc app is refused by name, exactly as deno.json is", async () => {
  const dir = await app({ "deno.jsonc": LEGACY_CONFIG, "src/cell.ts": MODERN });
  try {
    const blocking = await preflight(dir, "main");
    assertEquals(blocking.length, 1, JSON.stringify(blocking));
    assertEquals(blocking[0]!.hit.removal.key, "target");
    assertEquals(
      blocking[0]!.where,
      "deno.jsonc:3",
      "file:line, the real file",
    );
    assertStringIncludes(blocking[0]!.hit.text, '"target"');
    // …and moving BACK to a version that still runs it stays silent.
    assertEquals(await preflight(dir, target.lastGood), []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("preflight: a deno.json with a comment is read the way Deno reads it", async () => {
  const dir = await app({ "deno.json": LEGACY_CONFIG, "src/cell.ts": MODERN });
  try {
    const blocking = await preflight(dir, "main");
    assertEquals(blocking.length, 1, JSON.stringify(blocking));
    assertEquals(blocking[0]!.where, "deno.json:3");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
