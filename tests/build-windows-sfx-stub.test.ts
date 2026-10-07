// The committed Windows SFX stub PE is copied into every user's one-click
// `.exe`, so it is pinned: its bytes are the build of the committed source
// (SHA-256 checked before every use), it carries nothing of the machine that
// built it, and the format constants the Rust stub and the Deno packer share
// are compared here — changing one side alone used to leave every test green.
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { fromFileUrl, join, toFileUrl } from "@std/path";
import { existsSync } from "node:fs";
import {
  ensureWindowsSfxStub,
  prebuiltStubPath,
  SFX_MAGIC,
  SFX_STUB_SHA256,
  SFX_STUB_SOURCE_SHA256,
  windowsSfxStubDir,
} from "../src/build/build-windows-exe.ts";
import {
  SFX_STAMP_FILE,
  SFX_VERSION_FILE,
} from "../src/server/updates-apply.ts";
import {
  compareVersions,
  isComparableVersion,
} from "../src/server/updates-core.ts";
import { sha256Hex } from "../src/build/ship.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { toolCacheDir } from "../src/electron/electron-runtime-fetch.ts";

/** The toolchain the committed PE was built with (README.md pins the same). */
const PINNED_RUSTC = "rustc 1.98.0";
const TARGET = "x86_64-pc-windows-gnu";
/** Flags the README's build command passes besides the two machine-local ones
 *  (the mingw-w64 library folders and the path remaps). */
const LINK_FLAGS = [
  "-Clinker=rust-lld",
  "-Clink-self-contained=yes",
  "-Clink-arg=--no-insert-timestamp",
];

const STUB_DIR = windowsSfxStubDir();
/** Cargo's build folder: a cache outside the checkout, so a test run leaves
 *  nothing in the source tree and the next one does not compile from zero. */
const TARGET_DIR = join(toolCacheDir(), "windows-sfx-stub-target");

function tryRun(cmd: string, args: string[]): string | null {
  try {
    const out = new Deno.Command(cmd, { args, stderr: "null" }).outputSync();
    return out.success ? new TextDecoder().decode(out.stdout).trim() : null;
  } catch {
    return null; // aio-ok: no such tool on PATH — the tests that need it say so (ignored)
  }
}

/** `rustc --version` of the toolchain on PATH, or null without one. */
const rustcVersion = tryRun("rustc", ["--version"]);

/** The two mingw-w64 library folders of the README, when both are there. */
const mingwLibs = (() => {
  const usr = Deno.env.get("AIO_SFX_MINGW") || "/usr";
  const dirs = [
    join(usr, "x86_64-w64-mingw32", "lib"),
    join(usr, "lib", "gcc", "x86_64-w64-mingw32", "13-win32"),
  ];
  return dirs.every((d) =>
      existsSync(join(d, "libgcc.a")) ||
      existsSync(join(d, "libmingw32.a"))
    )
    ? dirs
    : null;
})();

/** Can this machine rebuild the PE byte for byte? */
const targetLibDir = tryRun("rustc", [
  "--print",
  "target-libdir",
  "--target",
  TARGET,
]);
const canRebuild = !!rustcVersion?.startsWith(`${PINNED_RUSTC} `) &&
  mingwLibs !== null && targetLibDir !== null && existsSync(targetLibDir);

/** The value of `pub const <name>: &str = "…"` in a Rust source file of the stub. */
async function rustConst(file: string, name: string): Promise<string> {
  const src = await Deno.readTextFile(join(STUB_DIR, "src", file));
  const m = new RegExp(`pub const ${name}: &str = "([^"]+)"`).exec(src);
  assert(m, `${file} has no \`pub const ${name}: &str = "…"\``);
  return m[1]!;
}

/** `<crate>-<version>` of every dependency whose source path the PE records. */
function cratesIn(peText: string): string[] {
  const found = peText.matchAll(
    /\/cargo\/registry\/src\/[^/]+\/([A-Za-z0-9_-]+)-(\d+\.\d+\.\d+)\//g,
  );
  return [...new Set([...found].map((m) => `${m[1]} ${m[2]}`))].sort();
}

