// A state key may contain ANY character — NUL included — and patch path
// identity must not collide on one.
//
// `compactPatches`, `narrowArrayPatches`, `narrowStringPatches` and the
// applier's `_impossibleOp` each keyed paths by joining the segments with
// "\0". So `["files", "a\0b"]` and `["files", "a", "b"]` were the SAME path:
//   • the compactor read a write to one as superseded by a later write to the
//     other and DROPPED it — server `"NEW"`, client `"old"`, no error anywhere;
//   • the applier tracked one array's length under the other's key and refused
//     a perfectly valid frame as "a delta was lost".
// Keys from uploaded file names, user input or binary-ish ids are exactly where
// a NUL turns up. One collision-free key (`_pathKey`) now serves all four.
import { assert, assertEquals } from "@std/assert";
import { enablePatches, type Patch, produceWithPatches } from "immer";
import { compactPatches, narrowPatches } from "../src/state/patch-compact.ts";
import {
  _pathKey,
  applyWirePatches,
  type WirePatch,
} from "../src/protocol/patch-ops.ts";

enablePatches();

const NUL = String.fromCharCode(0);

/** Every dispatch as the server runs it, then one coalesced frame through
 *  compaction and JSON, applied on a fresh client copy of the base. */
function roundTrip<T extends object>(
  base: T,
  commits: ((d: T) => void)[],
): { server: T; client: T } {
  let server = base;
  const raw: WirePatch[] = [];
  for (const fn of commits) {
    const [next, ops] = produceWithPatches(server, fn);
    raw.push(...narrowPatches(server, ops as Patch[]));
    server = next;
  }
  const frame = JSON.parse(JSON.stringify(compactPatches(raw)));
  return { server, client: applyWirePatches(structuredClone(base), frame) };
}

Deno.test("path key: a NUL inside a key never collides with a deeper path (compaction)", () => {
  const K = `a${NUL}b`;
  const base = { files: { [K]: "old", a: { b: "x" } } as Record<string, any> };
  const { server, client } = roundTrip(base, [
    (d) => void (d.files[K] = "NEW"),
    (d) => void (d.files.a.b = "y"),
  ]);
  assertEquals(server.files[K], "NEW");
  assertEquals(client, server, "the client must hold the write to the NUL key");
});

Deno.test("path key: the reverse order — the deeper write first", () => {
  const K = `a${NUL}b`;
  const base = { files: { [K]: "old", a: { b: "x" } } as Record<string, any> };
  const { server, client } = roundTrip(base, [
    (d) => void (d.files.a.b = "y"),
    (d) => void (d.files[K] = "NEW"),
  ]);
  assertEquals(client, server);
});

Deno.test("path key: the applier's length tracking does not confuse the two arrays", () => {
  const K = `a${NUL}b`;
  const base = { [K]: [1], a: { b: [1, 2, 3] } } as Record<string, any>;
  // Both legal: each `add` lands at its own array's end. Keyed by NUL-join,
  // the second read the FIRST array's length (2) and refused index 3.
  const ops: WirePatch[] = [
    { op: "add", path: [K, 1], value: 2 },
    { op: "add", path: ["a", "b", 3], value: 4 },
  ];
  assertEquals(applyWirePatches(base, ops), {
    [K]: [1, 2],
    a: { b: [1, 2, 3, 4] },
  });
});

Deno.test("path key: a ROOT replace forgets every length it knew", () => {
  // Same helper, second defect: the root key is "", and "" + NUL prefixes
  // nothing — so a whole-state replacement left the old lengths trusted and
  // the next valid index op was refused as a lost delta.
  const base = { items: [] as number[] };
  const ops: WirePatch[] = [
    { op: "replace", path: [], value: { items: [1, 2] } },
    { op: "add", path: ["items", 2], value: 3 },
  ];
  assertEquals(applyWirePatches(base, ops), { items: [1, 2, 3] });
});

Deno.test("path key: randomized keys from a hostile alphabet — no two paths share a key", () => {
  // The property itself, over the characters a separator-based key would
  // have to reserve: distinct paths ⇒ distinct keys, and a key is a string
  // prefix of another exactly when its path is a path prefix.
  const ALPHA = ["", NUL, ":", "0", "1", "10", "a", "1:a", `${NUL}${NUL}`];
  let s = 7;
  const rand = (n: number) => (s = (s * 1664525 + 1013904223) >>> 0) % n;
  const path = () =>
    Array.from({ length: rand(4) }, () => ALPHA[rand(ALPHA.length)]!);
  const seen = new Map<string, string>();
  for (let i = 0; i < 5000; i++) {
    const a = path();
    const b = path();
    const ka = _pathKey(a);
    const prior = seen.get(ka);
    if (prior !== undefined) {
      assertEquals(
        prior,
        JSON.stringify(a),
        `collision on ${JSON.stringify(a)}`,
      );
    }
    seen.set(ka, JSON.stringify(a));
    const isPathPrefix = a.length <= b.length && a.every((x, j) => x === b[j]);
    assertEquals(
      _pathKey(b).startsWith(ka),
      isPathPrefix,
      `${JSON.stringify(a)} vs ${JSON.stringify(b)}`,
    );
  }
  assert(seen.size > 500, `only ${seen.size} distinct paths drawn`);
  // Number and string forms of one index are ONE property — one key.
  assertEquals(_pathKey(["items", 0]), _pathKey(["items", "0"]));
});
