// updates-patch.test.ts — a release installed from a patch against what is
// installed: the decoder, the manifest's patch list and its signature, the
// choice of a patch, and the whole path — with every way it can miss ending
// in the whole release being downloaded.
import "./store-sandbox.ts";
import { programBytes, writeProgram } from "./fake-program-helper.ts";
import { hasZstd, patchOf, zstdDecodeInto } from "./zstd-patch-helper.ts";
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import zlib from "node:zlib";
import { createHash } from "node:crypto";
import {
  buildReleaseManifest,
  generateSigningKey,
  manifestCore,
  patchesCore,
  type ReleasePatch,
  type ShipManifest,
  usablePatches,
  verifyManifestClaims,
  withPatches,
} from "../src/build/ship.ts";
import { createUpdatesRuntime } from "../src/server/updates-runtime.ts";
import { resolveUpdates } from "../src/server/updates-core.ts";
import {
  downloadArtifact,
  parseShipManifest,
  readTrust,
} from "../src/server/updates-check.ts";
import {
  beginUpdates,
  MAX_FAILED_SWAPS,
  startUpdates,
} from "../src/server/updates-boot.ts";
import type { UpdatesSlot } from "../src/state/updates-cell.ts";
import {
  _patchDeps,
  applyPatch,
  memoryShort,
  pickPatch,
} from "../src/server/updates-patch.ts";
import { isOwn, ownedPath, readOwned } from "../src/server/updates-owned.ts";
import { _swapDeps } from "../src/server/updates-apply.ts";
import { makePatches } from "../src/am/am-cmd-publish.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import type { Log } from "../src/diagnostics/logger.ts";

const platform = { os: Deno.build.os, arch: Deno.build.arch };
const hex = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** Repeatable noise: a failing case must fail the same way twice. */
function noise(seed: number): () => number {
  return () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32;
}

function sample(kind: number, n: number, rnd: () => number): Uint8Array {
  const b = new Uint8Array(n);
  const words = ["alpha ", "beta ", "\n", "0123456789", "the quick brown fox "];
  if (kind === 0) { for (let i = 0; i < n; i++) b[i] = rnd() * 256; }
  else if (kind === 1) {
    for (let i = 0; i < n;) {
      const w = words[rnd() * words.length | 0]!;
      for (let k = 0; k < w.length && i < n; k++) b[i++] = w.charCodeAt(k);
    }
  } else if (kind === 2) b.fill(65);
  else if (kind === 3) {
    for (let i = 0; i < n; i++) {
      b[i] = rnd() < 0.9 ? 32 + (rnd() * 4 | 0) : rnd() * 256;
    }
  } else {
    for (let i = 0; i < n; i++) {
      b[i] = i < 5000 || rnd() > 0.999 ? rnd() * 256 : b[i - 5000]!;
    }
  }
  return b;
}

/** Decode `frame` after the history `from`; the bytes it makes. */
function decode(frame: Uint8Array, from: Uint8Array, size: number): Uint8Array {
  const buf = new Uint8Array(from.length + size);
  buf.set(from);
  assertEquals(zstdDecodeInto(frame, buf, from.length), buf.length);
  return buf.subarray(from.length);
}

/** Deno's `zstdCompressSync` ends some outputs with a second, EMPTY frame
 *  (seen after an input its last write filled exactly). Two frames are a
 *  valid zstd file and not a patch — the decoder takes one — so the empty
 *  one is cut here, and only that exact frame. */
function oneFrame(f: Uint8Array): Uint8Array {
  const empty = [
    [0x28, 0xb5, 0x2f, 0xfd, 0x20, 0x00, 0x01, 0x00, 0x00],
    [0x28, 0xb5, 0x2f, 0xfd, 0x24, 0x00, 0x01, 0, 0, 0x99, 0xe9, 0xd8, 0x51],
  ].find((e) =>
    f.length > e.length && e.every((b, i) => f[f.length - e.length + i] === b)
  );
  return empty ? f.subarray(0, f.length - empty.length) : f;
}

// ── the decoder ─────────────────────────────────────────────────────────────

Deno.test("zstd decoder: decodes what the runtime's own zstd compresses — every block kind, every level", () => {
  const rnd = noise(7);
  const C = zlib.constants;
  let n = 0;
  for (const size of [0, 1, 5, 100, 1000, 70_000, 300_000, 1_500_000]) {
    for (let kind = 0; kind < 5; kind++) {
      for (const level of [1, 3, 9, 19, 22]) {
        if (size > 70_000 && level > 9) continue; // minutes, for nothing new
        const src = sample(kind, size, rnd);
        const frame = oneFrame(zlib.zstdCompressSync(src, {
          params: {
            [C.ZSTD_c_compressionLevel]: level,
            [C.ZSTD_c_checksumFlag]: kind & 1,
          },
        }));
        // A history the frame never points into must not disturb it.
        assertEquals(
          decode(frame, Uint8Array.of(1, 2, 3), size),
          src,
          `size ${size}, kind ${kind}, level ${level}`,
        );
        n++;
      }
    }
  }
  assert(n > 150, `only ${n} shapes were decoded`);
});

