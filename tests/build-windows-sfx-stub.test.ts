// The committed Windows SFX stub PE is copied into every user's one-click
// `.exe`, so it is pinned: its bytes are the build of the committed source
// (SHA-256 checked before every use), it carries nothing of the machine that
// built it, and the format constants the Go stub and the Deno packer share
// are compared here — changing one side alone used to leave every test green.
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { fromFileUrl, join, toFileUrl } from "@std/path";
import {
  ensureWindowsSfxStub,
  prebuiltStubPath,
  SFX_MAGIC,
  SFX_STUB_SHA256,
  SFX_STUB_SOURCE_SHA256,
  windowsSfxStubDir,
} from "../src/build/build-windows-exe.ts";
import { SFX_STAMP_FILE } from "../src/server/updates-apply.ts";
import { sha256Hex } from "../src/build/ship.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

/** The Go release the committed PE was built with (README.md pins the same). */
const PINNED_GO = "go1.27.1";
const BUILD_ARGS = [
  "build",
  "-trimpath",
  "-buildvcs=false",
  "-ldflags=-s -w -H windowsgui",
];
const BUILD_ENV = { GOOS: "windows", GOARCH: "amd64", CGO_ENABLED: "0" };

const STUB_DIR = windowsSfxStubDir();

/** `go version` of the toolchain on PATH, or null without one. */
const goVersion = (() => {
  try {
    const out = new Deno.Command("go", { args: ["version"], stderr: "null" })
      .outputSync();
    return out.success ? new TextDecoder().decode(out.stdout).trim() : null;
  } catch {
    return null; // aio-ok: no Go on PATH — the two Go tests say so (ignored)
  }
})();

/** The value of `const <name> = "…"` in a Go source file of the stub. */
async function goConst(file: string, name: string): Promise<string> {
  const src = await Deno.readTextFile(join(STUB_DIR, file));
  const m = new RegExp(`const ${name} = "([^"]+)"`).exec(src);
  assert(m, `${file} has no \`const ${name} = "…"\``);
  return m[1]!;
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
  assertStringIncludes(readme, PINNED_GO);
  assertStringIncludes(readme, BUILD_ARGS.slice(1, 3).join(" "));
});

// The two tests at the end of this file need Go, and are shown ignored where
// there is none — which is every gate. This one needs nothing: the sources are
// hashed in name order with their line endings normalised (a checkout may
// convert them), each as `<name> NUL <text> NUL`.
Deno.test("the stub sources are the ones the committed PE was built from", async () => {
  const names: string[] = [];
  for await (const e of Deno.readDir(STUB_DIR)) {
    if (e.isFile && /\.go$|^go\.(mod|sum)$/.test(e.name)) names.push(e.name);
  }
  names.sort();
  assert(names.includes("main.go") && names.includes("go.sum"), `${names}`);
  let text = "";
  for (const name of names) {
    const src = await Deno.readTextFile(join(STUB_DIR, name));
    text += `${name}\0${src.replaceAll("\r\n", "\n")}\0`;
  }
  assertEquals(
    await sha256Hex(new TextEncoder().encode(text)),
    SFX_STUB_SOURCE_SHA256,
    "the stub source changed since the committed PE was built: run " +
      "`go test ./...`, rebuild the PE, then update SFX_STUB_SHA256 and " +
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
    Deno.env.get("GOPATH") ?? "",
  ].filter((n) => n.length > 3);
  for (const n of needles) {
    const at = text.indexOf(n);
    assert(
      at < 0,
      `the stub PE contains ${JSON.stringify(n)}: …${
        text.slice(Math.max(0, at - 20), at + 60).replace(/[^\x20-\x7e]/g, "·")
      }… — rebuild it with -trimpath -buildvcs=false (README.md)`,
    );
  }
  // Built the pinned way: Go records its own flags in the binary.
  assertStringIncludes(text, "-trimpath=true");
  assertStringIncludes(text, PINNED_GO);
});

Deno.test("the stub source, the committed PE and the Deno packer share one format", async () => {
  const text = new TextDecoder("latin1").decode(
    await Deno.readFile(prebuiltStubPath()),
  );
  // The trailer magic.
  assertEquals(await goConst("format.go", "magic"), SFX_MAGIC);
  assert(text.includes(SFX_MAGIC), `the PE was not built with ${SFX_MAGIC}`);
  // The stamp the stub writes and the updater carries across an update.
  assertEquals(await goConst("install.go", "stampName"), SFX_STAMP_FILE);
  assert(text.includes(SFX_STAMP_FILE), "the PE writes a different stamp");
});

Deno.test("the stub's licenses ship beside it", async () => {
  const notices = await Deno.readTextFile(
    join(STUB_DIR, "THIRD_PARTY_NOTICES"),
  );
  // What the PE links, by the versions Go recorded in it.
  const text = new TextDecoder("latin1").decode(
    await Deno.readFile(prebuiltStubPath()),
  );
  const dep = /dep\tgithub\.com\/klauspost\/compress\t(v[\d.]+)/.exec(text);
  assert(dep, "the PE records no klauspost/compress dependency");
  assertStringIncludes(notices, `github.com/klauspost/compress ${dep[1]}`);
  assertStringIncludes(notices, PINNED_GO);
  assertStringIncludes(notices, "Copyright 2009 The Go Authors");
  assertStringIncludes(notices, "Klaus Post");
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
  name: "go test ./... passes for the stub",
  ignore: goVersion === null, // no Go toolchain on PATH: shown as ignored
  async fn() {
    const out = await new Deno.Command("go", {
      args: ["test", "./..."],
      cwd: STUB_DIR,
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
    `the committed PE is what the committed source builds to (${PINNED_GO})`,
  // Reproducible only with the pinned toolchain: any other is shown ignored.
  ignore: !goVersion?.includes(` ${PINNED_GO} `),
  async fn() {
    const tmp = await tempDir("windows-sfx-stub-");
    try {
      const exe = join(tmp, "stub.exe");
      const out = await new Deno.Command("go", {
        args: [...BUILD_ARGS, "-o", exe, "."],
        cwd: STUB_DIR,
        env: BUILD_ENV,
        stdout: "piped",
        stderr: "piped",
      }).output();
      assert(out.success, new TextDecoder().decode(out.stderr));
      assertEquals(
        await sha256Hex(await Deno.readFile(exe)),
        SFX_STUB_SHA256,
        "the stub source changed without a rebuild (or the reverse) — see " +
          "windows-sfx-stub/README.md",
      );
    } finally {
      await dropTempDir(tmp);
    }
  },
});
