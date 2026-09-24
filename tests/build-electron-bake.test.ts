// `dist/electron.json` is baked only into a binary that could launch Electron.
// A headless (server-kind) binary shipped it too.
import { assertEquals } from "@std/assert";
import { bakesElectronVersion } from "../src/build/electron-bake.ts";

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