Deno.test("zstd decoder: a patch's matches reach into the history before the output", () => {
  const rnd = noise(3);
  const bytes = (n: number) =>
    Uint8Array.from({ length: n }, () => rnd() * 256);
  // [shared start, new middle, shared end, old middle]
  for (
    const [head, mid, tail, old] of [
      [0, 0, 0, 0],
      [0, 10, 0, 5],
      [5, 0, 0, 0],
      [2, 2, 2, 9],
      [40, 7, 300, 50],
      [100_000, 1, 100_001, 3],
      [250_000, 70_000, 131_074, 10],
      [100_002, 0, 35, 0],
    ] as const
  ) {
    const a = bytes(head);
    const z = bytes(tail);
    // Odd against even: the middles never share a byte with each other.
    const from = Uint8Array.from([...a, ...bytes(old).map((x) => x | 1), ...z]);
    const to = Uint8Array.from([...a, ...bytes(mid).map((x) => x & 254), ...z]);
    const patch = patchOf(from, to);
    assertEquals(decode(patch, from, to.length), to, `${[head, mid, tail]}`);
    if (head + tail > 1000) {
      assert(patch.length < mid + 200, `the patch is ${patch.length} bytes`);
    }
  }
});

Deno.test("zstd decoder: anything that is not one whole frame fitting the buffer throws", () => {
  const from = sample(1, 5000, noise(1));
  const to = Uint8Array.from([...from.subarray(0, 4000), 1, 2, 3, 4, 5]);
  const patch = patchOf(from, to);
  const run = (frame: Uint8Array, size = to.length, base = from) => {
    const buf = new Uint8Array(base.length + size);
    buf.set(base);
    return zstdDecodeInto(frame, buf, base.length);
  };
  assertEquals(run(patch), from.length + to.length);
  assertThrows(() => run(patch.subarray(0, patch.length - 1)), Error, "zstd");
  assertThrows(() => run(Uint8Array.of(...patch, 0)), Error, "follow");
  assertThrows(() => run(patch.subarray(1)), Error, "magic");
  assertThrows(() => run(new Uint8Array(0)), Error, "magic");
  // One byte short of room: refused, never written past the end.
  assertThrows(() => run(patch, to.length - 1), Error, "more than it may");
  // The history is shorter than a match reaches back.
  assertThrows(() => run(patch, to.length, from.subarray(0, 10)), Error);
  // A frame that names a trained dictionary is not a patch.
  const named = patch.slice();
  named[4] = named[4]! | 1;
  assertThrows(() => run(named), Error, "dictionary");
  // Damage anywhere either throws or makes other bytes — it never hangs and
  // never writes outside the buffer. (What it makes is the digest's to judge.)
  const rnd = noise(11);
  const real = oneFrame(zlib.zstdCompressSync(sample(1, 60_000, noise(2))));
  for (let i = 0; i < 400; i++) {
    const bent = real.slice();
    bent[rnd() * bent.length | 0]! ^= 1 << (rnd() * 8 | 0);
    try {
      zstdDecodeInto(bent, new Uint8Array(60_000), 0);
    } catch (e) {
      assert(e instanceof Error);
    }
  }
});

Deno.test({
  name:
    "zstd decoder: decodes the patches the zstd tool makes, and the tool decodes the test encoder's",
  // The tool is what `am publish --patch-from` runs; a machine without it
  // cannot make the frames this compares against.
  ignore: !hasZstd(),
  fn: async () => {
    const dir = await tempDir("aio-zstd-cli-");
    try {
      const rnd = noise(5);
      const from = sample(1, 3_000_000, rnd);
      const to = from.slice();
      // Edits all over, an insertion and a removal: what a rebuild looks like.
      for (let i = 0; i < 200; i++) to[rnd() * to.length | 0] = rnd() * 256;
      const grown = Uint8Array.from([
        ...to.subarray(0, 1_000_000),
        ...sample(0, 4321, rnd),
        ...to.subarray(1_000_000, 2_000_000),
        ...to.subarray(2_050_000),
      ]);
      await Deno.writeFile(join(dir, "from"), from);
      await Deno.writeFile(join(dir, "to"), grown);
      for (const level of ["-1", "-3", "-19"]) {
        const made = await new Deno.Command("zstd", {
          args: [level, "--patch-from=from", "to", "-o", "patch", "-f", "-q"],
          cwd: dir,
        }).output();
        assert(made.success, new TextDecoder().decode(made.stderr));
        const patch = await Deno.readFile(join(dir, "patch"));
        assert(patch.length < 60_000, `${level}: ${patch.length} bytes`);
        assertEquals(decode(patch, from, grown.length), grown, level);
      }
      await Deno.writeFile(join(dir, "mine"), patchOf(from, grown));
      const back = await new Deno.Command("zstd", {
        args: ["-d", "--long=31", "--patch-from=from", "mine", "-c"],
        cwd: dir,
      }).output();
      assert(back.success, new TextDecoder().decode(back.stderr));
      assertEquals(back.stdout, grown);
    } finally {
      await dropTempDir(dir);
    }
  },
});

// ── the manifest ────────────────────────────────────────────────────────────

const PATCH: ReleasePatch = {
  from: "b".repeat(64),
  url: "app-2.0.0.from-bbbbbbbbbbbb.zst",
  size: 77,
  sha256: "c".repeat(64),
};

