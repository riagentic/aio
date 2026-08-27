// The IO half of updates, adversarially.
//
// Everything here is a REFUSAL: a trust file that cannot be read, a body that
// is not a manifest, a host that sends more than it promised, an artifact on
// somebody else's host, a symlink planted where the staged file goes. The rule
// this file pins is that each one produces a sentence naming the cause and the
// fix — never a TypeError from three layers down, and never a silent skip that
// leaves the app believing it is protected.
import { assert, assertEquals, assertMatch, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { sha256Hex } from "../src/build/ship.ts";
import {
  downloadArtifact,
  ensureWritable,
  fetchManifest,
  fileSha256,
  gitLsRemote,
  parseShipManifest,
  pinKey,
  readTrust,
  recordInstalledSha256,
  transportAuthenticatesHost,
  trustPath,
  writeTrust,
} from "../src/server/updates-check.ts";
import { freePort } from "../src/testing/server-test.ts";

const KEY: JsonWebKey = { kty: "OKP", crv: "Ed25519", x: "abc" };

async function tmp(prefix: string): Promise<string> {
  return await Deno.makeTempDir({ prefix: `aio-upd-${prefix}-` });
}

/** A well-formed manifest, as a plain object, so a table test can break one
 *  field at a time. Not built through `buildShipManifest`: the point is the
 *  shapes that never came from `aio ship` in the first place. */
function goodManifest(over: Record<string, unknown> = {}) {
  return {
    manifestVersion: 3,
    name: "app",
    version: "2.0.0",
    sha256: "a".repeat(64),
    size: 10,
    capabilities: {},
    runFlags: [],
    channel: "prod",
    target: "binary",
    platform: { os: "linux", arch: "x86_64" },
    releasedAt: "2026-01-01T00:00:00.000Z",
    url: "app-2.0.0",
    ...over,
  };
}

// ── the trust store ─────────────────────────────────────────────────────────

Deno.test("updates: a missing trust file is a normal answer", async () => {
  const dir = await tmp("trust");
  assertEquals(readTrust(dir), {});
});

Deno.test("updates: a CORRUPT trust file throws — it never fails open", async () => {
  const dir = await tmp("trust");
  // The failure that matters: a truncated write. Under the old `catch {}` this
  // silently dropped the pinned key and re-entered trust-on-first-use, so the
  // next host to answer got to choose the key for every future release.
  await Deno.writeTextFile(trustPath(dir), `{"key":{"kty":"OKP","x":"ab`);
  const e = assertThrows(() => readTrust(dir), Error);
  assertMatch(e.message, /update trust file/);
  assertMatch(e.message, new RegExp(trustPath(dir).replace(/[.*+?]/g, "\\$&")));
  assertMatch(e.message, /delete it/, "the fix is named");
});

Deno.test("updates: a trust file that is not an object throws", async () => {
  const dir = await tmp("trust");
  await Deno.writeTextFile(trustPath(dir), `[1,2,3]`);
  assertMatch(
    assertThrows(() => readTrust(dir), Error).message,
    /not an object \(got an array\)/,
  );
});

Deno.test("updates: a valid trust file round-trips, installedSha256 included", async () => {
  const dir = await tmp("trust");
  writeTrust(dir, { channel: "test" });
  recordInstalledSha256(dir, "b".repeat(64));
  const t = readTrust(dir);
  assertEquals(t.channel, "test");
  assertEquals(t.installedSha256, "b".repeat(64));
});

// ── which transports may pin a key ──────────────────────────────────────────

Deno.test("updates: only a transport that authenticates the host may pin", () => {
  const table: [string, boolean][] = [
    ["https://example.com/prod/linux-x86_64.json", true],
    ["file:///srv/releases/prod/linux-x86_64.json", true],
    ["http://127.0.0.1:8000/prod/x.json", true], // never leaves the machine
    ["http://localhost:8000/prod/x.json", true],
    ["http://[::1]:8000/prod/x.json", true],
    ["http://releases.example.com/prod/x.json", false],
    ["http://192.168.1.9/prod/x.json", false],
    ["ftp://example.com/x.json", false],
    ["not a url", false],
  ];
  for (const [url, expected] of table) {
    assertEquals(transportAuthenticatesHost(url), expected, url);
  }
});

Deno.test("updates: TOFU over plain http is refused, naming all three fixes", async () => {
  const dir = await tmp("pin");
  const e = assertThrows(
    () => pinKey(dir, KEY, "http://releases.example.com/prod/x.json"),
    Error,
  );
  assertMatch(e.message, /unauthenticated transport/);
  assertMatch(e.message, /https/);
  assertMatch(e.message, /key/);
  assertMatch(e.message, /allowUnsigned/);
  assertEquals(readTrust(dir).key, undefined, "nothing was written");
});

Deno.test("updates: TOFU over https pins", async () => {
  const dir = await tmp("pin");
  pinKey(dir, KEY, "https://example.com/prod/x.json");
  assertEquals(readTrust(dir).key?.x, "abc");
});

// ── the manifest is parsed, never cast ──────────────────────────────────────

Deno.test("updates: every malformed manifest is a named refusal, never a throw", () => {
  const table: [string, string, RegExp][] = [
    [
      "not JSON at all",
      "<html>login</html>",
      /did not return a release manifest/,
    ],
    ["a JSON string", `"hello"`, /it is string, not an object/],
    ["null", `null`, /it is null, not an object/],
    ["an array", `[]`, /it is an array/],
    ["empty object", `{}`, /`manifestVersion` is missing/],
    [
      "no platform",
      JSON.stringify(goodManifest({ platform: undefined })),
      /`platform` is missing/,
    ],
    [
      "platform without arch",
      JSON.stringify(goodManifest({ platform: { os: "linux" } })),
      /`platform` has no `os`\/`arch` pair/,
    ],
    [
      "no version",
      JSON.stringify(goodManifest({ version: undefined })),
      /`version` is missing/,
    ],
    [
      "version is a number",
      JSON.stringify(goodManifest({ version: 2 })),
      /`version` is number/,
    ],
    [
      "digest is not a digest",
      JSON.stringify(goodManifest({ sha256: "deadbeef" })),
      /`sha256` is not a 64-character hex digest/,
    ],
    [
      "size is a string",
      JSON.stringify(goodManifest({ size: "10" })),
      /`size` is not a byte count/,
    ],
    [
      "size is negative",
      JSON.stringify(goodManifest({ size: -1 })),
      /`size` is not a byte count/,
    ],
    [
      "no channel",
      JSON.stringify(goodManifest({ channel: undefined })),
      /`channel` is missing/,
    ],
    [
      "no target",
      JSON.stringify(goodManifest({ target: undefined })),
      /`target` is missing/,
    ],
    [
      "notes is an object",
      JSON.stringify(goodManifest({ notes: { a: 1 } })),
      /`notes` is object/,
    ],
  ];
  for (const [label, text, expected] of table) {
    const got = parseShipManifest(text, "https://h/x.json");
    assertEquals(got.ok, false, label);
    assert(!got.ok);
    assertMatch(got.error, expected, label);
  }
});

Deno.test("updates: a well-formed manifest parses", () => {
  const got = parseShipManifest(JSON.stringify(goodManifest()), "https://h/x");
  assert(got.ok);
  assertEquals(got.manifest.version, "2.0.0");
});

// ── fetching, against a real host ───────────────────────────────────────────

/** A host that serves exactly what a test tells it to. */
function host(handler: (req: Request) => Response | Promise<Response>) {
  const port = freePort();
  const server = Deno.serve(
    { port, hostname: "127.0.0.1", onListen: () => {} },
    handler,
  );
  return {
    base: `http://127.0.0.1:${port}`,
    stop: () => server.shutdown(),
  };
}

Deno.test("updates: an HTML error page is refused by name, not by TypeError", async () => {
  const h = host(() =>
    new Response("<!doctype html><title>Sign in</title>", {
      headers: { "content-type": "text/html" },
    })
  );
  try {
    const got = await fetchManifest(`${h.base}/prod/x.json`);
    assertEquals(got.kind, "error");
    assert(got.kind === "error");
    assertMatch(got.error, /did not return a release manifest/);
  } finally {
    await h.stop();
  }
});

Deno.test("updates: a manifest missing a field names the field", async () => {
  const h = host(() => Response.json(goodManifest({ platform: undefined })));
  try {
    const got = await fetchManifest(`${h.base}/prod/x.json`);
    assert(got.kind === "error");
    assertMatch(got.error, /`platform` is missing/);
    assertMatch(got.error, /aio ship/, "the fix is named");
  } finally {
    await h.stop();
  }
});

Deno.test("updates: a manifest that DECLARES more than the cap is never read", async () => {
  let read = false;
  const big = new Uint8Array(2_000_000).fill(32);
  const h = host(() => {
    read = true;
    return new Response(big.buffer as ArrayBuffer, {
      headers: { "content-type": "application/json" },
    });
  });
  try {
    const got = await fetchManifest(`${h.base}/prod/x.json`);
    assert(got.kind === "error");
    assertMatch(got.error, /declared 2000000 bytes/);
    assertMatch(got.error, /refusing to download it/);
    assert(read, "the request happened; only the body was refused");
  } finally {
    await h.stop();
  }
});

Deno.test("updates: a manifest body over the cap is refused, not buffered", async () => {
  let sent = 0;
  const chunk = new Uint8Array(64 * 1024).fill(32); // spaces: valid JSON lead-in
  const h = host(() =>
    new Response(
      new ReadableStream({
        pull(c) {
          sent += chunk.length;
          if (sent > 64 * 1024 * 1024) return c.close();
          c.enqueue(chunk.slice());
        },
        cancel() {},
      }),
      { headers: { "content-type": "application/json" } },
    )
  );
  try {
    const got = await fetchManifest(`${h.base}/prod/x.json`);
    assert(got.kind === "error");
    assertMatch(got.error, /more than 1000000 bytes/);
    assert(
      sent < 16 * 1024 * 1024,
      `the read stopped early — the host only got to send ${sent} bytes`,
    );
  } finally {
    await h.stop();
  }
});

Deno.test("updates: an artifact on ANOTHER host is refused, naming it", async () => {
  const h = host(() =>
    Response.json(goodManifest({ url: "https://cdn.evil.example/app" }))
  );
  try {
    const got = await fetchManifest(`${h.base}/prod/x.json`);
    assert(got.kind === "error");
    assertMatch(got.error, /different host/);
    assertMatch(got.error, /cdn\.evil\.example/);
    assertMatch(got.error, /allowCrossOrigin/, "the opt-in is named");
  } finally {
    await h.stop();
  }
});

Deno.test("updates: a cross-origin artifact is allowed when the app opts in", async () => {
  const h = host(() =>
    Response.json(goodManifest({ url: "https://cdn.example/app" }))
  );
  try {
    const got = await fetchManifest(`${h.base}/prod/x.json`, undefined, {
      allowCrossOrigin: true,
    });
    assertEquals(got.kind, "ok");
  } finally {
    await h.stop();
  }
});

Deno.test("updates: a relative artifact url is same-origin, and loopback is pinnable", async () => {
  const h = host(() => Response.json(goodManifest()));
  try {
    const got = await fetchManifest(`${h.base}/prod/x.json`);
    assert(got.kind === "ok");
    assertEquals(got.manifest.version, "2.0.0");
    assertEquals(got.pinnable, true, "loopback http never leaves the machine");
  } finally {
    await h.stop();
  }
});

// ── downloading ─────────────────────────────────────────────────────────────

const BODY = new TextEncoder().encode("ARTIFACT-BYTES-".repeat(1000));

function artifactHost(bytes: Uint8Array = BODY) {
  return host(() => new Response(bytes.buffer as ArrayBuffer));
}

Deno.test("updates: a good download lands at dest, verified", async () => {
  const dir = await tmp("dl");
  const h = artifactHost();
  try {
    const got = await downloadArtifact({
      url: `${h.base}/app`,
      dest: join(dir, "app.new-2.0.0"),
      expectSha256: await sha256Hex(BODY),
      expectSize: BODY.length,
    });
    assert(got.ok, got.ok ? "" : got.error);
    assertEquals(
      (await Deno.readFile(join(dir, "app.new-2.0.0"))).length,
      BODY.length,
    );
    // Nothing staged is left behind.
    const left = [...Deno.readDirSync(dir)].map((e) => e.name).sort();
    assertEquals(left, ["app.new-2.0.0"]);
  } finally {
    await h.stop();
  }
});

Deno.test("updates: a manifest with no size is refused — nothing bounds the write", async () => {
  const dir = await tmp("dl");
  const got = await downloadArtifact({
    url: "http://127.0.0.1:1/app",
    dest: join(dir, "app.new"),
    expectSha256: "a".repeat(64),
    expectSize: 0,
  });
  assert(!got.ok);
  assertMatch(got.error, /states no size/);
  assertMatch(got.error, /aio ship/);
});

Deno.test("updates: a host sending more than it promised is aborted mid-stream", async () => {
  const dir = await tmp("dl");
  let sent = 0;
  const chunk = new Uint8Array(64 * 1024).fill(65);
  const h = host(() =>
    new Response(
      new ReadableStream({
        pull(c) {
          sent += chunk.length;
          if (sent > 64 * 1024 * 1024) return c.close();
          c.enqueue(chunk.slice());
        },
        cancel() {},
      }),
    )
  );
  try {
    const got = await downloadArtifact({
      url: `${h.base}/app`,
      dest: join(dir, "app.new"),
      expectSha256: "a".repeat(64),
      expectSize: 256 * 1024,
    });
    assert(!got.ok);
    assertMatch(got.error, /sending more than/);
    // The whole point: the client stops at the promised size instead of
    // hashing and buffering whatever arrives. 64 MB was on offer.
    assert(sent < 8 * 1024 * 1024, `host got to send ${sent} bytes`);
    assertEquals([...Deno.readDirSync(dir)].length, 0, "nothing left staged");
  } finally {
    await h.stop();
  }
});

Deno.test("updates: a truncated artifact is refused", async () => {
  const dir = await tmp("dl");
  const h = artifactHost();
  try {
    const got = await downloadArtifact({
      url: `${h.base}/app`,
      dest: join(dir, "app.new"),
      expectSha256: await sha256Hex(BODY),
      expectSize: BODY.length + 500,
    });
    assert(!got.ok);
    assertMatch(got.error, /does not match the manifest/);
    assertMatch(got.error, /truncated artifact is never installed/);
    assertEquals([...Deno.readDirSync(dir)].length, 0);
  } finally {
    await h.stop();
  }
});

Deno.test("updates: a digest mismatch is refused and staged bytes are removed", async () => {
  const dir = await tmp("dl");
  const h = artifactHost();
  try {
    const got = await downloadArtifact({
      url: `${h.base}/app`,
      dest: join(dir, "app.new"),
      expectSha256: "c".repeat(64),
      expectSize: BODY.length,
    });
    assert(!got.ok);
    assertMatch(got.error, /does not match the manifest/);
    assertEquals([...Deno.readDirSync(dir)].length, 0);
  } finally {
    await h.stop();
  }
});

Deno.test("updates: a symlink planted at the staged path is replaced, never followed", async () => {
  const dir = await tmp("dl");
  const victim = join(dir, "victim");
  await Deno.writeTextFile(victim, "DO NOT OVERWRITE");
  const dest = join(dir, "app.new-2.0.0");
  await Deno.symlink(victim, dest);
  const h = artifactHost();
  try {
    const got = await downloadArtifact({
      url: `${h.base}/app`,
      dest,
      expectSha256: await sha256Hex(BODY),
      expectSize: BODY.length,
    });
    assert(got.ok, got.ok ? "" : got.error);
    assertEquals(await Deno.readTextFile(victim), "DO NOT OVERWRITE");
    assertEquals((await Deno.lstat(dest)).isSymlink, false);
    assertEquals((await Deno.readFile(dest)).length, BODY.length);
  } finally {
    await h.stop();
  }
});

Deno.test("updates: an artifact on another host is refused before a byte is read", async () => {
  const dir = await tmp("dl");
  const got = await downloadArtifact({
    url: "https://cdn.evil.example/app",
    dest: join(dir, "app.new"),
    expectSha256: "a".repeat(64),
    expectSize: 10,
    manifestUrl: "https://releases.example.com/prod/linux-x86_64.json",
  });
  assert(!got.ok);
  assertMatch(got.error, /different host/);
  assertEquals([...Deno.readDirSync(dir)].length, 0);
});

Deno.test("updates: keepStaged leaves the file in the 0700 staging dir", async () => {
  const dir = await tmp("dl");
  const h = artifactHost();
  try {
    const got = await downloadArtifact({
      url: `${h.base}/app`,
      dest: join(dir, "app.new"),
      expectSha256: await sha256Hex(BODY),
      expectSize: BODY.length,
      keepStaged: true,
    });
    assert(got.ok, got.ok ? "" : got.error);
    assert(got.path.includes(".aio-update-"), got.path);
    assertEquals((await Deno.readFile(got.path)).length, BODY.length);
    if (Deno.build.os !== "windows") {
      const mode = (await Deno.stat(join(got.path, ".."))).mode ?? 0;
      assertEquals(mode & 0o777, 0o700, "no other user may read a staged app");
    }
  } finally {
    await h.stop();
  }
});

Deno.test("updates: an unwritable install dir is named before anything downloads", async () => {
  const dir = await tmp("dl");
  const got = await downloadArtifact({
    url: "http://127.0.0.1:1/app",
    dest: join(dir, "no-such-dir", "app.new"),
    expectSha256: "a".repeat(64),
    expectSize: 10,
  });
  assert(!got.ok);
  assertMatch(got.error, /cannot stage an update in/);
});

Deno.test("updates: ensureWritable says which fix applies", async () => {
  const dir = await tmp("w");
  assertEquals((await ensureWritable(dir)).ok, true);

  const missing = await ensureWritable(join(dir, "nope"));
  assert(!missing.ok);
  assertMatch(missing.error, /does not exist/);

  // Root ignores the mode bits, so this half of the check only means anything
  // as a normal user — and running the suite as root is not the common case.
  if (Deno.build.os !== "windows" && Deno.uid() !== 0) {
    const ro = join(dir, "ro");
    await Deno.mkdir(ro, { mode: 0o500 });
    const got = await ensureWritable(ro);
    assert(!got.ok);
    assertMatch(got.error, /run as the user who owns/);
  }
});

Deno.test("updates: fileSha256 streams to the same answer as a whole-buffer hash", async () => {
  const dir = await tmp("sha");
  const p = join(dir, "big");
  await Deno.writeFile(p, BODY);
  assertEquals(await fileSha256(p), await sha256Hex(BODY));
});

// ── git sources ─────────────────────────────────────────────────────────────

async function git(cwd: string, ...args: string[]) {
  const out = await new Deno.Command("git", {
    args,
    cwd,
    stdout: "null",
    stderr: "null",
    env: {
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@e",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@e",
    },
  }).output();
  assert(out.success, args.join(" "));
}

Deno.test("updates: an ANNOTATED tag resolves to the commit, so it converges", async () => {
  const dir = await tmp("git");
  await git(dir, "init", "-q", "-b", "main");
  await git(dir, "commit", "-q", "--allow-empty", "-m", "one");
  await git(dir, "tag", "-a", "v1.0.0", "-m", "release");

  const head = await new Deno.Command("git", {
    args: ["rev-parse", "HEAD"],
    cwd: dir,
    stdout: "piped",
  }).output();
  const commit = new TextDecoder().decode(head.stdout).trim();

  const got = await gitLsRemote(dir, "v1.0.0");
  assert(got.ok, got.ok ? "" : got.error);
  // The tag OBJECT's sha is what `ls-remote v1.0.0` alone returns; a rebuild
  // records the commit. Returning the tag object made the same tag look new on
  // every single check, forever.
  assertEquals(got.head.sha, commit);
});

Deno.test("updates: a ref that looks like an option is a positional, not a command", async () => {
  const dir = await tmp("git");
  await git(dir, "init", "-q", "-b", "main");
  await git(dir, "commit", "-q", "--allow-empty", "-m", "one");
  const marker = join(dir, "PWNED");
  const got = await gitLsRemote(
    dir,
    `--upload-pack=touch ${marker}`,
  );
  assertEquals(got.ok, false, "an option-shaped ref finds no ref");
  assertEquals(
    await Deno.stat(marker).then(() => true).catch(() => false),
    false,
    "and it certainly does not run",
  );
});
