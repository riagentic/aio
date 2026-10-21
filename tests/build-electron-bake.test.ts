// `dist/electron.json` is baked only into a binary that could launch Electron.
// A headless (server-kind) binary shipped it too.
import { assertEquals } from "@std/assert";
import {
  bakesElectronVersion,
  electronRecord,
} from "../src/build/electron-bake.ts";
import { bakedClientArgs } from "../src/build/build-compile.ts";

const base = {
  doCompile: true,
  doCli: false,
  doClient: false,
  doAndroid: false,
  doIos: false,
};

Deno.test("electron bake: a headless (server-kind) binary carries no electron.json", () => {
  assertEquals(bakesElectronVersion({ ...base, doHeadless: true }), false);
});

Deno.test("electron bake: a plain compiled binary still does (it may run --client=electron)", () => {
  assertEquals(bakesElectronVersion(base), true);
  assertEquals(bakesElectronVersion({ ...base, doCompile: false }), false);
  assertEquals(bakesElectronVersion({ ...base, doCli: true }), false);
});

Deno.test("electron record: an online binary that boots in a browser says so; a desktop package and an offline build stay as they were", () => {
  const sha256 = { "linux-x64": "a".repeat(64) };
  const clientOf = (doElectron: boolean, doRemote = false) =>
    bakedClientArgs({
      doElectron,
      doHeadless: false,
      doCli: false,
      doRemote,
    })[0]?.slice("--client=".length);
  assertEquals(
    electronRecord({ version: "44.7.0", sha256, client: clientOf(false) }),
    { version: "44.7.0", runtime: "shared", sha256, client: "browser" },
  );
  assertEquals(
    electronRecord({
      version: "44.7.0",
      sha256,
      client: clientOf(false, true),
    }),
    { version: "44.7.0", runtime: "shared", sha256, client: "server-only" },
  );
  assertEquals(
    electronRecord({ version: "44.7.0", sha256, client: clientOf(true) }),
    { version: "44.7.0", runtime: "shared", sha256 },
    "the desktop package's record is byte-for-byte what it was",
  );
  assertEquals(
    electronRecord({ version: "44.7.0", client: "browser" }),
    { version: "44.7.0" },
    "offline: an update fetches nothing anyway — the record is unchanged",
  );
  assertEquals(
    electronRecord({ version: "1", splash: { bg: "#000" } }),
    { version: "1", splash: { bg: "#000" } },
  );
});