async function manifest(
  o: { sign?: boolean; patches?: ReleasePatch[]; version?: string } = {},
): Promise<ShipManifest> {
  const sign = o.sign === false ? undefined : await KEYS;
  return await withPatches(
    await buildReleaseManifest({
      name: "app",
      version: o.version ?? "2.0.0",
      binary: Uint8Array.of(0x7f, 0x45, 0x4c, 0x46),
      sources: [],
      sign,
      channel: "prod",
      target: "binary",
      platform,
      url: "app-2.0.0",
      releasedAt: "2026-10-10T00:00:00.000Z",
    }),
    o.patches ?? [],
    sign?.privateKey,
  );
}
const KEYS = generateSigningKey();

Deno.test("manifest patches: the core a 1.0.19 client verifies is what it always was — patches are outside it", async () => {
  // The string below is what 1.0.19-beta's own `manifestCore` returns for this
  // manifest (taken from that tag's source). A client that old verifies its
  // signature over exactly this; a core that grew a key would lock every
  // install made before it out of every release made after.
  const m: ShipManifest = {
    manifestVersion: 3,
    name: "app",
    version: "2.0.0",
    buildNumber: 7,
    commit: "abc1234",
    sha256: "a".repeat(64),
    size: 1234,
    capabilities: {} as ShipManifest["capabilities"],
    runFlags: [],
    channel: "prod",
    target: "binary",
    platform: { os: "linux", arch: "x86_64" },
    url: "app-2.0.0",
    releasedAt: "2026-10-10T00:00:00.000Z",
    notes: "n",
    minFrom: "1.0.0",
    data: {
      schema: 1,
      cells: {
        b: { version: 2, migratesFrom: 1 },
        a: { version: 1, migratesFrom: 1 },
      },
    },
    patches: [PATCH],
    patchesSignature: "x",
  };
  assertEquals(
    manifestCore(m),
    `{"v":3,"name":"app","version":"2.0.0","sha256":"${"a".repeat(64)}",` +
      `"size":1234,"channel":"prod","target":"binary","os":"linux",` +
      `"arch":"x86_64","url":"app-2.0.0","minFrom":"1.0.0",` +
      `"data":"{\\"schema\\":1,\\"cells\\":[[\\"a\\",1,1],[\\"b\\",2,1]]}",` +
      `"notes":"n","releasedAt":"2026-10-10T00:00:00.000Z","buildNumber":7,` +
      `"commit":"abc1234"}`,
  );
  // …and a signed manifest with patches passes the claims check and the
  // manifest parser exactly as one without.
  const signed = await manifest({ patches: [PATCH] });
  const expect = { key: (await KEYS).publicKey, channel: "prod" };
  assertEquals((await verifyManifestClaims(signed, expect)).ok, true);
  assertEquals(
    parseShipManifest(JSON.stringify(signed), "test").ok,
    true,
  );
  // A patch list that is nonsense is not a broken release: the manifest
  // still parses and verifies, and simply has no usable patch.
  const odd = { ...signed, patches: "soon" } as unknown as ShipManifest;
  assertEquals(parseShipManifest(JSON.stringify(odd), "test").ok, true);
  assertEquals((await verifyManifestClaims(odd, expect)).ok, true);
  assertEquals((await usablePatches(odd)).patches, []);
});

Deno.test("manifest patches: a signed manifest's patches are used only under its key's signature over them AND the release", async () => {
  const good = await manifest({ patches: [PATCH] });
  assertEquals(await usablePatches(good), { patches: [PATCH] });
  // No patches: nothing to use, and nothing wrong.
  assertEquals(await usablePatches(await manifest()), { patches: [] });

  const refused = async (m: ShipManifest, why: string) => {
    const got = await usablePatches(m);
    assertEquals(got.patches, [], why);
    assert(got.reason, `${why}: no reason given`);
  };
  // Every field of a patch is covered.
  for (
    const edit of [
      { from: "d".repeat(64) },
      { url: "https://elsewhere.example/p.zst" },
      { size: 78 },
      { sha256: "e".repeat(64) },
    ]
  ) {
    await refused(
      { ...good, patches: [{ ...PATCH, ...edit }] },
      `edited ${Object.keys(edit)}`,
    );
  }
  await refused({ ...good, patches: [PATCH, PATCH] }, "a patch added");
  await refused({ ...good, patchesSignature: undefined }, "signature removed");
  // A list signed for ANOTHER release of the same app, moved here.
  const other = await manifest({ patches: [PATCH], version: "3.0.0" });
  assert(patchesCore(other) !== patchesCore(good));
  await refused(
    { ...good, patchesSignature: other.patchesSignature },
    "moved from another release",
  );
  // Malformed entries: refused whole, whatever signs them.
  for (
    const bad of [
      [{ ...PATCH, from: "short" }],
      [{ ...PATCH, size: 0 }],
      [{ ...PATCH, size: 1.5 }],
      [{ ...PATCH, url: "" }],
      [null],
      {},
    ]
  ) {
    await refused(
      { ...good, patches: bad as unknown as ReleasePatch[] },
      `malformed ${JSON.stringify(bad).slice(0, 40)}`,
    );
  }
  // An UNSIGNED manifest (allowUnsigned) authenticates nothing, its patches
  // included — what they make is still held to its sha256.
  const plain = await manifest({ sign: false, patches: [PATCH] });
  assertEquals(plain.patchesSignature, undefined);
  assertEquals(await usablePatches(plain), { patches: [PATCH] });
});

