// Electron fuses (src/electron/electron-fuses.ts): the shipped runtime cannot
// be started around aio as plain Node, with NODE_OPTIONS code, or under a
// debugger. The ELECTRON_E2E case runs the REAL binary both ways: unfused it
// becomes Node and runs injected code; fused it does neither.
import { assert, assertEquals, assertThrows } from "@std/assert";
import { join } from "@std/path";
import {
  electronFuseBinary,
  FUSE_SENTINEL,
  fuseElectronFile,
  fuseOffset,
  fusesAreOff,
  turnFusesOff,
} from "../src/electron/electron-fuses.ts";
import { parseCacheName } from "../src/build/electron-cache.ts";
import { testDisplayEnv } from "../src/testing/test-display.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { permissiveUmask } from "./permissive-umask.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
/** Electron 44's wire as shipped: RunAsNode, NODE_OPTIONS, --inspect ON. */
const wire = (fuses = "101100011", version = 1) =>
  `HEAD${FUSE_SENTINEL}${
    String.fromCharCode(version, fuses.length)
  }${fuses}TAIL`;

Deno.test("fuses: RunAsNode, NODE_OPTIONS and --inspect go off; every other byte stays", () => {
  const b = enc(wire());
  assert(!fusesAreOff(b));
  turnFusesOff(b);
  assertEquals(dec(b), wire("000000011"));
  assert(fusesAreOff(b));
  turnFusesOff(b); // idempotent
  assertEquals(dec(b), wire("000000011"));
});

Deno.test("fuses: a wire that is missing, doubled, of another version or too short is refused", () => {
  assertThrows(
    () => fuseOffset(enc("no wire here")),
    Error,
    "no Electron fuse wire",
  );
  assertThrows(
    () => fuseOffset(enc(wire() + wire())),
    Error,
    "two Electron fuse wires",
  );
  assertThrows(() => fuseOffset(enc(wire("101100011", 2))), Error, "version 2");
  assertThrows(() => fuseOffset(enc(wire("101"))), Error, "3 Electron fuses");
});

Deno.test("fuses: the file is replaced, not written through — a hard-linked cache copy stays as it was", () =>
  permissiveUmask(async () => {
    const dir = await tempDir("fuses-file-");
    try {
      const cache = join(dir, "cache-electron");
      const staged = join(dir, "electron");
      await Deno.writeTextFile(cache, wire());
      await Deno.chmod(cache, 0o755);
      await Deno.link(cache, staged);
      // A strict umask must not cut the runtime's mode.
      const um = Deno.umask(0o077);
      try {
        await fuseElectronFile(staged);
      } finally {
        Deno.umask(um);
      }
      assertEquals(await Deno.readTextFile(staged), wire("000000011"));
      assertEquals((await Deno.stat(staged)).mode! & 0o777, 0o755);
      assertEquals(
        await Deno.readTextFile(cache),
        wire(),
        "the cache was written",
      );
    } finally {
      await dropTempDir(dir);
    }
  }));

Deno.test("fuses: the binary that carries the wire, per OS", () => {
  assertEquals(electronFuseBinary("d", "linux"), join("d", "electron"));
  assertEquals(electronFuseBinary("d", "windows"), join("d", "electron.exe"));
  // macOS: the framework, NOT Contents/MacOS/Electron (it has no wire).
  assert(
    electronFuseBinary("d", "darwin").endsWith(
      join("Versions", "A", "Electron Framework"),
    ),
  );
});

Deno.test("fuses: am prune knows a -fused runtime as the same Electron", () => {
  assertEquals(parseCacheName("44.4.1-win32-x64-fused"), {
    version: "44.4.1",
    slug: "win32-x64",
  });
});

const DIST = "node_modules/.deno/electron@44.4.1/node_modules/electron/dist";

function realSkip(): string | null {
  if (!Deno.env.get("ELECTRON_E2E")) return "set ELECTRON_E2E=1 to run";
  if (Deno.build.os !== "linux") return "linux runtime layout";
  try {
    Deno.statSync(join(DIST, "electron"));
  } catch {
    return `no ${DIST}`;
  }
  return null;
}

Deno.test({
  name:
    "fuses e2e: the real Electron, unfused, runs as Node and loads NODE_OPTIONS code; fused, it does neither",
  ignore: realSkip() !== null,
  async fn() {
    const dir = await tempDir("fuses-e2e-");
    try {
      const src = await Deno.realPath(DIST);
      const req = join(dir, "inject.js");
      await Deno.writeTextFile(
        req,
        `require("fs").writeFileSync(process.env.MARK, "x")`,
      );
      const probe = async (fused: boolean) => {
        // A runtime dir of symlinks with its OWN copy of the binary.
        const d = join(dir, fused ? "fused" : "plain");
        await Deno.mkdir(d);
        for await (const e of Deno.readDir(src)) {
          if (e.name === "electron") {
            await Deno.copyFile(join(src, e.name), join(d, e.name));
          } else await Deno.symlink(join(src, e.name), join(d, e.name));
        }
        await Deno.chmod(join(d, "electron"), 0o755);
        if (fused) await fuseElectronFile(join(d, "electron"));
        const mark = join(dir, `${fused}.marker`);
        const run = async (env: Record<string, string>) => {
          const o = await new Deno.Command(join(d, "electron"), {
            args: ["--version"],
            env: { ...testDisplayEnv(), ...env },
            stdout: "piped",
            stderr: "null",
            signal: AbortSignal.timeout(20_000),
          }).output();
          return dec(o.stdout).trim();
        };
        const asNode = await run({ ELECTRON_RUN_AS_NODE: "1" });
        await run({ NODE_OPTIONS: `--require=${req}`, MARK: mark });
        const injected = await Deno.stat(mark).then(() => true, () => false);
        return { asNode, injected };
      };
      const plain = await probe(false);
      // Control: the instrument sees both doors open on the stock binary.
      assert(plain.asNode.startsWith("v24."), `not Node: ${plain.asNode}`);
      assert(plain.injected, "NODE_OPTIONS code did not run unfused");
      const fused = await probe(true);
      assert(fused.asNode.startsWith("v44."), `ran as Node: ${fused.asNode}`);
      assert(!fused.injected, "NODE_OPTIONS code ran in the fused binary");
    } finally {
      await dropTempDir(dir);
    }
  },
});

Deno.test("fuses: every desktop package fuses the runtime it copies, before packaging", async () => {
  // One place: buildElectron. Linux, the Windows zip and the macOS .app (built
  // from this staged copy) all pass through it; the self-contained exe fuses
  // at unpack (electron-embedded-runtime.test.ts).
  const src = await Deno.readTextFile(
    new URL("../src/build/build-electron.ts", import.meta.url),
  );
  const copy = src.indexOf("await copyDir(electronSrc, electronDst);");
  const fuse = src.indexOf(
    "await fuseElectronFile(electronFuseBinary(electronDst, os));",
  );
  const pack = src.indexOf("await foreignBinaries(appDir, os);");
  assert(
    copy > 0 && fuse > copy && pack > fuse,
    "fuse after copy, before packaging",
  );
});