Deno.test("the committed stub PE is the pinned build", async () => {
  const pe = await Deno.readFile(prebuiltStubPath());
  assertEquals(pe[0], 0x4d); // 'M'
  assertEquals(pe[1], 0x5a); // 'Z'
  assertEquals(await sha256Hex(pe), SFX_STUB_SHA256);
  assertEquals(await ensureWindowsSfxStub(), prebuiltStubPath());
  // The README names the same build, so the rebuild recipe cannot drift.
  const readme = await Deno.readTextFile(join(STUB_DIR, "README.md"));
  assertStringIncludes(readme, SFX_STUB_SHA256);
  assertStringIncludes(readme, PINNED_RUSTC);
  for (const flag of LINK_FLAGS) assertStringIncludes(readme, flag);
  assertStringIncludes(readme, "--remap-path-prefix");
});

// The two tests at the end of this file need Rust, and are shown ignored where
// there is none. This one needs nothing: the sources are hashed in name order
// with their line endings normalised (a checkout may convert them), each as
// `<name> NUL <text> NUL`.
Deno.test("the stub sources are the ones the committed PE was built from", async () => {
  const names = [
    "Cargo.toml",
    "Cargo.lock",
    "shortcut-names.json",
    "version-order.json",
  ];
  for await (const e of Deno.readDir(join(STUB_DIR, "src"))) {
    if (e.isFile && e.name.endsWith(".rs")) names.push(`src/${e.name}`);
  }
  names.sort();
  assert(names.includes("src/main.rs"), `${names}`);
  // Nothing of the Go stub that this one replaced may come back beside it.
  const beside: string[] = [];
  for await (const e of Deno.readDir(STUB_DIR)) beside.push(e.name);
  assert(beside.includes("Cargo.toml"), `${beside}`);
  assertEquals(beside.filter((n) => /\.go$|^go\.(mod|sum)$/.test(n)), []);
  let text = "";
  for (const name of names) {
    const src = await Deno.readTextFile(join(STUB_DIR, name));
    text += `${name}\0${src.replaceAll("\r\n", "\n")}\0`;
  }
  assertEquals(
    await sha256Hex(new TextEncoder().encode(text)),
    SFX_STUB_SOURCE_SHA256,
    "the stub source changed since the committed PE was built: run " +
      "`cargo test`, rebuild the PE, then update SFX_STUB_SHA256 and " +
      "SFX_STUB_SOURCE_SHA256 (this is the new value) — see " +
      "windows-sfx-stub/README.md",
  );
  const readme = await Deno.readTextFile(join(STUB_DIR, "README.md"));
  assertStringIncludes(readme, SFX_STUB_SOURCE_SHA256);
});

Deno.test("a stub that is not the pinned build is refused before use", async () => {
  const tmp = await tempDir("windows-sfx-stub-");
  try {
    const dir = join(tmp, "build", "windows-sfx-stub", "prebuilt");
    await Deno.mkdir(dir, { recursive: true });
    const moduleUrl =
      toFileUrl(join(tmp, "build", "build-windows-exe.ts")).href;
    await assertRejects(
      () => ensureWindowsSfxStub(moduleUrl),
      Error,
      "cannot be read",
    );
    const pe = await Deno.readFile(prebuiltStubPath());
    pe[pe.length - 1]! ^= 1; // still "MZ", still the right size
    await Deno.writeFile(join(dir, "aio-windows-sfx-stub-amd64.exe"), pe);
    const e = await assertRejects(
      () => ensureWindowsSfxStub(moduleUrl),
      Error,
      "not the pinned build",
    );
    assertStringIncludes(e.message, await sha256Hex(pe));
  } finally {
    await dropTempDir(tmp);
  }
});