Deno.test("pickPatch: the patch that starts from the installed build, unless it is over half the release", () => {
  const other = { ...PATCH, from: "f".repeat(64) };
  assertEquals(pickPatch([other, PATCH], PATCH.from, 1000), { patch: PATCH });
  // A digest from PowerShell is UPPERCASE; it is the same digest.
  assertEquals(pickPatch([PATCH], PATCH.from.toUpperCase(), 1000), {
    patch: PATCH,
  });
  const none = pickPatch([other], PATCH.from, 1000);
  assert("why" in none && none.why.includes("bbbbbbbbbbbb"), String(none));
  assert("why" in pickPatch([], PATCH.from, 1000));
  // Exactly half is used; a byte over is not.
  assertEquals(pickPatch([PATCH], PATCH.from, 154), { patch: PATCH });
  const big = pickPatch([PATCH], PATCH.from, 153);
  assert("why" in big && big.why.includes("half"), String(big));
});

Deno.test("memoryShort: a patch is applied only with a quarter more memory free than it needs", () => {
  assertEquals(memoryShort(1000, 1250), null);
  assert(memoryShort(1000, 1249)?.includes("memory"));
});

Deno.test("downloadArtifact: bytes made here that are not the release are refused at the same door as a download", async () => {
  const dir = await tempDir("aio-patch-door-");
  try {
    const good = new TextEncoder().encode("the release, byte for byte");
    const wrong = good.slice();
    wrong[3] = wrong[3]! ^ 1;
    const dest = join(dir, "app.new-2.0.0");
    const door = (bytes: Uint8Array, size = good.length) =>
      downloadArtifact({
        url: "the patch p.zst",
        dest,
        expectSha256: hex(good),
        expectSize: size,
        bytes,
      });
    const bad = await door(wrong);
    assert(!bad.ok && bad.error.includes("does not match the manifest"));
    const long = await door(Uint8Array.of(...good, 0));
    assert(!long.ok && long.error.includes("more than"));
    const short = await door(good.subarray(1));
    assert(!short.ok && short.error.includes("truncated"));
    // Nothing of a refused artifact is left beside the install.
    assertEquals([...Deno.readDirSync(dir)].map((e) => e.name), []);
    const ok = await door(good);
    assertEquals(ok, { ok: true, path: dest });
    assertEquals(await Deno.readFile(dest), good);
  } finally {
    await dropTempDir(dir);
  }
});

// ── the whole path ──────────────────────────────────────────────────────────

/** A stand-in app that runs (the swap smoke-tests it), long enough that a
 *  patch between two versions is a small part of it. */
const appBody = (v: string) =>
  `#!/bin/sh\n# ${"padding ".repeat(600)}\n` +
  `if [ "$1" = "--version" ]; then echo ${v}; exit 0; fi\necho APP ${v}\n`;

type Rig = {
  root: string;
  dataDir: string;
  artifact: string;
  releases: string;
  /** Every `log.info` line of the runtime. */
  said: string[];
};

async function rig(): Promise<Rig> {
  const root = await tempDir("aio-upd-delta-");
  const dataDir = join(root, "data");
  await Deno.mkdir(dataDir);
  const artifact = join(root, "app");
  await writeProgram(artifact, appBody("1.0.0"));
  return {
    root,
    dataDir,
    artifact,
    releases: join(root, "releases"),
    said: [],
  };
}

/** Publish 2.0.0 beside its manifest, with a patch from the installed 1.0.0
 *  unless `patch` says otherwise. `full: false` leaves the whole artifact
 *  OUT of the channel: an install that succeeds then proves no whole release
 *  was downloaded. */
async function publish(r: Rig, o: {
  /** `none`: a channel from before patches. `wrong`: a well-formed, signed
   *  patch that makes other bytes of the same size. `damaged`: the file is
   *  not the one the manifest hashes. `missing`: no file. `foreign`: from
   *  another build. `huge`: over half the release. */
  patch?:
    | "good"
    | "none"
    | "wrong"
    | "damaged"
    | "missing"
    | "foreign"
    | "huge";
  full?: boolean;
  sign?: boolean;
  edit?: (m: ShipManifest) => ShipManifest;
  /** Another build of the same 2.0.0. */
  build?: string;
} = {}): Promise<Uint8Array> {
  const dir = join(r.releases, "prod");
  await Deno.mkdir(dir, { recursive: true });
  const from = await Deno.readFile(r.artifact);
  const to = await programBytes(
    appBody("2.0.0") + (o.build ? `# ${o.build}\n` : ""),
  );
  const kind = o.patch ?? "good";
  const target = kind === "wrong"
    ? to.map((b, i) => i === to.length - 1 ? b ^ 0xff : b)
    : to;
  const frame = kind === "huge"
    // With no history to match, the patch is the release sent as it is.
    ? patchOf(new Uint8Array(0), to)
    : patchOf(from, target);
  const name = "app-2.0.0.patch";
  const sign = o.sign === false ? undefined : await KEYS;
  const m = await withPatches(
    await buildReleaseManifest({
      name: "app",
      version: "2.0.0",
      binary: to,
      sources: [],
      sign,
      channel: "prod",
      target: "binary",
      platform,
      url: "app-2.0.0",
      data: { schema: 1, cells: { todos: { version: 1, migratesFrom: 1 } } },
    }),
    kind === "none" ? [] : [{
      from: kind === "foreign" ? "9".repeat(64) : hex(from),
      url: name,
      size: frame.length,
      sha256: hex(frame),
    }],
    sign?.privateKey,
  );
  if (kind !== "none" && kind !== "missing") {
    await Deno.writeFile(
      join(dir, name),
      kind === "damaged" ? frame.map((b, i) => i === 9 ? b ^ 1 : b) : frame,
    );
  }
  if (o.full !== false) await Deno.writeFile(join(dir, "app-2.0.0"), to);
  await Deno.writeTextFile(
    join(dir, `${platform.os}-${platform.arch}.json`),
    JSON.stringify(o.edit ? o.edit(m) : m),
  );
  return to;
}

