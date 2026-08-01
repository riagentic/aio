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

Deno.test("preflight: a file with no cell() call is not scanned", async () => {
  // `machine:` in a plain object elsewhere is not a cell config key.
  const dir = await app({
    "src/config.ts": `export const opts = { machine: "x86_64" };\n`,
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