Deno.test("the stub PE carries nothing of the machine that built it", async () => {
  // latin1: one char per byte, so every ASCII string in the PE is searchable.
  const text = new TextDecoder("latin1").decode(
    await Deno.readFile(prebuiltStubPath()),
  );
  const repo = fromFileUrl(new URL("../", import.meta.url));
  const needles = [
    "/home/",
    "/tmp/",
    "/root/",
    "/Users/",
    "Users\\",
    "/var/folders/",
    "vcs.revision",
    "vcs.modified",
    repo.replace(/\/$/, ""),
    Deno.env.get("HOME") ?? "",
    Deno.env.get("USERPROFILE") ?? "",
    Deno.env.get("CARGO_HOME") ?? "",
    ".cargo/registry",
  ].filter((n) => n.length > 3);
  for (const n of needles) {
    const at = text.indexOf(n);
    assert(
      at < 0,
      `the stub PE contains ${JSON.stringify(n)}: …${
        text.slice(Math.max(0, at - 20), at + 60).replace(/[^\x20-\x7e]/g, "·")
      }… — rebuild it with the --remap-path-prefix flags (README.md)`,
    );
  }
  // Built the pinned way: the dependencies' paths are the remapped ones, and
  // the linker wrote no build time (the PE header's TimeDateStamp).
  assertStringIncludes(text, "/cargo/registry/src/");
  const pe = await Deno.readFile(prebuiltStubPath());
  const view = new DataView(pe.buffer, pe.byteOffset, pe.byteLength);
  assertEquals(view.getUint32(view.getUint32(0x3c, true) + 8, true), 0);
});

Deno.test("the stub source, the committed PE and the Deno packer share one format", async () => {
  const text = new TextDecoder("latin1").decode(
    await Deno.readFile(prebuiltStubPath()),
  );
  // The trailer magic.
  assertEquals(await rustConst("format.rs", "MAGIC"), SFX_MAGIC);
  assert(text.includes(SFX_MAGIC), `the PE was not built with ${SFX_MAGIC}`);
  // The stamp the stub writes and the updater carries across an update.
  assertEquals(await rustConst("install.rs", "STAMP_NAME"), SFX_STAMP_FILE);
  assert(text.includes(SFX_STAMP_FILE), "the PE writes a different stamp");
  // The version the stub writes and reads, and the app rewrites at each start.
  assertEquals(
    await rustConst("install.rs", "VERSION_NAME"),
    SFX_VERSION_FILE,
  );
  assert(text.includes(SFX_VERSION_FILE), "the PE writes a different file");
});

// The stub keeps an install that is NEWER than the payload it carries, so it
// orders versions — and the updater orders them too. One table, read by both
// (`cargo test` reads the same file): two comparators that disagreed would
// have an old `.exe` put its version over a newer install, or refuse to.
Deno.test("the stub and the updater order versions the same way", async () => {
  const table = JSON.parse(
    await Deno.readTextFile(join(STUB_DIR, "version-order.json")),
  ) as {
    ascending: string[];
    equal: [string, string][];
    unorderable: string[];
  };
  const { ascending, equal, unorderable } = table;
  assert(ascending.length > 20 && equal.length > 5 && unorderable.length > 5);
  const wrong: string[] = [];
  ascending.forEach((a, i) =>
    ascending.forEach((b, j) => {
      if (compareVersions(a, b) !== Math.sign(i - j)) wrong.push(`${a} ${b}`);
    })
  );
  assertEquals(wrong, [], "pairs the updater orders differently");
  assertEquals(equal.filter(([a, b]) => compareVersions(a, b) !== 0), []);
  assertEquals(unorderable.filter(isComparableVersion), []);
});