function runtimeFor(r: Rig, o: { allowUnsigned?: boolean } = {}) {
  const say = (...a: unknown[]) => void r.said.push(a.map(String).join(" "));
  return createUpdatesRuntime({
    config: resolveUpdates({
      source: `file://${r.releases}`,
      channel: "prod",
      allowUnsigned: o.allowUnsigned,
    }),
    dataDir: r.dataDir,
    appVersion: "1.0.0",
    local: { schema: 1, cells: { todos: 1 } },
    exposed: false,
    log: {
      info: say,
      warn: say,
      error: say,
      debug: () => {},
    } as unknown as Log,
    argv: [],
    artifact: r.artifact,
    canInstall: ["binary"],
    exit: () => {},
    relaunch: () => {},
    shutdown: () => Promise.resolve(),
  });
}

/** Check, apply, and wait for the handover. */
async function update(r: Rig, o: { allowUnsigned?: boolean } = {}) {
  const rt = runtimeFor(r, o);
  assertEquals((await rt.check({ dismissed: null })).kind, "offer");
  await rt.apply();
  await (rt as { handover?: Promise<void> | null }).handover;
}

const patchLines = (r: Rig) => r.said.filter((l) => l.includes("patch"));

/** What an update leaves beside the install: the install, the version it
 *  replaced, and nothing else — no download folder, no patch. */
function beside(r: Rig): string[] {
  return [...Deno.readDirSync(r.root)].map((e) => e.name).filter((n) =>
    n !== "data" && n !== "releases"
  ).sort();
}

Deno.test("updates patch e2e: 1.0.0 installed + a channel with a patch → 2.0.0 installed from the patch, the whole release never fetched", async () => {
  const r = await rig();
  try {
    const old = await Deno.readFile(r.artifact);
    const to = await publish(r, { full: false });
    await update(r);
    assertEquals(await Deno.readFile(r.artifact), to);
    assertEquals(await Deno.readFile(`${r.artifact}.old-1.0.0`), old);
    assertEquals(patchLines(r).length, 1, r.said.join("\n"));
    assert(
      patchLines(r)[0]!.includes("the whole release") &&
        patchLines(r)[0]!.includes("was not downloaded"),
      patchLines(r)[0],
    );
    assertEquals(beside(r), ["app", "app.old-1.0.0"]);
    // …and nothing of the patch download stays on the record.
    assertEquals(
      readOwned(r.dataDir).filter((e) => e.path.includes(".patch-")),
      [],
    );
  } finally {
    await dropTempDir(r.root);
  }
});

// Every miss below installs the SAME 2.0.0 from the whole release, and says
// why in exactly one line.
for (
  const [name, patch, why, setup] of [
    [
      "a signed patch that makes OTHER bytes",
      "wrong",
      "does not match the manifest",
    ],
    ["a patch file that is not the one the manifest hashes", "damaged", ""],
    ["a patch the channel does not hold", "missing", ""],
    ["no patch from the installed build", "foreign", "starts from the build"],
    ["a patch over half the release", "huge", "over half"],
    [
      "too little memory free",
      "good",
      "of memory",
      () => {
        const real = _patchDeps.availableMemory;
        _patchDeps.availableMemory = () => 1000;
        return () => void (_patchDeps.availableMemory = real);
      },
    ],
  ] as [string, "good", string, (() => () => void)?][]
) {
  Deno.test(`updates patch e2e: ${name} → the whole release is downloaded, said in one line`, async () => {
    const r = await rig();
    const undo = setup?.();
    try {
      const to = await publish(r, { patch });
      await update(r);
      assertEquals(await Deno.readFile(r.artifact), to);
      assertEquals(patchLines(r).length, 1, r.said.join("\n"));
      const line = patchLines(r)[0]!;
      assert(line.includes("is not installed from a patch"), line);
      assert(line.includes("downloading the whole release"), line);
      assert(line.includes(why), line);
      assertEquals(beside(r), ["app", "app.old-1.0.0"]);
    } finally {
      undo?.();
      await dropTempDir(r.root);
    }
  });
}

// The release before patches, as it shipped: its updater is in this
// repository's history. A channel published with patches must install on it
// exactly as one without — the golden core string above says its signature
// still verifies; this runs the client.
const OLD_TAG = "v1.0.19-beta";
const REPO = fromFileUrl(new URL("..", import.meta.url)).replace(/[\\/]$/, "");
const oldTagged = (() => {
  try {
    return new Deno.Command("git", {
      args: [
        "-C",
        REPO,
        "rev-parse",
        "--verify",
        "--quiet",
        `${OLD_TAG}^{commit}`,
      ],
      stdout: "null",
      stderr: "null",
    }).outputSync().success;
  } catch {
    return false; // no git here: nothing to read the old client out of
  }
})();

