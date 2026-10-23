// peerTypes: an app publishes its call types as source text; `describe()`
// serves them, and `am peer <target> --types=<file>` saves them — typed calls
// for a caller that has none of the app's source.
import "./store-sandbox.ts";
import { assert, assertEquals, assertThrows } from "@std/assert";
import { cell } from "../src/state/cell-create.ts";
import { testApps } from "../src/testing/apps-test.ts";
import { peer } from "../src/server/peer.ts";
import { checkPeerTypes } from "../src/server/peer-describe.ts";
import { peerListing } from "../src/am/am-cmd-peer.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const TYPES = "export type Ledger = { credit(by: number): number };\n";
let n = 0;
const ledger = () =>
  cell(`tledger${n++}`, {
    state: { b: 0 },
    methods: {
      credit(s: { b: number }, by: number) {
        s.b += by;
        return s.b;
      },
    },
  });

Deno.test("describe() serves the published types; an app without them has none", async () => {
  const l = ledger();
  await using world = await testApps({
    pub: { cells: [l], peerTypes: TYPES },
    bare: { cells: [ledger()] },
  });
  using a = (await peer(world.get("pub").url))!;
  assertEquals((await a.describe()).types, TYPES);
  using b = (await peer(world.get("bare").url))!;
  assertEquals((await b.describe()).types, undefined);
});

Deno.test("peerTypes that is not source text throws at boot, naming the fix", () => {
  assertEquals(checkPeerTypes(TYPES), TYPES);
  assertThrows(() => checkPeerTypes({}), TypeError, 'with { type: "text" }');
});

Deno.test("am peer: lists what may be called, and --types=<file> saves the types", async () => {
  const l = ledger();
  await using world = await testApps({ pub: { cells: [l], peerTypes: TYPES } });
  const url = world.get("pub").url;
  const am = (args: string[]) =>
    new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", "src/am.ts", "peer", url, ...args],
      stdout: "piped",
      stderr: "piped",
    }).output();
  const list = await am([]);
  const out = new TextDecoder().decode(list.stdout);
  assertEquals(list.code, 0, new TextDecoder().decode(list.stderr));
  // Piped, am answers in JSON (its convention): the description itself.
  const d = JSON.parse(out);
  assertEquals(d.cells[l.__aio.id].methods.credit, { args: 1, async: false });
  assertEquals(d.types, TYPES);
  const file = await Deno.makeTempFile({ suffix: ".ts" });
  try {
    const saved = await am([`--types=${file}`]);
    assertEquals(saved.code, 0, new TextDecoder().decode(saved.stderr));
    const text = await Deno.readTextFile(file);
    assert(text.endsWith(TYPES), text);
    assert(text.startsWith("// Types published by"), text);
  } finally {
    await Deno.remove(file);
  }
  // Piped, am answers in JSON — the raw text is `types` in it.
  const raw = await am(["--types"]);
  assertEquals(JSON.parse(new TextDecoder().decode(raw.stdout)).types, TYPES);

  const dir = await tempDir("peer-types-");
  try {
    // A missing folder is made; a file am peer did not write is never overwritten.
    const nested = `${dir}/src/peers/pub.ts`;
    assertEquals((await am([`--types=${nested}`])).code, 0);
    assert((await Deno.readTextFile(nested)).endsWith(TYPES));
    const mine = `${dir}/main.ts`;
    await Deno.writeTextFile(mine, "console.log('keep me')\n");
    const refused = await am([`--types=${mine}`]);
    assertEquals(refused.code, 1);
    assertEquals(await Deno.readTextFile(mine), "console.log('keep me')\n");
    // A file name given as a separate word is said, not ignored.
    assertEquals((await am(["--types", `${dir}/x.ts`])).code, 1);
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("peerListing: says when nothing may be called and when no types are published", () => {
  const text = peerListing({ app: "x", version: "1", aio: "a", cells: {} });
  assert(text.includes("nothing this caller may call"));
  assert(text.includes("none published"));
});