Deno.test("the stub's licenses ship beside it", async () => {
  const notices = await Deno.readTextFile(
    join(STUB_DIR, "THIRD_PARTY_NOTICES"),
  );
  // What the PE links: every dependency whose source path it records, and
  // every package of the lock file the notices name must be that version.
  const text = new TextDecoder("latin1").decode(
    await Deno.readFile(prebuiltStubPath()),
  );
  const linked = cratesIn(text);
  assert(linked.some((c) => c.startsWith("ruzstd ")), `${linked}`);
  assertEquals(
    linked.filter((crate) => !notices.includes(`. ${crate}\n`)),
    [],
    "linked crates THIRD_PARTY_NOTICES does not list",
  );
  const lock = await Deno.readTextFile(join(STUB_DIR, "Cargo.lock"));
  const locked = new Map(
    [...lock.matchAll(/name = "([^"]+)"\nversion = "([^"]+)"/g)]
      .map((m) => [m[1]!, m[2]!]),
  );
  const listed = [...notices.matchAll(/^ +\d+\. (\S+) (\d\S*)$/gm)]
    .map((m) => `${m[1]} ${m[2]}`);
  assert(listed.includes(linked[0]!), `${listed}`);
  assertEquals(
    listed.filter((crate) => {
      const [name, version] = crate.split(" ");
      return locked.get(name!) !== version;
    }),
    [],
    "THIRD_PARTY_NOTICES names a version Cargo.lock does not pin",
  );
  assertStringIncludes(notices, PINNED_RUSTC);
  assertStringIncludes(notices, "The Rust Project Contributors");
  assertStringIncludes(notices, "mingw-w64");
  assertStringIncludes(notices, "GCC RUNTIME LIBRARY EXCEPTION");
  // Published: nothing in deno.json's `publish.exclude` may drop the stub dir.
  const cfg = JSON.parse(
    await Deno.readTextFile(new URL("../deno.json", import.meta.url)),
  ) as { publish?: { exclude?: string[] } };
  const excludes = cfg.publish?.exclude ?? [];
  assert(excludes.length > 0, "deno.json has no publish.exclude to check");
  for (const pattern of excludes) {
    assert(
      !/sfx|\.exe|NOTICES|^src|\*\*\/\*$/i.test(pattern),
      `publish.exclude ${JSON.stringify(pattern)} may drop the SFX stub`,
    );
  }
});

Deno.test({
  name: "cargo test passes for the stub",
  ignore: rustcVersion === null, // no Rust toolchain on PATH: shown as ignored
  async fn() {
    const out = await new Deno.Command("cargo", {
      args: ["test", "--locked"],
      cwd: STUB_DIR,
      env: { CARGO_TARGET_DIR: TARGET_DIR },
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert(
      out.success,
      new TextDecoder().decode(out.stdout) +
        new TextDecoder().decode(out.stderr),
    );
  },
});

Deno.test({
  name:
    `the committed PE is what the committed source builds to (${PINNED_RUSTC})`,
  // Reproducible only with the pinned toolchain and link libraries: any other
  // machine shows it ignored.
  ignore: !canRebuild,
  async fn() {
    const cargoHome = Deno.env.get("CARGO_HOME") ||
      join(Deno.env.get("HOME") ?? "", ".cargo");
    const out = await new Deno.Command("cargo", {
      args: ["build", "--release", "--locked", "--target", TARGET],
      cwd: STUB_DIR,
      env: {
        CARGO_TARGET_DIR: TARGET_DIR,
        RUSTFLAGS: [
          ...LINK_FLAGS,
          ...mingwLibs!.map((d) => `-Lnative=${d}`),
          `--remap-path-prefix=${cargoHome}=/cargo`,
          `--remap-path-prefix=${STUB_DIR}=/stub`,
        ].join(" "),
      },
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert(out.success, new TextDecoder().decode(out.stderr));
    assertEquals(
      await sha256Hex(
        await Deno.readFile(
          join(TARGET_DIR, TARGET, "release", "aio-windows-sfx-stub.exe"),
        ),
      ),
      SFX_STUB_SHA256,
      "the stub source changed without a rebuild (or the reverse) — see " +
        "windows-sfx-stub/README.md",
    );
  },
});