Deno.test({
  name:
    "updates patch e2e: the 1.0.19-beta client itself installs 2.0.0 from a patched, signed channel — whole, with no word about patches",
  // A checkout without that tag (a shallow clone, a published package) has
  // no old client to run.
  ignore: !oldTagged,
  fn: async () => {
    const r = await rig();
    try {
      const before = await Deno.readFile(r.artifact);
      const to = await publish(r);
      const old = join(r.root, "old");
      await Deno.mkdir(old);
      const tar = await new Deno.Command("git", {
        args: ["-C", REPO, "archive", "--format=tar", OLD_TAG, "src"],
        stdout: "piped",
      }).output();
      assert(tar.success, `git archive ${OLD_TAG} failed`);
      const x = new Deno.Command("tar", {
        args: ["-x", "-C", old],
        stdin: "piped",
      })
        .spawn();
      const w = x.stdin.getWriter();
      await w.write(tar.stdout);
      await w.close();
      assert((await x.status).success, "tar -x failed");
      // The same calls `runtimeFor` and `update` make, on the old modules.
      const driver = join(r.root, "old-client.ts");
      await Deno.writeTextFile(
        driver,
        `import { createUpdatesRuntime } from "./old/src/server/updates-runtime.ts";
import { resolveUpdates } from "./old/src/server/updates-core.ts";
const [releases, dataDir, artifact] = Deno.args;
const say = (...a) => console.log("SAID " + a.map(String).join(" "));
const rt = createUpdatesRuntime({
  config: resolveUpdates({ source: "file://" + releases, channel: "prod" }),
  dataDir,
  appVersion: "1.0.0",
  local: { schema: 1, cells: { todos: 1 } },
  exposed: false,
  log: { info: say, warn: say, error: say, debug() {} },
  argv: [],
  artifact,
  canInstall: ["binary"],
  exit() {},
  relaunch() {},
  shutdown: () => Promise.resolve(),
});
console.log("CHECK " + (await rt.check({ dismissed: null })).kind);
await rt.apply();
await rt.handover;
console.log("DONE");
`,
      );
      const ran = await new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "-A",
          `--config=${join(REPO, "deno.json")}`,
          driver,
          r.releases,
          r.dataDir,
          r.artifact,
        ],
        stdout: "piped",
        stderr: "piped",
      }).output();
      const out = new TextDecoder().decode(ran.stdout) +
        new TextDecoder().decode(ran.stderr);
      assert(ran.success, out);
      assert(out.includes("CHECK offer") && out.includes("DONE"), out);
      assertEquals(await Deno.readFile(r.artifact), to);
      assertEquals(await Deno.readFile(`${r.artifact}.old-1.0.0`), before);
      assertEquals(out.split("\n").filter((l) => /patch/i.test(l)), []);
      // It did verify a signature: the key it pinned is this channel's.
      assert(out.includes("verified 2.0.0"), out);
    } finally {
      await dropTempDir(r.root);
    }
  },
});

Deno.test("updates patch e2e: a channel published before patches existed installs as it always did, with no word about patches", async () => {
  const r = await rig();
  try {
    const to = await publish(r, { patch: "none" });
    await update(r);
    assertEquals(await Deno.readFile(r.artifact), to);
    assertEquals(patchLines(r), []);
  } finally {
    await dropTempDir(r.root);
  }
});

Deno.test("updates patch e2e: a patch list edited after signing is not used — the release still installs, whole", async () => {
  const r = await rig();
  try {
    // The edit an attacker on the channel would make: point the patch at a
    // host of theirs. The list no longer verifies, so nothing is fetched
    // from it. (The whole artifact is there: the install succeeds.)
    const to = await publish(r, {
      edit: (m) => ({
        ...m,
        patches: m.patches!.map((p) => ({ ...p, url: `./${p.url}` })),
      }),
    });
    await update(r);
    assertEquals(await Deno.readFile(r.artifact), to);
    assertEquals(patchLines(r).length, 1, r.said.join("\n"));
    assert(patchLines(r)[0]!.includes("not signed by its key"));
  } finally {
    await dropTempDir(r.root);
  }
});

Deno.test("updates patch e2e: an unsigned channel's patch is used too — held to the manifest's digest like the release itself", async () => {
  const r = await rig();
  try {
    const to = await publish(r, { sign: false, full: false });
    await update(r, { allowUnsigned: true });
    assertEquals(await Deno.readFile(r.artifact), to);
  } finally {
    await dropTempDir(r.root);
  }
});

Deno.test({
  name:
    "updates e2e: a single-file release whose swap failed is not fetched again by the next try in this run",
  // The failing swap is injected into the COPY the POSIX strategy makes of
  // the running file; Windows renames the running file instead, and nothing
  // short of another process holding it makes that rename fail.
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const r = await rig();
    const real = _swapDeps.copyFile;
    try {
      const to = await publish(r, { patch: "none" });
      const rt = runtimeFor(r);
      assertEquals((await rt.check({ dismissed: null })).kind, "offer");
      _swapDeps.copyFile = () => Promise.reject(new Error("disk says no"));
      await assertRejects(() => rt.apply(), Error, "disk says no");
      _swapDeps.copyFile = real;
      // The running version is untouched, and the verified download is still
      // there, on the updater's record.
      assertEquals(
        await Deno.readFile(r.artifact),
        await programBytes(appBody("1.0.0")),
      );
      assertEquals(beside(r), ["app", "app.new-2.0.0"]);
      assert(isOwn(r.dataDir, `${r.artifact}.new-2.0.0`));
      // The channel loses the artifact: only what was kept can install now.
      await Deno.remove(join(r.releases, "prod", "app-2.0.0"));
      r.said.length = 0;
      await rt.apply();
      await (rt as { handover?: Promise<void> | null }).handover;
      assertEquals(await Deno.readFile(r.artifact), to);
      assert(
        r.said.some((l) => l.includes("is not downloaded again")),
        r.said.join("\n"),
      );
      assertEquals(beside(r), ["app", "app.old-1.0.0"]);
    } finally {
      _swapDeps.copyFile = real;
      await dropTempDir(r.root);
    }
  },
});

Deno.test({
  name:
    "updates e2e: a kept single-file download that no longer verifies is thrown away and fetched again",
  ignore: Deno.build.os === "windows", // as above: the injected failing copy
  fn: async () => {
    const r = await rig();
    const real = _swapDeps.copyFile;
    try {
      const to = await publish(r, { patch: "none" });
      const rt = runtimeFor(r);
      assertEquals((await rt.check({ dismissed: null })).kind, "offer");
      _swapDeps.copyFile = () => Promise.reject(new Error("disk says no"));
      await assertRejects(() => rt.apply(), Error, "disk says no");
      _swapDeps.copyFile = real;
      // 2.0.0 is published again as another build: what was kept is the
      // updater's own file, and no longer the release.
      const again = await publish(r, { patch: "none", build: "second" });
      assert(again.length !== to.length || again.some((b, i) => b !== to[i]));
      assertEquals((await rt.check({ dismissed: null })).kind, "offer");
      r.said.length = 0;
      await rt.apply();
      await (rt as { handover?: Promise<void> | null }).handover;
      assertEquals(await Deno.readFile(r.artifact), again);
      assert(r.said.some((l) => l.includes("downloading app 2.0.0")));
    } finally {
      _swapDeps.copyFile = real;
      await dropTempDir(r.root);
    }
  },
});

/** A start of 1.0.0 from the rig's install with no update in flight — what
 *  removes the leftovers of unfinished updates. */
function restart(r: Rig): void {
  const say = (_c: string, m: string) => void r.said.push(m);
  // Another run of the app: what THIS run recorded is never a leftover to it
  // (somebody is working on it), whatever else holds.
  const rec = JSON.parse(Deno.readTextFileSync(ownedPath(r.dataDir)));
  for (const e of rec.made) e.boot = "an earlier run";
  Deno.writeTextFileSync(ownedPath(r.dataDir), JSON.stringify(rec));
  const slot = {
    runtime: null,
    cell: { ready() {} },
  } as unknown as UpdatesSlot;
  const started = startUpdates({
    updates: {
      source: `file://${r.releases}`,
      check: false,
      canApply: () => true,
    },
    dataDir: r.dataDir,
    appName: "app",
    appVersion: "1.0.0",
    local: { schema: 1, cells: { todos: 1 } },
    exposed: false,
    log: { info: say, warn: say, error: say, debug() {} } as unknown as Log,
    argv: [],
    slot,
    artifact: r.artifact,
    installDir: null,
  });
  // …up to the cells being bound: what is dismissed at a start is said there.
  beginUpdates(slot);
  started.stop();
}

Deno.test({
  name:
    "updates e2e: a single-file release whose swap failed is not fetched again after a restart either — up to MAX_FAILED_SWAPS failures",
  ignore: Deno.build.os === "windows", // as above: the injected failing copy
  fn: async () => {
    const r = await rig();
    const real = _swapDeps.copyFile;
    const kept = `${r.artifact}.new-2.0.0`;
    try {
      const to = await publish(r, { patch: "none" });
      const rt = runtimeFor(r);
      assertEquals((await rt.check({ dismissed: null })).kind, "offer");
      _swapDeps.copyFile = () => Promise.reject(new Error("disk says no"));
      await assertRejects(() => rt.apply(), Error, "disk says no");
      assertEquals(readTrust(r.dataDir).failedSwaps, { to: "2.0.0", count: 1 });
      await assertRejects(() => rt.apply(), Error, "disk says no");
      assertEquals(readTrust(r.dataDir).failedSwaps, { to: "2.0.0", count: 2 });
      _swapDeps.copyFile = real;

      // The app is started again: the download is still on offer, so it is
      // not the leftover a start removes.
      restart(r);
      assertEquals(beside(r), ["app", "app.new-2.0.0"]);
      assert(isOwn(r.dataDir, kept));

      // One failure more is the last one counted: the next start removes it,
      // as it removes every leftover.
      const again = runtimeFor(r);
      assertEquals((await again.check({ dismissed: null })).kind, "offer");
      _swapDeps.copyFile = () => Promise.reject(new Error("disk says no"));
      await assertRejects(() => again.apply(), Error, "disk says no");
      _swapDeps.copyFile = real;
      assertEquals(readTrust(r.dataDir).failedSwaps?.count, MAX_FAILED_SWAPS);
      assertEquals(
        r.said.filter((l) => l.includes("downloading app 2.0.0")).length,
        1,
        r.said.join("\n"),
      );
      // …and that start gives the release up, as a directory's record does.
      restart(r);
      assert(
        r.said.some((l) =>
          l.startsWith("not installing 2.0.0 again") && l.includes("Dismissed")
        ),
        r.said.join("\n"),
      );
      const deadline = Date.now() + 5000;
      while (beside(r).length > 1) {
        assert(Date.now() < deadline, `never removed: ${beside(r)}`);
        await new Promise((done) => setTimeout(done, 10));
      }
      assertEquals(beside(r), ["app"]);

      // …and a try after that (`undismiss()`) downloads the release, and
      // installs it.
      const last = runtimeFor(r);
      assertEquals((await last.check({ dismissed: null })).kind, "offer");
      await last.apply();
      await (last as { handover?: Promise<void> | null }).handover;
      assertEquals(await Deno.readFile(r.artifact), to);
    } finally {
      _swapDeps.copyFile = real;
      await dropTempDir(r.root);
    }
  },
});

Deno.test("applyPatch: the bytes a patch makes from a file; a patch that makes another size throws", async () => {
  const dir = await tempDir("aio-apply-patch-");
  try {
    const from = sample(1, 400_000, noise(9));
    const to = Uint8Array.from([...from.subarray(0, 300_000), 7, 7, 7]);
    await Deno.writeFile(join(dir, "from"), from);
    const patch = patchOf(from, to);
    assertEquals(await applyPatch(join(dir, "from"), patch, to.length), to);
    let threw = "";
    try {
      await applyPatch(join(dir, "from"), patch, to.length + 1);
    } catch (e) {
      threw = String(e);
    }
    assert(threw.includes(`not ${to.length + 1}`), threw);
  } finally {
    await dropTempDir(dir);
  }
});

// ── the publisher ───────────────────────────────────────────────────────────

Deno.test({
  name:
    "am publish --patch-from: a patch per earlier release, made before that release is overwritten; an install applies it",
  ignore: !hasZstd(), // `--patch-from` runs the zstd tool
  fn: async () => {
    const dir = await tempDir("aio-make-patches-");
    try {
      const name = `${platform.os}-${platform.arch}.json`;
      const rnd = noise(4);
      const v1 = sample(1, 600_000, rnd);
      const v2 = v1.slice();
      for (let i = 0; i < 50; i++) v2[rnd() * v2.length | 0] = rnd() * 256;
      // The earlier release, laid out as `am publish --dir=release` left it.
      const release = join(dir, "release");
      await Deno.mkdir(join(release, "prod"), { recursive: true });
      await Deno.writeFile(join(release, "prod", "app"), v1);
      await Deno.writeTextFile(
        join(release, "prod", name),
        JSON.stringify({
          version: "1.0.0",
          sha256: hex(v1),
          url: "app",
          target: "binary",
        }),
      );
      await Deno.mkdir(join(dir, "dist"));
      const file = join(dir, "dist", "app");
      await Deno.writeFile(file, v2);
      const make = (dirs: string[], manifestName = name) =>
        makePatches({
          dirs,
          channel: "prod",
          manifestName,
          file,
          // Into the very directory the earlier release is in.
          into: join(release, "prod"),
        });
      // The channel directory and its parent both name the release.
      const made = await make([release, join(release, "prod")]);
      assertEquals(made.patches.length, 1, "the same release, given twice");
      const p = made.patches[0]!;
      assertEquals(p.from, hex(v1));
      const patch = await Deno.readFile(join(release, "prod", p.url));
      assertEquals([p.size, p.sha256], [patch.length, hex(patch)]);
      assert(p.size < 20_000, `the patch is ${p.size} bytes`);
      assertEquals(decode(patch, v1, v2.length), v2);
      assert(made.notes[0]!.includes("from 1.0.0"), made.notes[0]);

      // The same build published again: nothing to patch.
      await Deno.writeFile(file, v1);
      assertEquals((await make([release])).patches, []);
      // Nothing in common: the patch would be most of the release — not
      // published, and said.
      await Deno.writeFile(file, sample(0, 600_000, rnd));
      const far = await make([release]);
      assertEquals(far.patches, []);
      assert(far.notes[0]!.includes("over half"), far.notes[0]);
      assertEquals(
        [...Deno.readDirSync(join(release, "prod"))].map((e) => e.name).sort(),
        [p.url, "app", name].sort(),
      );
      // A directory that holds no such release, and one whose artifact is
      // not the file its manifest names: refused, by name.
      await Deno.writeFile(file, v2);
      const refuses = async (dirs: string[], why: string, as?: string) => {
        let threw = "";
        try {
          await make(dirs, as);
        } catch (e) {
          threw = String(e);
        }
        assert(threw.includes(why), threw || "nothing was thrown");
      };
      await refuses([join(dir, "dist")], "no " + name);
      await Deno.writeFile(join(release, "prod", "app"), v2);
      await refuses([release], "is not that file");
      // An install that is an unpacked folder has nothing to patch.
      await Deno.writeTextFile(
        join(release, "prod", "zip.json"),
        JSON.stringify({ sha256: hex(v1), url: "app", target: "electron-zip" }),
      );
      const zip = await make([release], "zip.json");
      assertEquals(zip.patches, []);
      assert(zip.notes[0]!.includes("downloads every release whole"));
    } finally {
      await dropTempDir(dir);
    }
  },
});
